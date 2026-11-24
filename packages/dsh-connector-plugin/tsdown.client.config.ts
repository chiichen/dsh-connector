import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { transform, type TransformResult } from "lightningcss";
import { defineConfig } from "tsdown";

const CSS_VIRTUAL_PREFIX = "\0dsh-css:";
const CSS_VIRTUAL_SUFFIX = ".mjs";
const PLUGIN_ID = "dsh-connector-plugin";

interface CompiledStylesheet {
  readonly path: string;
  readonly css: string;
}

/**
 * Compile one CSS Module the same way DSH's client preset does: lightningcss
 * hashes local class names and the bundle publishes the compiled text.
 */
export function compileModuleStylesheet(
  fileId: string,
  source: Uint8Array,
): { readonly classMap: Record<string, string>; readonly css: string } {
  const compiled: TransformResult = transform({
    filename: fileId,
    code: source,
    cssModules: { pattern: "[hash]_[local]" },
    minify: true,
  });
  const classMap: Record<string, string> = {};
  const exported = compiled.exports ?? {};
  for (const local of Object.keys(exported).sort()) {
    const entry = exported[local];
    if (entry !== undefined) classMap[local] = entry.name;
  }
  return { classMap, css: compiled.code.toString() };
}

const NAMED_IMPORT = /^import\s*\{([^}]+)\}\s*from\s*(["'][^"']+["']);?$/;
const NAMED_EXPORT = /^export\s*\{([^}]+)\};?$/;

/**
 * Turn the ESM client chunk into the factory DSH evaluates.
 * React stays a `require` of the host module table; stylesheet metadata sits
 * beside the factory so the renderer can install it before paint.
 */
export function wrapClientModule(code: string, meta: string): string {
  const requires: string[] = [];
  const bodyLines: string[] = [];
  let exported = "";
  for (const line of code.split("\n")) {
    const imported = NAMED_IMPORT.exec(line);
    if (imported !== null) {
      requires.push(`const {${imported[1]}} = require(${imported[2]});`);
      continue;
    }
    const exportLine = NAMED_EXPORT.exec(line);
    const exportNames = exportLine?.[1];
    if (exportNames !== undefined) {
      if (exported !== "") throw new Error("tsdown: client bundle has more than one export list");
      exported = exportNames;
      continue;
    }
    bodyLines.push(line);
  }
  if (exported === "") throw new Error("tsdown: client bundle is missing its export list");
  const assignments = exported.split(",").map((part) => {
    const [local, alias] = part.trim().split(/\s+as\s+/);
    const binding = local?.trim() ?? "";
    const name = (alias ?? local)?.trim() ?? "";
    if (binding === "" || name === "") throw new Error("tsdown: client bundle has an empty export");
    return `exports.${name} = ${binding};`;
  });
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n${requires.join("\n")}\n${bodyLines.join("\n")}\n${assignments.join("\n")}\nreturn module.exports; }${meta} });\n`;
}

/** `meta` argument fragment consumed by `DocumentStyles` in dsh-client-ui-renderer. */
export function stylesheetMetaArgument(styles: readonly CompiledStylesheet[]): string {
  if (styles.length === 0) return "";
  const entries = styles.map(
    (style) => `${JSON.stringify(style.path)}: { text: (context) => ${JSON.stringify(style.css)} }`,
  );
  return `, meta: () => ({ stylesheets: {${entries.join(",")}} })`;
}

function clientStylePlugin(packageDir: string): {
  readonly name: string;
  buildStart(): void;
  resolveId(source: string, importer: string | undefined): string | null;
  load(
    this: { addWatchFile(id: string): void },
    virtualId: string,
  ): Promise<{ readonly code: string; readonly moduleSideEffects: "no-treeshake" } | null>;
  renderChunk(code: string, chunk: { readonly fileName: string }): string | null;
} {
  const styles = new Map<string, CompiledStylesheet>();
  return {
    name: "dsh-connector-client-style",
    buildStart() {
      styles.clear();
    },
    resolveId(source: string, importer: string | undefined): string | null {
      if (!source.endsWith(".module.css")) return null;
      const from = importer === undefined ? packageDir : dirname(importer);
      return CSS_VIRTUAL_PREFIX + resolve(from, source) + CSS_VIRTUAL_SUFFIX;
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null;
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length);
      this.addWatchFile(fileId);
      const compiled = compileModuleStylesheet(fileId, await readFile(fileId));
      const localPath = relative(packageDir, fileId).split(sep).join("/");
      styles.set(virtualId, { path: localPath, css: compiled.css });
      return {
        code: `export default ${JSON.stringify(compiled.classMap)};`,
        moduleSideEffects: "no-treeshake",
      };
    },
    renderChunk(code: string, chunk: { readonly fileName: string }): string | null {
      if (!chunk.fileName.endsWith(".js")) return null;
      return wrapClientModule(code, stylesheetMetaArgument([...styles.values()]));
    },
  };
}

export default defineConfig({
  entry: { client: "src/client/index.tsx" },
  format: ["esm"],
  platform: "browser",
  target: "es2024",
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [/^react$/, /^react-dom$/, /^react\/jsx-runtime$/],
  },
  plugins: [clientStylePlugin(import.meta.dirname)],
});
