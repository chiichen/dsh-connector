import { randomUUID } from "node:crypto";
import type { DshCordisContextLike } from "./dsh-types";

export interface DshSessionDriverOptions {
  readonly defaultCwd?: string;
  readonly workspaceId?: string;
}

export interface SessionDriver {
  exists(sessionId: string): Promise<boolean>;
  createSession(options?: { readonly suggestedTitle?: string }): Promise<string>;
  prompt(sessionId: string, text: string, mode?: "queue" | "steer"): Promise<void>;
}

export class DshSessionDriver implements SessionDriver {
  private readonly defaultCwd: string;
  private readonly workspaceId: string | undefined;

  constructor(
    private readonly ctx: DshCordisContextLike,
    options?: DshSessionDriverOptions,
  ) {
    this.defaultCwd = options?.defaultCwd ?? process.cwd();
    this.workspaceId = options?.workspaceId;
  }

  async exists(sessionId: string): Promise<boolean> {
    if (this.ctx.agents.get(sessionId) !== undefined) {
      return true;
    }
    if (this.ctx.sessions.get(sessionId) !== undefined) {
      return true;
    }
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence !== undefined) {
      const stat = await persistence.stat(sessionId);
      return stat !== undefined && stat !== null;
    }
    return false;
  }

  async createSession(options?: { readonly suggestedTitle?: string }): Promise<string> {
    const controller = this.ctx.get("sessionController");
    let sessionId: string;

    if (controller !== undefined) {
      const created = await controller.create({
        cwd: this.defaultCwd,
        ...(this.workspaceId !== undefined ? { workspaceId: this.workspaceId } : {}),
      });
      const resolvedId = created.sessionId ?? created.agent?.id;
      if (resolvedId === undefined || resolvedId.length === 0) {
        throw new Error("DSH sessionController.create returned an empty session identity.");
      }
      sessionId = resolvedId;
    } else {
      sessionId = `session-${randomUUID()}`;
      const agentOptions = this.resolveAgentOptions();
      await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.defaultCwd },
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      });
    }

    if (options?.suggestedTitle !== undefined && options.suggestedTitle.trim().length > 0) {
      const titleService = this.ctx.get("sessionTitle");
      await titleService?.setTitle?.(sessionId, options.suggestedTitle);
    }

    return sessionId;
  }

  async prompt(sessionId: string, text: string, mode: "queue" | "steer" = "queue"): Promise<void> {
    const controller = this.ctx.get("sessionController");
    if (controller !== undefined) {
      await controller.prompt({
        requestId: randomUUID(),
        sessionId,
        mode,
        content: [{ type: "text", text }],
      });
      return;
    }

    let agent = this.ctx.agents.get(sessionId);
    if (agent === undefined) {
      const agentOptions = this.resolveAgentOptions();
      const resumed = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      });
      agent = resumed.agent;
    }

    if (mode === "steer" && agent.steer !== undefined) {
      await agent.steer(text);
      return;
    }

    if (agent.followup !== undefined) {
      await agent.followup(text);
      return;
    }

    throw new Error(`DSH Agent "${sessionId}" exposes neither followup() nor steer().`);
  }

  private resolveAgentOptions(): Record<string, unknown> | undefined {
    const defaultModel = this.ctx.get("agentDefaultModel");
    if (defaultModel === undefined) {
      return undefined;
    }
    return {
      get provider() {
        return defaultModel.currentSelection().provider;
      },
      get model() {
        return defaultModel.currentSelection().model;
      },
      get reasoningEffort() {
        return defaultModel.currentSelection().reasoningEffort;
      },
    };
  }
}
