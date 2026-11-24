import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { defineConfig } from "tsdown";

interface ClientChunk {
  readonly type: "chunk";
  readonly fileName: string;
  readonly moduleIds: readonly string[];
}

interface ClientAsset {
  readonly type: "asset";
  readonly fileName: string;
  readonly source: string | Uint8Array;
}

interface ClientStylesheetPlugin {
  readonly name: string;
  writeBundle(options: unknown, bundle: Record<string, ClientChunk | ClientAsset>): Promise<void>;
}

const STYLE_TOKEN = "___DSH_STYLES___";
const INJECT_TOKEN = "/*__dsh_style_inject__*/";
const pluginId = packageName(import.meta.dirname);

/**
 * Install one CSS Module for both dsh hosts this package can boot.
 *
 * Published `@deepseek-ai/dsh@0.2.2-rc.5` drops `meta` and keeps only
 * `<style data-plugin>` tags created while the factory runs.
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/modules/src/client/system.ts
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/tsdown.client.ts
 *
 * `0.2.3-alpha` DocumentStyles reads `meta().stylesheets` and inserts
 * `<style data-plugin>` after the module materializes.
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/client/ui-renderer/src/client/styles/document-styles.ts
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/util/package-manifest/src/client-module.ts
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/client/tsdown.client.ts
 */
export interface ClientStyleInstall {
  readonly injection: string;
  readonly stylesheets: string;
}

export function clientStyleInstall(
  ownerId: string,
  stylesheetPath: string,
  css: string,
): ClientStyleInstall {
  const fileName = stylesheetPath.slice(stylesheetPath.lastIndexOf("/") + 1);
  const tagId = `${ownerId}/${fileName}`;
  const cssLiteral = JSON.stringify(css);
  const quotedTagId = JSON.stringify(JSON.stringify(tagId));
  const injection = [
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + " +
      quotedTagId +
      " + ']') === null) {",
    "  const style = document.createElement('style');",
    `  style.dataset.plugin = ${JSON.stringify(ownerId)};`,
    `  style.dataset.pluginCss = ${JSON.stringify(tagId)};`,
    `  style.textContent = ${cssLiteral};`,
    "  document.head.appendChild(style);",
    "}",
  ].join("\n");
  const stylesheets = `{ ${JSON.stringify(stylesheetPath)}: { text: (context) => ${cssLiteral} } }`;
  return { injection, stylesheets };
}

function packageName(packageDir: string): string {
  const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
    name?: string;
  };
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error("tsdown: package.json is missing name");
  }
  return manifest.name;
}

/**
 * Browser client bundle.
 *
 * tsdown compiles the CSS Module into a class map. The host still has to
 * receive the compiled text: `clientStyleInstall` emits the factory-time
 * `<style data-plugin>` tag `0.2.2-rc.5` claims, and the `meta().stylesheets`
 * record `0.2.3-alpha` DocumentStyles installs.
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/tsdown.client.ts
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/client/tsdown.client.ts
 */
export default defineConfig({
  entry: { client: "src/client/index.tsx" },
  format: "cjs",
  platform: "browser",
  target: "es2024",
  hash: false,
  dts: true,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [/^react$/, /^react-dom$/, /^react\/jsx-runtime$/],
  },
  inputOptions: { platform: "browser" },
  outExtensions: () => ({ js: ".js" }),
  outputOptions: (options, _format, context) => {
    if (context.cjsDts) return;
    return {
      ...options,
      entryFileNames: "client.js",
      intro: `var module = { exports: {} }; var exports = module.exports;\n${INJECT_TOKEN}`,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: `return module.exports; }, meta: () => ({ stylesheets: "${STYLE_TOKEN}" }) });`,
    };
  },
  plugins: [clientStylesheetPlugin(import.meta.dirname)],
});

function clientStylesheetPlugin(packageDir: string): ClientStylesheetPlugin {
  return {
    name: "dsh-client-stylesheets",
    async writeBundle(_options, bundle) {
      const chunk = Object.values(bundle).find(
        (item): item is ClientChunk => item.type === "chunk" && item.fileName === "client.js",
      );
      const asset = Object.values(bundle).find(
        (item): item is ClientAsset => item.type === "asset" && item.fileName.endsWith(".css"),
      );
      if (chunk === undefined || asset === undefined) {
        throw new Error("tsdown: client bundle did not emit client.js and its stylesheet");
      }
      const stylePath = stylesheetPath(packageDir, chunk.moduleIds);
      const css =
        typeof asset.source === "string"
          ? asset.source
          : Buffer.from(asset.source).toString("utf8");
      const installed = clientStyleInstall(pluginId, stylePath, css);
      const jsPath = resolve(packageDir, "dist/client.js");
      const js = await readFile(jsPath, "utf8");
      const placeholder = new RegExp(`["']${STYLE_TOKEN}["']`);
      if (!placeholder.test(js) || !js.includes(INJECT_TOKEN)) {
        throw new Error("tsdown: client bundle is missing its stylesheet placeholder");
      }
      await writeFile(
        jsPath,
        js.replace(INJECT_TOKEN, installed.injection).replace(placeholder, installed.stylesheets),
      );
      await rm(resolve(packageDir, "dist", asset.fileName));
    },
  };
}

function stylesheetPath(packageDir: string, moduleIds: readonly string[]): string {
  const styles = moduleIds.filter((id) => id.endsWith(".module.css"));
  const style = styles[0];
  if (style === undefined || styles.length !== 1) {
    throw new Error(`tsdown: expected one CSS Module, found ${String(styles.length)}`);
  }
  return relative(packageDir, style).split(sep).join("/");
}
