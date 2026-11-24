import { describe, expect, it } from "vitest";
import {
  compileModuleStylesheet,
  stylesheetMetaArgument,
  wrapClientModule,
} from "../tsdown.client.config";

describe("client stylesheet metadata", () => {
  it("hashes CSS Module classes and publishes the compiled sheet for the renderer", () => {
    const compiled = compileModuleStylesheet(
      "src/client/panel.module.css",
      Buffer.from(".layout { color: var(--dsw-alias-label-primary); }\n"),
    );
    expect(compiled.classMap.layout).toMatch(/_layout$/);
    expect(compiled.css).toContain(compiled.classMap.layout);
    expect(compiled.css).toContain("var(--dsw-alias-label-primary)");

    const meta = stylesheetMetaArgument([
      { path: "src/client/panel.module.css", css: compiled.css },
    ]);
    expect(meta).toContain('"src/client/panel.module.css"');
    expect(meta).toContain("meta: () => ({ stylesheets:");
    expect(meta).toContain("text: (context) =>");
    expect(meta).toContain(JSON.stringify(compiled.css));
  });

  it("omits metadata when a bundle has no stylesheets", () => {
    expect(stylesheetMetaArgument([])).toBe("");
  });

  it("registers the client factory and stylesheet metadata with the module loader", () => {
    const wrapped = wrapClientModule(
      'import { useState } from "react";\nconst apply = () => {};\nexport { apply };\n',
      ', meta: () => ({ stylesheets: {"src/client/panel.module.css": { text: (context) => ".a{}" }} })',
    );
    expect(wrapped).toContain("window.__ModuleLoader__.load");
    expect(wrapped).toContain('const { useState } = require("react");');
    expect(wrapped).not.toMatch(/^import /m);
    expect(wrapped).not.toMatch(/^export /m);
    expect(wrapped).toContain("exports.apply = apply;");
    expect(wrapped).toContain("meta: () => ({ stylesheets:");
    expect(wrapped).toContain('"src/client/panel.module.css"');
  });
});
