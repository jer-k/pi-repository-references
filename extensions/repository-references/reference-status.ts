import type { RefreshPolicy } from "./refresh-policy.ts";
import {
  runtimeRoot,
  type ReferenceRuntime,
  type RepositoryReferencesSession,
} from "./repository-references-service.ts";

/** Diagnostic status for one configured Repository Reference. */
export type ReferenceStatus = {
  readonly alias: string;
  readonly source: string;
  readonly configuredRef: string | undefined;
  readonly root: string | undefined;
  readonly refreshPolicy: string | undefined;
  readonly state: string;
  readonly lastSuccessfulRefresh: string | undefined;
  readonly error: string | undefined;
};

/** Project every configured reference into command-safe diagnostic data. */
export function referenceStatuses(session: RepositoryReferencesSession): ReadonlyArray<ReferenceStatus> {
  return [...session.references].map(([alias, runtime]) => projectReferenceStatus(alias, runtime));
}

/** Render all configured reference diagnostics for `/references`. */
export function renderReferenceStatuses(session: RepositoryReferencesSession): string {
  const statuses = referenceStatuses(session);
  if (statuses.length === 0) {
    return "No Repository References are configured.";
  }
  return statuses.map(renderReferenceStatus).join("\n\n");
}

/** Render compact footer text for active clone and refresh work. */
export function renderActiveReferenceWork(activeWork: ReadonlyMap<string, "clone" | "refresh">): string | undefined {
  if (activeWork.size === 0) {
    return undefined;
  }
  let clones = 0;
  let refreshes = 0;
  for (const operation of activeWork.values()) {
    if (operation === "clone") {
      clones += 1;
    } else {
      refreshes += 1;
    }
  }
  const details = [
    clones === 0 ? undefined : `${String(clones)} cloning`,
    refreshes === 0 ? undefined : `${String(refreshes)} refreshing`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
  return `references: ${details}`;
}

/** Project one runtime state without exposing credential-bearing clone inputs. */
function projectReferenceStatus(alias: string, runtime: ReferenceRuntime): ReferenceStatus {
  const configuration = runtime.configuration;
  const remote = "remote" in runtime ? runtime.remote : undefined;
  return {
    alias,
    source:
      configuration._tag === "local" ? `local ${configuration.path}` : `remote ${configuration.repository.identity}`,
    configuredRef: configuration._tag === "remote" ? (configuration.configuredRef ?? "default branch") : undefined,
    root: runtimeRoot(runtime),
    refreshPolicy: configuration._tag === "remote" ? renderRefreshPolicy(configuration.refresh) : undefined,
    state: renderState(runtime),
    lastSuccessfulRefresh: remote?.checkout.metadata.lastSuccessfulRefresh,
    error: runtimeError(runtime),
  };
}

/** Render one status as a compact multi-line command record. */
function renderReferenceStatus(status: ReferenceStatus): string {
  const lines = [
    `@${status.alias} — ${status.source}`,
    status.configuredRef === undefined ? undefined : `  ref: ${status.configuredRef}`,
    status.root === undefined ? undefined : `  root: ${status.root}`,
    status.refreshPolicy === undefined ? undefined : `  refresh: ${status.refreshPolicy}`,
    `  state: ${status.state}`,
    status.lastSuccessfulRefresh === undefined
      ? undefined
      : `  last successful refresh: ${status.lastSuccessfulRefresh}`,
    status.error === undefined ? undefined : `  error: ${status.error}`,
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}

/** Render one effective Refresh Policy. */
function renderRefreshPolicy(policy: RefreshPolicy): string {
  if (policy._tag === "ttl") {
    return `ttl (${policy.ttl.literal})`;
  }
  return policy._tag;
}

/** Render one detailed lifecycle state for users. */
function renderState(runtime: ReferenceRuntime): string {
  switch (runtime._tag) {
    case "ready-local":
    case "ready-remote":
      return "ready";
    case "invalid-local":
    case "failed-uncached-remote":
      return "error";
    case "remote-uncached":
      return "uncached";
    case "cloning-remote":
      return "cloning";
    case "refreshing-remote":
      return "refreshing (old checkout ready)";
    case "stale-remote":
      return "stale";
    case "offline-cached-remote":
      return runtime.stale ? "offline (stale cache ready)" : "offline (cache ready)";
    case "offline-uncached-remote":
      return "offline (uncached)";
    case "failed-cached-remote":
      return "error (stale cache ready)";
  }
}

/** Return the concise current error or unavailability reason, when present. */
function runtimeError(runtime: ReferenceRuntime): string | undefined {
  switch (runtime._tag) {
    case "invalid-local":
    case "offline-uncached-remote":
    case "failed-cached-remote":
    case "failed-uncached-remote":
      return runtime.error.message;
    case "remote-uncached":
      return runtime.reason;
    case "stale-remote":
      return runtime.reason;
    default:
      return undefined;
  }
}
