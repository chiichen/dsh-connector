// @vitest-environment happy-dom
/**
 * Boots the built client through the published host module system, and starts
 * the server plugin through Cordis.
 *
 * `@deepseek-ai/dsh-client-test-runtime` `TestClient` imports each row's
 * `/client` namespace and never executes the built bundle, so it cannot see
 * `meta().stylesheets` or the factory `<style>` tag.
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/test-support/client-runtime/src/assembly/modules.ts
 *
 * `@deepseek-ai/dsh-loader-smoke` `runLoaderSmoke` still spawns a bin. The
 * in-process profile helper is repository-only and is not published.
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/test-support/loader-smoke/src/index.ts
 *
 * Published dsh 0.2.2-rc.5 installs styles by running the bundle factory and
 * claiming `<style>` tags. `register` does not keep `meta`.
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/modules/src/client/system.ts
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { apply, Config, inject, name } from "../src";
import { CONNECTOR_PLUGIN_NAME } from "../src/constants";
import { TestDshHost } from "./mocks/mock-dsh-host";

const MODULES_PACKAGE = "@deepseek-ai/dsh-client-modules";
const MODULES_ENTRY = `${MODULES_PACKAGE}/src/client/index.ts`;
const BOOT_REVISION = "local";
const STYLESHEET_PATH = "src/client/panel.module.css";
const CLIENT_BUNDLE = resolve(import.meta.dirname, "../dist/client.js");

interface ClientModuleCreateOptions {
  readonly boot: unknown;
  readonly staticModules: Readonly<Record<string, object>>;
  readonly loadBundle?: (url: string) => Promise<void>;
}

interface ClientModuleSystem {
  import(specifier: string): Promise<unknown>;
  readonly loadCache: ReadonlyMap<string, { readonly styles: readonly string[] }>;
}

interface ClientModuleLoaderTarget {
  mode: "queue" | "live";
  pendingQueue: unknown[];
  load(registration: BundleRegistration): void;
  create(options: ClientModuleCreateOptions): ClientModuleSystem;
}

interface ClientModulesNamespace {
  createClientModuleSystem(
    target: ClientModuleLoaderTarget,
    bootstrap: { readonly id: string; readonly exports: object },
    options: ClientModuleCreateOptions,
  ): ClientModuleSystem;
}

interface StylesheetDescriptor {
  text(context: { asset(reference: string): string }): string;
}

interface BundleRegistration {
  readonly id: string;
  readonly meta?: () => {
    readonly stylesheets?: Readonly<Record<string, StylesheetDescriptor>>;
  };
}

interface ModuleLoaderWindow extends Window {
  __ModuleLoader__?: ClientModuleLoaderTarget;
}

const nodeRequire = createRequire(import.meta.url);

function clientModules(value: unknown): ClientModulesNamespace | undefined {
  if (typeof value !== "object" || value === null || !("createClientModuleSystem" in value)) {
    return undefined;
  }
  return typeof value.createClientModuleSystem === "function"
    ? (value as ClientModulesNamespace)
    : undefined;
}

async function importSpecifier(specifier: string): Promise<unknown> {
  return await import(specifier);
}

async function loadClientModules(): Promise<ClientModulesNamespace> {
  const modules = clientModules(await importSpecifier(MODULES_ENTRY));
  if (modules === undefined) {
    throw new Error(`${MODULES_ENTRY} is missing createClientModuleSystem`);
  }
  return modules;
}

function pluginExports(
  value: unknown,
): { readonly name: string; readonly apply: unknown } | undefined {
  if (typeof value !== "object" || value === null || !("name" in value) || !("apply" in value)) {
    return undefined;
  }
  const record = value as { readonly name: unknown; readonly apply: unknown };
  return typeof record.name === "string" ? { name: record.name, apply: record.apply } : undefined;
}

describe("published dsh host", () => {
  it("installs the settings sheet while the client factory runs", async () => {
    const source = await readFile(CLIENT_BUNDLE, "utf8");
    const modules = await loadClientModules();
    const seen: BundleRegistration[] = [];
    const page = window as ModuleLoaderWindow;
    const target: ClientModuleLoaderTarget = {
      mode: "queue",
      pendingQueue: [],
      load: () => {
        throw new Error("client module loader is not live");
      },
      create: (options) =>
        modules.createClientModuleSystem(target, { id: MODULES_PACKAGE, exports: {} }, options),
    };
    page.__ModuleLoader__ = target;
    const system = target.create({
      boot: {
        rev: BOOT_REVISION,
        entries: [
          {
            id: CONNECTOR_PLUGIN_NAME,
            url: `/plugins/${CONNECTOR_PLUGIN_NAME}/client.js?rev=${BOOT_REVISION}`,
            rev: BOOT_REVISION,
          },
        ],
        batches: [
          {
            phase: "application",
            url: `/plugins/application.js?rev=${BOOT_REVISION}`,
            rev: BOOT_REVISION,
            entries: [CONNECTOR_PLUGIN_NAME],
          },
        ],
      },
      staticModules: {
        react: nodeRequire("react") as object,
        "react/jsx-runtime": nodeRequire("react/jsx-runtime") as object,
      },
      loadBundle: () => {
        runInContext(source, createContext({ window: page, document }));
        return Promise.resolve();
      },
    });
    const register = target.load.bind(target);
    target.load = (registration) => {
      seen.push(registration);
      register(registration);
    };

    const exported = pluginExports(await system.import(CONNECTOR_PLUGIN_NAME));
    expect(exported?.name).toBe(name);
    expect(typeof exported?.apply).toBe("function");

    expect(seen).toHaveLength(1);
    const stylesheets = seen[0]?.meta?.().stylesheets;
    const sheet = stylesheets?.[STYLESHEET_PATH];
    expect(sheet).toBeDefined();
    const css = sheet?.text({ asset: (reference) => reference }) ?? "";
    expect(css).toContain("display: flex");
    expect(css).toContain("flex-direction: column");

    const tags = [
      ...document.querySelectorAll(`style[data-plugin=${JSON.stringify(CONNECTOR_PLUGIN_NAME)}]`),
    ];
    expect(tags).toHaveLength(1);
    expect(tags[0]?.textContent).toBe(css);
    expect(tags[0]?.getAttribute("data-plugin-css")).toBe(
      `${CONNECTOR_PLUGIN_NAME}/panel.module.css`,
    );
    expect(system.loadCache.get(CONNECTOR_PLUGIN_NAME)?.styles).toEqual([
      `${CONNECTOR_PLUGIN_NAME}/panel.module.css`,
    ]);

    await system.import(CONNECTOR_PLUGIN_NAME);
    expect(
      document.querySelectorAll(`style[data-plugin=${JSON.stringify(CONNECTOR_PLUGIN_NAME)}]`)
        .length,
    ).toBe(1);
  });

  it("activates the server plugin through Cordis", async () => {
    const host = await TestDshHost.start({ withWebServer: false });
    try {
      await host.ctx.plugin({ name, inject, Config, apply });
    } finally {
      await host.stop();
    }
  });
});
