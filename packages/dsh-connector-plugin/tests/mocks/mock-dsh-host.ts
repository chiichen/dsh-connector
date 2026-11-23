import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentRegistry,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import type {
  SessionController,
  SessionCreateRequest,
  SessionCreateValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
} from "@deepseek-ai/dsh-api-session-controller";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import type { ToolCallId, UserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionSeq, SessionStore, type Session } from "@deepseek-ai/dsh-session";
import {
  SessionPersistenceRevision,
  type SessionPersistence,
  type SessionPersistenceSnapshot,
} from "@deepseek-ai/dsh-session-persistence";
import type { SessionTitleService, SessionTitleSnapshot } from "@deepseek-ai/dsh-session-title";
import Storage from "@deepseek-ai/dsh-storage";
import * as StorageDomain from "@deepseek-ai/dsh-storage-domain";
import * as StorageJson from "@deepseek-ai/dsh-storage-json";
import { ToolsService, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { brandString } from "@deepseek-ai/dsh-brand";
import { randomUUID } from "node:crypto";

export interface RecordedPrompt {
  readonly sessionId: SessionId;
  readonly text: string;
  readonly mode: "queue" | "steer";
  readonly via: "sessionController" | "agent";
}

export interface TestDshHostOptions {
  readonly useSessionController?: boolean;
  readonly withWebServer?: boolean;
  readonly storageRoot?: string;
  readonly persistedSessions?: Map<SessionId, { cwd: string; title?: string }>;
}

export function createTestToolRunContext(options?: {
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}): ToolRunContext {
  const signal = options?.signal ?? new AbortController().signal;
  const callId = brandString<ToolCallId>(`call-${randomUUID()}`);
  const agent =
    options?.sessionId !== undefined ? ({ id: SessionId(options.sessionId) } as Agent) : undefined;

  return {
    callId,
    rootCallId: callId,
    name: "test_tool",
    arguments: {},
    ...(agent !== undefined ? { agent } : {}),
    signal,
    token: Symbol("tool-exec-token") as ToolRunContext["token"],
    deferContext() {},
    concludeTurn() {},
  };
}

export class TestDshHost {
  readonly ctx: Context;
  readonly liveAgents = new Map<SessionId, Agent>();
  readonly persistedSessions: Map<SessionId, { cwd: string; title?: string }>;
  readonly prompts: RecordedPrompt[] = [];
  readonly storageRoot: string;
  private readonly sessionDetachers = new Map<SessionId, () => void>();
  private readonly ownedTempDir: string | undefined;

  private constructor(
    ctx: Context,
    storageRoot: string,
    ownedTempDir: string | undefined,
    persistedSessions: Map<SessionId, { cwd: string; title?: string }>,
  ) {
    this.ctx = ctx;
    this.storageRoot = storageRoot;
    this.ownedTempDir = ownedTempDir;
    this.persistedSessions = persistedSessions;
  }

  static async start(options?: TestDshHostOptions): Promise<TestDshHost> {
    const ownedTempDir =
      options?.storageRoot === undefined
        ? await mkdtemp(join(tmpdir(), "dsh-connector-test-"))
        : undefined;
    const storageRoot = options?.storageRoot ?? ownedTempDir!;
    const persistedSessions =
      options?.persistedSessions ?? new Map<SessionId, { cwd: string; title?: string }>();

    const ctx = new Context();
    const host = new TestDshHost(ctx, storageRoot, ownedTempDir, persistedSessions);

    ctx.provide("systemPrompt", true);
    (ctx as unknown as { systemPrompt: { tools: () => () => void } }).systemPrompt = {
      tools: () => () => {},
    };

    await ctx.plugin(Storage);
    await ctx.plugin(StorageJson, { root: storageRoot });
    await ctx.plugin(StorageDomain, { backend: "json" });
    await ctx.plugin(SessionStore);
    await ctx.plugin(ToolsService, {});

    if (options?.withWebServer ?? false) {
      await ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
    }

    host.mountSessionAndAgentStubs(options?.useSessionController ?? true);
    return host;
  }

  private mountSessionAndAgentStubs(useSessionController: boolean): void {
    const extractUserMessageText = (msg: UserMessage): string =>
      msg.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");

    const ensureLiveAgent = (sessionId: SessionId, cwd: string): Agent => {
      let liveSession = this.ctx.sessions.get(sessionId);
      if (liveSession === undefined) {
        const prepared = this.ctx.sessions.prepare(sessionId, { meta: { cwd } });
        const detach = this.ctx.sessions.enter(prepared);
        this.ctx.sessions.announce(prepared);
        this.sessionDetachers.set(sessionId, detach);
        liveSession = prepared;
      }
      const agent = {
        id: sessionId,
        session: liveSession,
        options: {},
        ctx: this.ctx,
        followup: (message: UserMessage) => {
          this.prompts.push({
            sessionId,
            text: extractUserMessageText(message),
            mode: "queue",
            via: "agent",
          });
        },
        steer: (message: UserMessage) => {
          this.prompts.push({
            sessionId,
            text: extractUserMessageText(message),
            mode: "steer",
            via: "agent",
          });
        },
      } as unknown as Agent;

      this.liveAgents.set(sessionId, agent);
      if (!this.persistedSessions.has(sessionId)) {
        this.persistedSessions.set(sessionId, { cwd });
      }
      return agent;
    };

    const agentsStub = {
      get: (id: SessionId) => this.liveAgents.get(id),
      create: async (opts: CreateAgentOptions) => {
        const cwd = opts.meta?.cwd ?? "/tmp/dsh-test";
        const agent = ensureLiveAgent(opts.sessionId, cwd);
        return {
          agent,
          dispose: async () => {
            this.liveAgents.delete(opts.sessionId);
          },
        };
      },
      resume: async (opts: ResumeAgentOptions) => {
        const persisted = this.persistedSessions.get(opts.resumeSessionId);
        if (persisted === undefined) {
          throw new Error(`Cold session "${opts.resumeSessionId}" not found`);
        }
        const agent = ensureLiveAgent(opts.resumeSessionId, persisted.cwd);
        return {
          agent,
          dispose: async () => {
            this.liveAgents.delete(opts.resumeSessionId);
          },
        };
      },
    } as unknown as AgentRegistry;

    const persistenceStub = {
      stat: async (id: SessionId): Promise<SessionPersistenceSnapshot | undefined> => {
        const entry = this.persistedSessions.get(id);
        if (entry === undefined) return undefined;
        return {
          header: {
            version: 4,
            id,
            createdAt: Date.now(),
            cwd: entry.cwd,
            isSeeded: false,
          },
          revision: SessionPersistenceRevision("rev-1"),
        };
      },
    } as unknown as SessionPersistence;

    const titleStub = {
      rename: (session: Session, title: string): SessionTitleSnapshot => {
        const entry = this.persistedSessions.get(session.id);
        if (entry !== undefined) {
          entry.title = title;
        }
        return {
          title,
          messageSeqs: [],
          source: { kind: "user" },
          eventSeq: SessionSeq(0),
          updatedAt: Date.now(),
        };
      },
    } as unknown as SessionTitleService;

    this.ctx.provide("agents", true);
    this.ctx.agents = agentsStub;

    this.ctx.provide("sessionPersistence", true);
    this.ctx.sessionPersistence = persistenceStub;

    this.ctx.provide("sessionTitle", true);
    this.ctx.sessionTitle = titleStub;

    if (useSessionController) {
      const controllerStub = {
        create: async (req: SessionCreateRequest): Promise<SessionCreateValue> => {
          const mintedId = req.sessionId ?? SessionId(`session-${randomUUID()}`);
          ensureLiveAgent(mintedId, req.cwd ?? "/tmp/dsh-connectors");
          return { sessionId: mintedId };
        },
        rename: async (req: SessionRenameRequest): Promise<SessionRenameValue> => {
          const entry = this.persistedSessions.get(req.sessionId);
          if (entry !== undefined) {
            entry.title = req.title;
          }
          return { title: req.title, seq: 0 };
        },
        prompt: async (
          req: SessionPromptRequest,
          signal: AbortSignal,
        ): Promise<SessionPromptValue> => {
          signal.throwIfAborted();
          if (!this.persistedSessions.has(req.sessionId) && !this.liveAgents.has(req.sessionId)) {
            throw new Error(`Session "${req.sessionId}" not found`);
          }
          const text = req.content
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          this.prompts.push({
            sessionId: req.sessionId,
            text,
            mode: req.mode,
            via: "sessionController",
          });
          return { accepted: true };
        },
      } as unknown as SessionController;

      this.ctx.provide("sessionController", true);
      this.ctx.sessionController = controllerStub;
    }
  }

  deleteSessionInUi(rawSessionId: string): void {
    const id = SessionId(rawSessionId);
    this.liveAgents.delete(id);
    this.persistedSessions.delete(id);
    const detach = this.sessionDetachers.get(id);
    if (detach !== undefined) {
      this.sessionDetachers.delete(id);
      detach();
    }
  }

  evictLiveAgentToColdStorage(rawSessionId: string): void {
    const id = SessionId(rawSessionId);
    this.liveAgents.delete(id);
    const detach = this.sessionDetachers.get(id);
    if (detach !== undefined) {
      this.sessionDetachers.delete(id);
      detach();
    }
  }

  async stop(options?: { keepStorageDir?: boolean }): Promise<void> {
    await this.ctx.fiber.dispose();
    if (!(options?.keepStorageDir ?? false) && this.ownedTempDir !== undefined) {
      await rm(this.ownedTempDir, { recursive: true, force: true });
    }
  }
}
