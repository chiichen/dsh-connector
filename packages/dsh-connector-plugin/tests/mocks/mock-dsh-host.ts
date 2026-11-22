import { randomUUID } from "node:crypto";
import type {
  DshAgentLike,
  DshCordisContextLike,
  DshOptionalServicesMap,
  DshToolDefinitionLike,
  DshWebServerRouteLike,
} from "../../src/dsh-types.js";

export interface RecordedPrompt {
  readonly sessionId: string;
  readonly text: string;
  readonly mode: "queue" | "steer";
  readonly via: "sessionController" | "agent";
}

export class MockDshHost {
  readonly liveAgents = new Map<string, DshAgentLike>();
  readonly persistedSessions = new Map<string, { cwd: string; title?: string }>();
  readonly prompts: RecordedPrompt[] = [];
  readonly registeredTools = new Map<string, DshToolDefinitionLike>();
  readonly registeredRoutes: DshWebServerRouteLike[] = [];
  readonly disposers: Array<() => Promise<void> | void> = [];

  private readonly useSessionController: boolean;

  constructor(options?: { useSessionController?: boolean }) {
    this.useSessionController = options?.useSessionController ?? true;
  }

  deleteSessionInUi(sessionId: string): void {
    this.liveAgents.delete(sessionId);
    this.persistedSessions.delete(sessionId);
  }

  evictLiveAgentToColdStorage(sessionId: string): void {
    this.liveAgents.delete(sessionId);
  }

  createContext(): DshCordisContextLike {
    const createAgentInstance = (sessionId: string, cwd: string): DshAgentLike => {
      const agent: DshAgentLike = {
        id: sessionId,
        session: { id: sessionId },
        followup: async (message) => {
          const text = typeof message === "string" ? message : message.text;
          this.prompts.push({ sessionId, text, mode: "queue", via: "agent" });
        },
        steer: async (message) => {
          const text = typeof message === "string" ? message : message.text;
          this.prompts.push({ sessionId, text, mode: "steer", via: "agent" });
        },
      };
      this.liveAgents.set(sessionId, agent);
      if (!this.persistedSessions.has(sessionId)) {
        this.persistedSessions.set(sessionId, { cwd });
      }
      return agent;
    };

    const optionalServices: Partial<DshOptionalServicesMap> = {
      sessionPersistence: {
        stat: async (sessionId: string) => this.persistedSessions.get(sessionId),
      },
      sessionTitle: {
        setTitle: async (sessionId: string, title: string) => {
          const entry = this.persistedSessions.get(sessionId);
          if (entry !== undefined) {
            entry.title = title;
          }
        },
      },
      webServer: {
        register: (route: DshWebServerRouteLike) => {
          this.registeredRoutes.push(route);
          return () => {
            const idx = this.registeredRoutes.indexOf(route);
            if (idx >= 0) this.registeredRoutes.splice(idx, 1);
          };
        },
      },
    };

    if (this.useSessionController) {
      optionalServices.sessionController = {
        create: async ({ cwd = "/tmp/dsh-connectors" }) => {
          const mintedId = `session-${randomUUID()}`;
          const agent = createAgentInstance(mintedId, cwd);
          return { sessionId: mintedId, agent };
        },
        prompt: async ({ sessionId, mode, content }) => {
          if (!this.persistedSessions.has(sessionId) && !this.liveAgents.has(sessionId)) {
            throw new Error(`Session "${sessionId}" not found`);
          }
          const text =
            typeof content === "string" ? content : content.map((block) => block.text).join("\n");
          this.prompts.push({ sessionId, text, mode, via: "sessionController" });
        },
      };
    }

    return {
      agents: {
        get: (sessionId) => this.liveAgents.get(sessionId),
        create: async ({ sessionId, meta }) => ({
          agent: createAgentInstance(sessionId, meta.cwd),
        }),
        resume: async ({ resumeSessionId }) => {
          const persisted = this.persistedSessions.get(resumeSessionId);
          if (persisted === undefined) {
            throw new Error(`Cold session "${resumeSessionId}" not found`);
          }
          return { agent: createAgentInstance(resumeSessionId, persisted.cwd) };
        },
      },
      sessions: {
        get: (sessionId) => (this.liveAgents.has(sessionId) ? { id: sessionId } : undefined),
      },
      tools: {
        register: (definition) => {
          this.registeredTools.set(definition.name, definition);
          return () => {
            this.registeredTools.delete(definition.name);
          };
        },
      },
      get: <K extends keyof DshOptionalServicesMap>(key: K) =>
        optionalServices[key] as DshOptionalServicesMap[K] | undefined,
      effect: (setup) => {
        const dispose = setup();
        if (typeof dispose === "function") {
          this.disposers.push(dispose);
        }
      },
    };
  }

  async disposeAll(): Promise<void> {
    for (const dispose of [...this.disposers].reverse()) {
      await dispose();
    }
    this.disposers.length = 0;
  }
}
