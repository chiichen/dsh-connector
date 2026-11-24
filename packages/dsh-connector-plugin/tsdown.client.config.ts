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

const PLUGIN_ID = "dsh-connector-plugin";
const STYLE_TOKEN = "___DSH_STYLES___";

/**
 * Browser client bundle.
 *
 * A component imports its CSS Module directly, as
 * `packages/client/ui-settings-general/src/client/GeneralSection.tsx` does.
 * The renderer installs styles from the ModuleLoader `meta.stylesheets`
 * registration emitted by `clientBundle` in
 * `packages/client/tsdown.client.ts`. That helper is not a published package,
 * so this config only copies its banner, footer, and `meta.stylesheets` shape
 * around the CSS tsdown already compiled.
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
      intro: "var module = { exports: {} }; var exports = module.exports;",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
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
      const jsPath = resolve(packageDir, "dist/client.js");
      const js = await readFile(jsPath, "utf8");
      const placeholder = new RegExp(`["']${STYLE_TOKEN}["']`);
      if (!placeholder.test(js)) {
        throw new Error("tsdown: client bundle is missing its stylesheet placeholder");
      }
      const descriptor = `{ ${JSON.stringify(stylePath)}: { text: (context) => ${JSON.stringify(css)} } }`;
      await writeFile(jsPath, js.replace(placeholder, descriptor));
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
