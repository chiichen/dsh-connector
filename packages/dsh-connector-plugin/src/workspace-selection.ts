import type { Context } from "@deepseek-ai/cordis";
import { SETTINGS_WORKSPACE_ID_KEY } from "./constants";
import { isRecord } from "./platforms/records";

/**
 * Workspace where an inbound receive starts a Session.
 *
 * The settings page lists the current profile's workspaces from the client
 * service `ctx.workspaces.list`. Its snapshot `items` follow Host registry order.
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-controller/src/client/service.ts
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-controller/src/client/model.ts
 *
 * Receive calls `sessionController.create({ workspaceId })`. That looks the id
 * up in `ctx.workspaceRegistry`, creates the Session in the workspace directory,
 * and attaches it with `workspace.attachSession`. Passing only `cwd` does not
 * attach the Session to the workspace.
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/session-controller/src/commands.ts
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/workspace/workspace/src/index.ts
 */

/** Shown between a duplicated title and its path. */
export const WORKSPACE_OPTION_PATH_SEPARATOR = " — " as const;

export interface WorkspaceChoice {
  readonly id: string;
  readonly title: string;
  readonly path: string;
}

/** Saved workspace id included with a settings save. `id` undefined clears it. */
export interface WorkspaceSettingsSave {
  readonly id: string | undefined;
}

/**
 * Host registry projection used when a receive starts a Session.
 * `list()` is the synchronous registry-order read.
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/workspace/workspace/src/index.ts
 */
export interface WorkspaceRegistryList {
  list(): readonly { readonly id: string }[];
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    workspaceRegistry: WorkspaceRegistryList;
  }
}

/**
 * Id to show and to pass to `sessionController.create`.
 * A saved id that is still registered wins. Otherwise the first workspace in
 * registry order is the selection, which is a real workspace title and path.
 * An empty registry returns undefined.
 */
export function chooseWorkspaceId(
  savedId: string | undefined,
  workspaceIds: readonly string[],
): string | undefined {
  if (savedId !== undefined && workspaceIds.includes(savedId)) return savedId;
  return workspaceIds[0];
}

/** Label for one workspace. A repeated title keeps the path so the rows stay distinct. */
export function workspaceOptionLabel(
  workspace: WorkspaceChoice,
  workspaces: readonly WorkspaceChoice[],
): string {
  const title = workspace.title.length > 0 ? workspace.title : workspace.path;
  const duplicated =
    workspace.title.length > 0 &&
    workspaces.some((other) => other.id !== workspace.id && other.title === workspace.title);
  if (!duplicated) return title;
  return `${title}${WORKSPACE_OPTION_PATH_SEPARATOR}${workspace.path}`;
}

/** Read the saved workspace id from a plugin config snapshot. */
export function workspaceIdFromConfigValue(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = value[SETTINGS_WORKSPACE_ID_KEY];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Registry order for the current profile, or undefined when the host has no
 * workspace registry. An empty array means the registry is present and empty.
 */
export function listedWorkspaceIds(ctx: Context): readonly string[] | undefined {
  const registry = ctx.get("workspaceRegistry");
  if (registry === undefined) return undefined;
  return registry.list().map((workspace) => workspace.id);
}
