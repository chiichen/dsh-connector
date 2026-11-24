import { defineConfig } from "tsdown";

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
});
