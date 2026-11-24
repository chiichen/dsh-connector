/**
 * Install this package into a fresh dsh profile and boot it.
 *
 * Official install: `dsh plugin --profile <name> add <path>` links the checkout
 * and keeps its node_modules, then `dsh --profile <name>` boots that profile.
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md
 *
 * Cordis collects `apply`'s return value as an effect. A runtime object fails
 * startup with `TypeError: Invalid effect`.
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/fiber.ts
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_NAME = "connector-boot";
const SHIPPED_TEMPLATE = "web";
const COMMAND_TIMEOUT_MS = 180_000;
/**
 * Printed only after `auditStartupEntries` resolves. A failed startup stays unpublished.
 * The label is `dsh web` and the value is the listener URL.
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/src/index.ts
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/authentication-token/src/index.ts
 */
const STARTUP_LOG_PREFIXES = ["dsh web: http://", "dsh web: https://"];

const pluginPackage = JSON.parse(await readFile(resolve(PACKAGE_DIR, "package.json"), "utf8"));
const enginesDsh = pluginPackage.engines.dsh;
const enginesNode = pluginPackage.engines.node;
const harnessVersion = pluginPackage.devDependencies["@deepseek-ai/dsh-agent"];

const root = await mkdtemp(resolve(tmpdir(), "dsh-connector-boot-"));
const cliDir = resolve(root, "cli");
const homeDir = resolve(root, "home");

try {
  await assertBuilt();
  const { dshBin, semver } = await installCli();
  assertEngine(semver, process.versions.node, enginesNode, "node");
  assertEngine(semver, harnessVersion, enginesDsh, "dsh");
  const env = commandEnv(homeDir);
  const version = await runChecked(dshBin, ["--version"], { env, cwd: cliDir });
  const installed = version.stdout.trim();
  if (installed !== harnessVersion) {
    throw new Error(`installed dsh ${installed}, expected ${harnessVersion}`);
  }
  await runChecked(
    dshBin,
    ["--profile", PROFILE_NAME, "--from-default-profile", SHIPPED_TEMPLATE, "--dump-config"],
    { env, cwd: cliDir },
  );
  await runChecked(dshBin, ["plugin", "--profile", PROFILE_NAME, "add", PACKAGE_DIR], {
    env,
    cwd: cliDir,
  });
  const booted = await runUntilStartupLog(dshBin, ["--profile", PROFILE_NAME, "--no-open"], {
    env,
    cwd: cliDir,
  });
  process.stdout.write(`${startupLogLine(booted)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function assertBuilt() {
  const entry = resolve(PACKAGE_DIR, "dist", "index.js");
  try {
    await readFile(entry);
  } catch {
    throw new Error(`missing ${entry}; build the plugin before this test`);
  }
}

async function installCli() {
  await runChecked(
    "npm",
    ["install", "--prefix", cliDir, `--save-exact`, `@deepseek-ai/dsh@${harnessVersion}`, "semver"],
    { env: commandEnv(homeDir), cwd: PACKAGE_DIR },
  );
  const require = createRequire(resolve(cliDir, "package.json"));
  return {
    dshBin: resolve(cliDir, "node_modules", ".bin", "dsh"),
    semver: require("semver"),
  };
}

function assertEngine(semver, version, range, label) {
  if (!semver.satisfies(version, range, { includePrerelease: true })) {
    throw new Error(`${label} ${version} does not satisfy engines.${label} ${range}`);
  }
}

function commandEnv(dshHome) {
  const env = {
    ...process.env,
    CI: "true",
    DSH_HOME: dshHome,
    npm_config_update_notifier: "false",
  };
  delete env.DEEPSEEK_API_KEY;
  return env;
}

function startupLogLine(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  return output
    .split("\n")
    .find((line) => STARTUP_LOG_PREFIXES.some((prefix) => line.startsWith(prefix)));
}

function runUntilStartupLog(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    const finishReady = () => {
      if (ready) return;
      ready = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);
    const take = (chunk, intoStdout) => {
      if (intoStdout) stdout += chunk;
      else stderr += chunk;
      if (startupLogLine({ stdout, stderr }) !== undefined) finishReady();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      take(chunk, true);
    });
    child.stderr.on("data", (chunk) => {
      take(chunk, false);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const result = { stdout, stderr };
      if (startupLogLine(result) !== undefined) {
        resolvePromise(result);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited without the dsh web startup URL\n${stdout}\n${stderr}`,
        ),
      );
    });
  });
}

function runChecked(command, args, options) {
  return run(command, args, options).then((result) => {
    if (result.code !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} exited ${String(result.code)}\n${result.stdout}\n${result.stderr}`,
      );
    }
    return result;
  });
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGTERM") {
        reject(
          new Error(
            `${command} ${args.join(" ")} timed out after ${String(COMMAND_TIMEOUT_MS)}ms\n${stdout}\n${stderr}`,
          ),
        );
        return;
      }
      resolvePromise({ code, stdout, stderr });
    });
  });
}
