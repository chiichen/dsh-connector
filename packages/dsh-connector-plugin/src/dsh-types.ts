import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConnectorLogger } from "@dsh-connector/core";
import type { DshKvTableLike } from "./context-store.js";
import type { DshObjectJsonSchema } from "./zod-json-schema.js";

export interface DshTextPartLike {
  readonly type: "text";
  readonly text: string;
}

export interface DshAgentLike {
  readonly id: string;
  readonly session?: { readonly id: string };
  followup?(message: string | DshTextPartLike): Promise<void> | void;
  steer?(message: string | DshTextPartLike): Promise<void> | void;
}

export interface DshAgentsServiceLike {
  get(sessionId: string): DshAgentLike | undefined;
  create(request: {
    readonly sessionId: string;
    readonly meta: { readonly cwd: string };
    readonly agentOptions?: Record<string, unknown>;
  }): Promise<{ readonly agent: DshAgentLike }>;
  resume(request: {
    readonly resumeSessionId: string;
    readonly agentOptions?: Record<string, unknown>;
  }): Promise<{ readonly agent: DshAgentLike }>;
}

export interface DshSessionsServiceLike {
  get(sessionId: string): { readonly id: string } | undefined;
}

export interface DshSessionPersistenceLike {
  stat(sessionId: string): Promise<unknown>;
}

export interface DshSessionTitleLike {
  setTitle?(sessionId: string, title: string): Promise<void> | void;
}

export interface DshSessionControllerLike {
  create(request: { readonly cwd?: string; readonly workspaceId?: string }): Promise<{
    readonly sessionId?: string;
    readonly agent?: DshAgentLike;
  }>;
  prompt(request: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly mode: "queue" | "steer";
    readonly content: string | readonly DshTextPartLike[];
  }): Promise<unknown>;
}

export interface DshToolRunContextLike {
  readonly agent?: {
    readonly id: string;
    readonly session?: { readonly id: string };
  };
  readonly signal?: AbortSignal;
}

export interface DshToolDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: DshObjectJsonSchema;
  readonly output?: {
    readonly schema: DshObjectJsonSchema;
    render?(value: unknown): string;
  };
  execute(args: unknown, exec: DshToolRunContextLike): Promise<unknown>;
}

export interface DshToolsServiceLike {
  register(definition: DshToolDefinitionLike): () => void;
}

export interface DshWebServerRouteLike {
  readonly kind: "exact" | "prefix";
  readonly path: string;
  readonly auth: "anonymous" | "required";
  handler(req: IncomingMessage, res: ServerResponse): Promise<void> | void;
}

export interface DshWebServerLike {
  register(route: DshWebServerRouteLike): () => void;
}

export interface DshAgentDefaultModelLike {
  currentSelection(): {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
  };
}

export interface DshOpenedDomainLike {
  table(name: string): DshKvTableLike;
  close(): Promise<void>;
}

export interface DshStorageDomainLike {
  open(spec: unknown): Promise<DshOpenedDomainLike>;
}

export interface DshOptionalServicesMap {
  sessionController: DshSessionControllerLike;
  sessionPersistence: DshSessionPersistenceLike;
  sessionTitle: DshSessionTitleLike;
  webServer: DshWebServerLike;
  agentDefaultModel: DshAgentDefaultModelLike;
  storageDomain: DshStorageDomainLike;
}

export interface DshCordisContextLike {
  readonly agents: DshAgentsServiceLike;
  readonly sessions: DshSessionsServiceLike;
  readonly tools: DshToolsServiceLike;
  readonly logger?: Partial<ConnectorLogger>;
  get<K extends keyof DshOptionalServicesMap>(key: K): DshOptionalServicesMap[K] | undefined;
  effect(setup: () => (() => Promise<void> | void) | void): void;
}
