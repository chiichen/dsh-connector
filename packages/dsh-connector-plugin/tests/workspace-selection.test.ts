import { describe, expect, it } from "vitest";
import type { SessionCreateRequest } from "@deepseek-ai/dsh-api-session-controller";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Config } from "../src";
import { workspaceSettingsOp } from "../src/client/persist";
import { DshSessionDriver } from "../src/session-driver";
import {
  chooseWorkspaceId,
  workspaceIdFromConfigValue,
  workspaceOptionLabel,
  type WorkspaceChoice,
} from "../src/workspace-selection";
import { TestDshHost } from "./mocks/mock-dsh-host";

const REPO_A: WorkspaceChoice = { id: "ws-a", title: "repoa", path: "/work/repoa" };
const REPO_B: WorkspaceChoice = { id: "ws-b", title: "repob", path: "/work/repob" };

describe("workspace selection", () => {
  it("keeps a saved workspace and otherwise uses the first registered workspace", () => {
    expect(chooseWorkspaceId("ws-b", ["ws-a", "ws-b"])).toBe("ws-b");
    expect(chooseWorkspaceId(undefined, ["ws-a", "ws-b"])).toBe("ws-a");
    expect(chooseWorkspaceId("missing", ["ws-a", "ws-b"])).toBe("ws-a");
    expect(chooseWorkspaceId(undefined, [])).toBeUndefined();
    expect(chooseWorkspaceId("ws-a", [])).toBeUndefined();
  });

  it("labels a workspace by its title and keeps the path when titles collide", () => {
    expect(workspaceOptionLabel(REPO_A, [REPO_A, REPO_B])).toBe("repoa");
    const copy: WorkspaceChoice = { id: "ws-c", title: "repoa", path: "/work/repoa-copy" };
    expect(workspaceOptionLabel(REPO_A, [REPO_A, copy])).toBe("repoa — /work/repoa");
    expect(workspaceOptionLabel({ id: "ws-root", title: "", path: "/work/root" }, [])).toBe(
      "/work/root",
    );
  });

  it("reads the saved workspace id back from plugin config", () => {
    expect(workspaceIdFromConfigValue(undefined)).toBeUndefined();
    expect(workspaceIdFromConfigValue({ workspaceId: "" })).toBeUndefined();
    expect(workspaceIdFromConfigValue({ workspaceId: "ws-b", platforms: {} })).toBe("ws-b");
  });

  it("writes the shared workspace id without a blank default", () => {
    expect(workspaceSettingsOp(undefined, "ws-a")).toEqual({
      op: "set",
      path: ["workspaceId"],
      value: "ws-a",
    });
    expect(workspaceSettingsOp("ws-a", "ws-a")).toBeUndefined();
    expect(workspaceSettingsOp("ws-a", undefined)).toEqual({
      op: "unset",
      path: ["workspaceId"],
    });
  });

  it("marks workspaceId volatile so reopening settings reads it back", () => {
    const dict = Reflect.get(Config, "dict");
    expect(typeof dict).toBe("object");
    if (typeof dict !== "object" || dict === null) return;
    const field = Reflect.get(dict, "workspaceId");
    const meta =
      typeof field === "function" || (typeof field === "object" && field !== null)
        ? Reflect.get(field, "meta")
        : undefined;
    if (typeof meta !== "object" || meta === null) {
      throw new Error("workspaceId schema is missing meta");
    }
    expect(Reflect.get(meta, "volatile")).toBe(true);
  });
});

describe("receive session workspace", () => {
  it("starts the session in the saved workspace, or the first registered one", async () => {
    const host = await TestDshHost.start({ useSessionController: true });
    try {
      const requests: SessionCreateRequest[] = [];
      const original = host.ctx.sessionController.create.bind(host.ctx.sessionController);
      host.ctx.sessionController.create = async (request) => {
        requests.push(request);
        return original(request);
      };
      host.ctx.provide("workspaceRegistry", true);
      host.ctx.workspaceRegistry = {
        list: () => [{ id: "ws-a" }, { id: "ws-b" }],
      };

      const first = new DshSessionDriver(host.ctx);
      const firstId = await first.createSession();
      expect(requests[0]).toEqual({ workspaceId: "ws-a" });
      expect(firstId.startsWith("session-")).toBe(true);

      const saved = new DshSessionDriver(host.ctx, { workspaceId: "ws-b" });
      await saved.createSession();
      expect(requests[1]).toEqual({ workspaceId: "ws-b" });

      host.ctx.workspaceRegistry = { list: () => [{ id: "ws-a" }] };
      const missing = new DshSessionDriver(host.ctx, { workspaceId: "ws-gone" });
      await missing.createSession();
      expect(requests[2]).toEqual({ workspaceId: "ws-a" });
      expect(host.persistedSessions.has(SessionId(firstId))).toBe(true);
    } finally {
      await host.stop();
    }
  });
});
