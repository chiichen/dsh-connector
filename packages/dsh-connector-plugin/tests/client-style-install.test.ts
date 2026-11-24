// @vitest-environment happy-dom
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { clientStyleInstall } from "../tsdown.client.config";
import { CONNECTOR_PLUGIN_NAME } from "../src/constants";

const STYLESHEET_PATH = "src/client/panel.module.css";
const STYLESHEET_TEXT = ".fields { display: flex; flex-direction: column; }";

interface StylesheetText {
  text(context: { asset(reference: string): string }): string;
}

describe("client stylesheet install", () => {
  it("exposes the compiled sheet through meta().stylesheets", () => {
    const installed = clientStyleInstall(CONNECTOR_PLUGIN_NAME, STYLESHEET_PATH, STYLESHEET_TEXT);
    const meta = runInNewContext(`() => ({ stylesheets: ${installed.stylesheets} })`) as () => {
      stylesheets: Readonly<Record<string, StylesheetText>>;
    };
    const text = meta().stylesheets[STYLESHEET_PATH]?.text({
      asset: (reference) => reference,
    });
    expect(text).toBe(STYLESHEET_TEXT);
  });

  it("inserts style[data-plugin] while the factory runs", () => {
    const installed = clientStyleInstall(CONNECTOR_PLUGIN_NAME, STYLESHEET_PATH, STYLESHEET_TEXT);
    const before = new Set(document.querySelectorAll("style:not([data-plugin])"));
    runInNewContext(installed.injection, { document });
    for (const element of document.querySelectorAll("style:not([data-plugin])")) {
      if (!before.has(element)) element.setAttribute("data-plugin", CONNECTOR_PLUGIN_NAME);
    }
    const owned = [
      ...document.querySelectorAll(`style[data-plugin=${JSON.stringify(CONNECTOR_PLUGIN_NAME)}]`),
    ];
    expect(owned.map((element) => element.textContent)).toEqual([STYLESHEET_TEXT]);
    expect(owned.map((element) => element.getAttribute("data-plugin-css"))).toEqual([
      `${CONNECTOR_PLUGIN_NAME}/panel.module.css`,
    ]);
    runInNewContext(installed.injection, { document });
    expect(
      document.querySelectorAll(`style[data-plugin=${JSON.stringify(CONNECTOR_PLUGIN_NAME)}]`)
        .length,
    ).toBe(1);
  });
});
