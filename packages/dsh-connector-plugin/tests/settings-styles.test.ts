import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { settingsStyles } from "../src/client/settings.generated";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("connector settings styles", () => {
  it("compiles the panel's Tailwind classes into the injected stylesheet", () => {
    execFileSync(process.execPath, ["scripts/compile-settings-styles.mjs", "--check"], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    expect(settingsStyles).toContain(".grid{display:grid}");
    expect(settingsStyles).toContain("minmax(10rem,14rem)");
    expect(settingsStyles).toContain("font:inherit");
    expect(settingsStyles).toContain(".dsh-connector-settings{");
    expect(settingsStyles).not.toContain("@layer");
    expect(settingsStyles).not.toContain(":root");
  });
});
