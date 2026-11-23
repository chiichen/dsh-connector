import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {
  SessionCreateRequest,
  SessionRequestId,
} from "@deepseek-ai/dsh-api-session-controller";
import { brandString } from "@deepseek-ai/dsh-brand";
import { createUserMessage, type ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-session-title";

const SESSION_ID_PREFIX = "session-" as const;
const USER_MESSAGE_SOURCE_KIND = "user" as const;

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
    private readonly ctx: Context,
    options?: DshSessionDriverOptions,
  ) {
    this.defaultCwd = options?.defaultCwd ?? process.cwd();
    this.workspaceId = options?.workspaceId;
  }

  async exists(sessionId: string): Promise<boolean> {
    const id = SessionId(sessionId);
    if (this.ctx.agents.get(id) !== undefined) {
      return true;
    }
    if (this.ctx.sessions.get(id) !== undefined) {
      return true;
    }
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence !== undefined) {
      const stat = await persistence.stat(id);
      return stat !== undefined;
    }
    return false;
  }

  async createSession(options?: { readonly suggestedTitle?: string }): Promise<string> {
    const controller = this.ctx.get("sessionController");
    let sessionId: SessionId;

    if (controller !== undefined) {
      const createReq: SessionCreateRequest =
        this.workspaceId !== undefined
          ? {
              workspaceId: brandString<NonNullable<SessionCreateRequest["workspaceId"]>>(
                this.workspaceId,
              ),
            }
          : { cwd: this.defaultCwd };
      const created = await controller.create(createReq);
      sessionId = created.sessionId;
    } else {
      sessionId = SessionId(`${SESSION_ID_PREFIX}${randomUUID()}`);
      const agentOptions = this.resolveAgentOptions();
      await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.defaultCwd },
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      });
    }

    const rawTitle = options?.suggestedTitle?.trim();
    if (rawTitle !== undefined && rawTitle.length > 0) {
      if (controller !== undefined) {
        await controller.rename({ sessionId, title: rawTitle });
      } else {
        const titleService = this.ctx.get("sessionTitle");
        const liveSession = this.ctx.sessions.get(sessionId);
        if (titleService !== undefined && liveSession !== undefined) {
          titleService.rename(liveSession, rawTitle);
        }
      }
    }

    return sessionId;
  }

  async prompt(sessionId: string, text: string, mode: "queue" | "steer" = "queue"): Promise<void> {
    const id = SessionId(sessionId);
    const controller = this.ctx.get("sessionController");
    if (controller !== undefined) {
      const abortController = new AbortController();
      await controller.prompt(
        {
          requestId: brandString<SessionRequestId>(randomUUID()),
          sessionId: id,
          mode,
          content: [{ type: "text", text }],
        },
        abortController.signal,
      );
      return;
    }

    let agent = this.ctx.agents.get(id);
    if (agent === undefined) {
      const agentOptions = this.resolveAgentOptions();
      const resumed = await this.ctx.agents.resume({
        resumeSessionId: id,
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      });
      agent = resumed.agent;
    }

    const message = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: USER_MESSAGE_SOURCE_KIND },
    });

    if (mode === "steer") {
      agent.steer(message);
    } else {
      agent.followup(message);
    }
  }

  private resolveAgentOptions(): AgentOptions | undefined {
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
        const effort = defaultModel.currentSelection().reasoningEffort;
        return effort !== undefined ? brandString<ReasoningEffortId>(effort) : undefined;
      },
    };
  }
}
