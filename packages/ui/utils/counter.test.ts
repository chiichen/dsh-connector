import { describe, expect, it } from "vitest";
import { Counter } from "../components/counter";
import { Header } from "../components/header";
import { setupCounter } from "./counter";

describe("Header", () => {
  it("renders the given title", () => {
    const markup = Header({ title: "Web" });

    expect(markup).toContain('<header id="header">');
    expect(markup).toContain("<h1>Web</h1>");
  });
});

describe("Counter", () => {
  it("renders a button the app can bind to", () => {
    expect(Counter()).toContain('<button id="counter" type="button"></button>');
  });
});

describe("setupCounter", () => {
  it("starts at zero and increments on each click", () => {
    const button = document.createElement("button");

    setupCounter(button);

    expect(button.innerText).toBe("count is 0");

    button.click();
    expect(button.innerText).toBe("count is 1");

    button.click();
    expect(button.innerText).toBe("count is 2");
  });
});
