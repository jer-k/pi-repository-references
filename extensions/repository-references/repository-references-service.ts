import { Result, type Result as ResultType } from "better-result";

import {
  IndexConstructionError,
  OfflineMaterializationError,
  ReferenceUnavailableError,
  type RepositoryReferenceError,
} from "../repository-reference-errors.ts";
import { makeCacheKey } from "./cache-identity.ts";
import { openLocalReference, type LocalReferenceError, type ReadyLocalReference } from "./local-reference.ts";
import {
  type ManagedCheckoutStorageError,
  type ManagedCheckoutStore,
  type ReadyManagedCheckout,
} from "./managed-checkout-storage.ts";
import type { Clock, GitProcess, RepositoryFileSystem } from "./ports.ts";
import {
  loadRepositoryReferencesConfiguration,
  type ConfigurationLoadError,
  type LoadConfigurationOptions,
  type RemoteReferenceConfiguration,
  type RepositoryReferenceConfiguration,
} from "./reference-configuration.ts";
import { buildReferenceIndex, type ReferenceIndex } from "./reference-index.ts";
import { isProtectedPhysicalPath, parseAliasPath, resolveAliasPath } from "./reference-path.ts";
import { decideAutomaticRefresh } from "./refresh-policy.ts";

/** A complete Remote Reference root and its tracked-file index. */
export type AvailableRemoteReference = {
  readonly checkout: ReadyManagedCheckout;
  readonly index: ReferenceIndex;
};

/** Explicit lifecycle states for one configured Repository Reference. */
export type ReferenceRuntime =
  | {
      readonly _tag: "ready-local";
      readonly configuration: RepositoryReferenceConfiguration;
      readonly local: ReadyLocalReference;
    }
  | {
      readonly _tag: "invalid-local";
      readonly configuration: RepositoryReferenceConfiguration;
      readonly error: LocalReferenceError;
    }
  | {
      readonly _tag: "remote-uncached";
      readonly configuration: RemoteReferenceConfiguration;
      readonly reason: string;
    }
  | {
      readonly _tag: "cloning-remote";
      readonly configuration: RemoteReferenceConfiguration;
      readonly work: ActiveRemoteWork;
    }
  | {
      readonly _tag: "ready-remote";
      readonly configuration: RemoteReferenceConfiguration;
      readonly remote: AvailableRemoteReference;
    }
  | {
      readonly _tag: "refreshing-remote";
      readonly configuration: RemoteReferenceConfiguration;
      readonly remote: AvailableRemoteReference;
      readonly work: ActiveRemoteWork;
    }
  | {
      readonly _tag: "stale-remote";
      readonly configuration: RemoteReferenceConfiguration;
      readonly remote: AvailableRemoteReference;
      readonly reason: "failure-cooldown" | "refresh-failed";
    }
  | {
      readonly _tag: "offline-cached-remote";
      readonly configuration: RemoteReferenceConfiguration;
      readonly remote: AvailableRemoteReference;
      readonly stale: boolean;
    }
  | {
      readonly _tag: "offline-uncached-remote";
      readonly configuration: RemoteReferenceConfiguration;
      readonly error: OfflineMaterializationError;
    }
  | {
      readonly _tag: "failed-cached-remote";
      readonly configuration: RemoteReferenceConfiguration;
      readonly remote: AvailableRemoteReference;
      readonly error: ManagedCheckoutStorageError | IndexConstructionError;
    }
  | {
      readonly _tag: "failed-uncached-remote";
      readonly configuration: RemoteReferenceConfiguration;
      readonly error: ManagedCheckoutStorageError | IndexConstructionError;
    };

type ActiveRemoteWork = Promise<ResultType<ReadyManagedCheckout, ManagedCheckoutStorageError>>;

/** Observable clone/refresh lifecycle event used by command and background UI adapters. */
export type ReferenceWorkEvent =
  | {
      readonly _tag: "started";
      readonly alias: string;
      readonly operation: "clone" | "refresh";
      readonly mode: "automatic" | "explicit";
    }
  | {
      readonly _tag: "succeeded";
      readonly alias: string;
      readonly operation: "clone" | "refresh";
      readonly mode: "automatic" | "explicit";
    }
  | {
      readonly _tag: "failed";
      readonly alias: string;
      readonly operation: "clone" | "refresh";
      readonly mode: "automatic" | "explicit";
      readonly error: ManagedCheckoutStorageError | IndexConstructionError;
    };

/** Session-owned Repository References state used by Pi lifecycle and tool hooks. */
export type RepositoryReferencesSession = {
  readonly references: Map<string, ReferenceRuntime>;
  readonly protectedRoots: Set<string>;
  readonly activeRemoteWork: Map<string, ActiveRemoteWork>;
  readonly activeAliasSettlements: Map<string, Promise<void>>;
  readonly automaticAttempts: Set<string>;
  readonly configurationGeneration: symbol;
  closed: boolean;
};

/** Effects needed to explicitly revalidate or refresh one reconciled reference. */
export type RefreshRepositoryReferenceOptions = {
  readonly git: GitProcess;
  readonly fullFileSystem: RepositoryFileSystem;
  readonly clock: Clock;
  readonly managedCheckouts?: ManagedCheckoutStore;
  readonly offline: boolean;
  readonly onReferenceWork?: (event: ReferenceWorkEvent) => void;
};

/** Inputs needed to reconcile Local and Remote References for one Pi session start. */
export type StartRepositoryReferencesOptions = LoadConfigurationOptions & {
  readonly git: GitProcess;
  readonly fullFileSystem: RepositoryFileSystem;
  readonly clock?: Clock;
  readonly managedCheckouts?: ManagedCheckoutStore;
  readonly offline?: boolean;
  readonly sessionAutomaticAttempts?: ReadonlySet<string>;
  readonly recentAutomaticAttempts?: ReadonlyMap<string, Date>;
  readonly onAutomaticAttempt?: (cacheKey: string, attemptedAt: Date) => void;
  readonly onReferenceWork?: (event: ReferenceWorkEvent) => void;
};

/** Result of attempting to rewrite one read-oriented built-in tool path. */
export type ReadPathResolution = { readonly _tag: "unchanged" } | { readonly _tag: "resolved"; readonly path: string };

/**
 * Load configuration, reconcile cached roots immediately, and schedule due remote work.
 *
 * Configuration failures disable the complete set. Per-reference validation, indexing, and remote
 * materialization failures remain isolated. Background work is coalesced by shared cache key.
 */
export async function startRepositoryReferencesSession(
  options: StartRepositoryReferencesOptions
): Promise<ResultType<RepositoryReferencesSession, ConfigurationLoadError>> {
  const configuration = await loadRepositoryReferencesConfiguration(options);
  if (configuration.status === "error") return configuration;

  const session: RepositoryReferencesSession = {
    references: new Map(),
    protectedRoots: new Set(),
    activeRemoteWork: new Map(),
    activeAliasSettlements: new Map(),
    automaticAttempts: new Set(options.sessionAutomaticAttempts),
    configurationGeneration: Symbol("repository-references-configuration"),
    closed: false,
  };

  for (const [alias, reference] of configuration.value.references) {
    if (reference._tag === "local") {
      await reconcileLocalReference(session, alias, reference, options);
      continue;
    }
    await reconcileRemoteReference(session, alias, reference, options);
  }

  return Result.ok(session);
}

/** Await publication/index settlement needed before rebuilding this same Pi session on reload. */
export async function finishRepositoryReferencesSessionWork(session: RepositoryReferencesSession): Promise<void> {
  await Promise.allSettled(session.activeAliasSettlements.values());
}

/** Mark a session closed so detached publication completion cannot mutate obsolete runtime state. */
export function closeRepositoryReferencesSession(session: RepositoryReferencesSession): void {
  session.closed = true;
  session.references.clear();
  session.activeRemoteWork.clear();
  session.activeAliasSettlements.clear();
  session.automaticAttempts.clear();
}

/** Return every configured Alias explicitly mentioned in prompt text, preserving configured spelling. */
export function findMentionedAliases(
  prompt: string,
  references: ReadonlyMap<string, ReferenceRuntime>
): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const match of prompt.matchAll(/@(?:"([^"/]+)(?:\/[^"\n]*)?"|([a-z0-9][a-z0-9._-]*))/gu)) {
    const alias = match[1] ?? match[2];
    if (alias !== undefined && references.has(alias)) aliases.add(alias);
  }
  return aliases;
}

/**
 * Wait only for currently active initial materialization of explicitly requested Aliases.
 *
 * Aborting a caller stops its wait but does not cancel shared clone/publication work.
 */
export async function waitForRequestedReferences(
  session: RepositoryReferencesSession,
  aliases: ReadonlySet<string>,
  signal: AbortSignal | undefined
): Promise<ReadonlyMap<string, string>> {
  const failures = new Map<string, string>();
  for (const alias of aliases) {
    const runtime = session.references.get(alias);
    if (runtime === undefined || runtimeRoot(runtime) !== undefined) continue;
    const work = session.activeAliasSettlements.get(alias) ?? remoteWorkForRuntime(session, runtime);
    if (work !== undefined) await waitWithoutCancelling(work, signal);
    const settled = session.references.get(alias);
    if (settled !== undefined && runtimeRoot(settled) === undefined) {
      failures.set(alias, runtimeFailureReason(settled));
    }
  }
  return failures;
}

/**
 * Explicitly revalidate a Local Reference or force one Remote Reference publication.
 *
 * Explicit remote work bypasses TTL and cooldown without changing automatic-attempt history.
 */
export async function refreshRepositoryReference(
  session: RepositoryReferencesSession,
  alias: string,
  options: RefreshRepositoryReferenceOptions
): Promise<ResultType<void, RepositoryReferenceError>> {
  const runtime = session.references.get(alias);
  if (runtime === undefined) {
    return Result.err(
      new ReferenceUnavailableError({
        alias,
        reason: "unknown Alias",
        message: `Repository Reference @${alias} is not configured`,
      })
    );
  }
  const reference = runtime.configuration;
  if (reference._tag === "local") {
    await reconcileLocalReference(session, alias, reference, options);
    const settled = session.references.get(alias);
    return settled?._tag === "invalid-local" ? Result.err(settled.error) : Result.ok(undefined);
  }

  const available = runtimeRemote(runtime);
  if (options.offline) {
    const error = new OfflineMaterializationError({
      alias,
      message: `Repository Reference @${alias} cannot refresh while Pi is offline`,
    });
    session.references.set(
      alias,
      available === undefined
        ? { _tag: "offline-uncached-remote", configuration: reference, error }
        : {
            _tag: "offline-cached-remote",
            configuration: reference,
            remote: available,
            stale: true,
          }
    );
    return Result.err(error);
  }
  if (options.managedCheckouts === undefined) {
    return Result.err(
      new ReferenceUnavailableError({
        alias,
        reason: "Remote Reference storage is unavailable",
        message: `Repository Reference @${alias} cannot refresh because storage is unavailable`,
      })
    );
  }

  scheduleRemoteWork(
    session,
    alias,
    reference,
    available,
    available === undefined ? "ensure" : "refresh",
    options.clock.now(),
    options,
    "explicit"
  );
  const settlement = session.activeAliasSettlements.get(alias);
  if (settlement !== undefined) await settlement;
  const settled = session.references.get(alias);
  if (settled?._tag === "failed-cached-remote" || settled?._tag === "failed-uncached-remote") {
    return Result.err(settled.error);
  }
  return Result.ok(undefined);
}

/**
 * Rewrite a known, ready Alias path to its containment-safe canonical physical path.
 *
 * Unknown Aliases and ordinary paths are returned unchanged for normal Pi handling.
 */
export async function resolveSessionReadPath(
  session: RepositoryReferencesSession,
  input: string,
  fileSystem: Pick<RepositoryFileSystem, "realPath">
): Promise<
  ResultType<
    ReadPathResolution,
    | import("../repository-reference-errors.ts").InvalidReferencePathError
    | import("../repository-reference-errors.ts").ReferencePathEscapeError
    | import("../repository-reference-errors.ts").ReferencePathResolutionError
    | ReferenceUnavailableError
  >
> {
  const parsed = parseAliasPath(input);
  if (parsed.status === "error") return parsed;
  if (parsed.value._tag === "not-alias-path") return Result.ok({ _tag: "unchanged" });

  const reference = session.references.get(parsed.value.alias);
  if (reference === undefined) return Result.ok({ _tag: "unchanged" });
  const root = runtimeRoot(reference);
  if (root === undefined) {
    const reason = runtimeFailureReason(reference);
    return Result.err(
      new ReferenceUnavailableError({
        alias: parsed.value.alias,
        reason,
        message: `Repository Reference @${parsed.value.alias} is unavailable: ${reason}`,
      })
    );
  }

  const resolved = await resolveAliasPath(parsed.value, root, fileSystem);
  return resolved.status === "error" ? resolved : Result.ok({ _tag: "resolved", path: resolved.value });
}

/**
 * Decide whether an edit/write target addresses a known Alias or protected physical root.
 *
 * Unknown Alias syntax remains available to Pi; every known Alias is blocked even while unavailable.
 */
export async function shouldBlockSessionWrite(
  session: RepositoryReferencesSession,
  input: string,
  cwd: string,
  fileSystem: Pick<RepositoryFileSystem, "realPath">
): Promise<
  ResultType<
    boolean,
    | import("../repository-reference-errors.ts").InvalidReferencePathError
    | import("../repository-reference-errors.ts").PhysicalPathResolutionError
    | import("../repository-reference-errors.ts").RepositoryFileSystemError
  >
> {
  const parsed = parseAliasPath(input);
  if (parsed.status === "error") return parsed;
  if (parsed.value._tag === "alias-path" && session.references.has(parsed.value.alias)) {
    return Result.ok(true);
  }
  return isProtectedPhysicalPath(input, cwd, session.protectedRoots, fileSystem);
}

/** Return the currently usable canonical root for a runtime state. */
export function runtimeRoot(runtime: ReferenceRuntime): string | undefined {
  if (runtime._tag === "ready-local") return runtime.local.root;
  if ("remote" in runtime) return runtime.remote.checkout.root;
  return undefined;
}

/** Return the current autocomplete index for a ready state. */
export function runtimeIndex(runtime: ReferenceRuntime): ReferenceIndex | undefined {
  if (runtime._tag === "ready-local") return runtime.local.index;
  if ("remote" in runtime) return runtime.remote.index;
  return undefined;
}

/** Validate and index one Local Reference without affecting unrelated entries. */
async function reconcileLocalReference(
  session: RepositoryReferencesSession,
  alias: string,
  reference: Extract<RepositoryReferenceConfiguration, { readonly _tag: "local" }>,
  options: Pick<StartRepositoryReferencesOptions, "git" | "fullFileSystem">
): Promise<void> {
  const opened = await openLocalReference({
    alias: reference.alias,
    configuredPath: reference.path,
    fileSystem: options.fullFileSystem,
    git: options.git,
  });
  if (opened.status === "error") {
    session.references.set(alias, { _tag: "invalid-local", configuration: reference, error: opened.error });
    return;
  }
  session.protectedRoots.add(opened.value.root);
  session.references.set(alias, { _tag: "ready-local", configuration: reference, local: opened.value });
}

/** Open cached remote state, calculate policy, and schedule only due network work. */
async function reconcileRemoteReference(
  session: RepositoryReferencesSession,
  alias: string,
  reference: RemoteReferenceConfiguration,
  options: StartRepositoryReferencesOptions
): Promise<void> {
  const storage = options.managedCheckouts;
  if (storage === undefined) {
    session.references.set(alias, {
      _tag: "remote-uncached",
      configuration: reference,
      reason: "Remote Reference storage is unavailable",
    });
    return;
  }

  const request = { repository: reference.repository, configuredRef: reference.configuredRef };
  const opened = await storage.open(request);
  if (opened.status === "error") {
    session.references.set(alias, { _tag: "failed-uncached-remote", configuration: reference, error: opened.error });
    return;
  }

  let available: AvailableRemoteReference | undefined;
  if (opened.value !== undefined) {
    const indexed = await indexManagedCheckout(alias, opened.value, options.git);
    if (indexed.status === "error") {
      available = { checkout: opened.value, index: buildReferenceIndex("") };
      session.protectedRoots.add(opened.value.root);
      session.references.set(alias, {
        _tag: "failed-cached-remote",
        configuration: reference,
        remote: available,
        error: indexed.error,
      });
      return;
    }
    available = { checkout: opened.value, index: indexed.value };
    session.protectedRoots.add(opened.value.root);
  }

  const cacheKey = makeCacheKey(reference.repository, reference.configuredRef);
  const now = options.clock?.now() ?? new Date();
  const recentAttempt = options.recentAutomaticAttempts?.get(cacheKey)?.toISOString();
  const decision = decideAutomaticRefresh({
    policy: reference.refresh,
    now,
    lastSuccessfulRefresh: available?.checkout.metadata.lastSuccessfulRefresh,
    lastAutomaticAttempt: recentAttempt ?? available?.checkout.metadata.lastAutomaticAttempt,
    sessionAttempted: session.automaticAttempts.has(cacheKey),
  });

  if (options.offline === true) {
    if (available === undefined) {
      session.references.set(alias, {
        _tag: "offline-uncached-remote",
        configuration: reference,
        error: new OfflineMaterializationError({
          alias,
          message: `Repository Reference @${alias} is unavailable while Pi is offline`,
        }),
      });
      return;
    }
    session.references.set(alias, {
      _tag: "offline-cached-remote",
      configuration: reference,
      remote: available,
      stale: decision._tag === "refresh",
    });
    return;
  }

  if (available === undefined) {
    if (
      decision._tag === "skip" &&
      (decision.reason === "session-already-attempted" || decision.reason === "failure-cooldown")
    ) {
      const reason =
        decision.reason === "session-already-attempted"
          ? "session materialization was already attempted"
          : "automatic materialization is in failure cooldown";
      session.references.set(alias, { _tag: "remote-uncached", configuration: reference, reason });
      return;
    }
    scheduleRemoteWork(session, alias, reference, undefined, "ensure", now, options, "automatic");
    return;
  }

  if (decision._tag === "refresh") {
    scheduleRemoteWork(session, alias, reference, available, "refresh", now, options, "automatic");
    return;
  }
  if (decision.reason === "failure-cooldown") {
    session.references.set(alias, {
      _tag: "stale-remote",
      configuration: reference,
      remote: available,
      reason: "failure-cooldown",
    });
    return;
  }
  session.references.set(alias, { _tag: "ready-remote", configuration: reference, remote: available });
}

/** Coalesce same-process publication and project its result into one Alias state. */
function scheduleRemoteWork(
  session: RepositoryReferencesSession,
  alias: string,
  reference: RemoteReferenceConfiguration,
  available: AvailableRemoteReference | undefined,
  intent: "ensure" | "refresh",
  attemptedAt: Date,
  options: Pick<
    StartRepositoryReferencesOptions,
    "git" | "managedCheckouts" | "onAutomaticAttempt" | "onReferenceWork"
  >,
  mode: "automatic" | "explicit"
): void {
  const storage = options.managedCheckouts;
  if (storage === undefined) return;
  const cacheKey = makeCacheKey(reference.repository, reference.configuredRef);

  let work = session.activeRemoteWork.get(cacheKey);
  if (work === undefined) {
    if (mode === "automatic") {
      session.automaticAttempts.add(cacheKey);
      options.onAutomaticAttempt?.(cacheKey, attemptedAt);
    }
    const publicationContext = mode === "automatic" ? { automaticAttemptAt: attemptedAt } : {};
    work = storage.publish(
      { repository: reference.repository, configuredRef: reference.configuredRef },
      intent,
      publicationContext
    );
    session.activeRemoteWork.set(cacheKey, work);
    void work.then(
      () => session.activeRemoteWork.delete(cacheKey),
      () => session.activeRemoteWork.delete(cacheKey)
    );
  }

  const operation = available === undefined ? "clone" : "refresh";
  session.references.set(
    alias,
    available === undefined
      ? { _tag: "cloning-remote", configuration: reference, work }
      : { _tag: "refreshing-remote", configuration: reference, remote: available, work }
  );
  options.onReferenceWork?.({ _tag: "started", alias, operation, mode });
  const settlement = settleRemoteAlias(
    session,
    alias,
    reference,
    available,
    work,
    options.git,
    mode,
    options.onReferenceWork
  );
  session.activeAliasSettlements.set(alias, settlement);
  void settlement.then(
    () => session.activeAliasSettlements.delete(alias),
    () => session.activeAliasSettlements.delete(alias)
  );
}

/** Apply one shared publication outcome only while this session generation remains current. */
async function settleRemoteAlias(
  session: RepositoryReferencesSession,
  alias: string,
  reference: RemoteReferenceConfiguration,
  oldAvailable: AvailableRemoteReference | undefined,
  work: ActiveRemoteWork,
  git: GitProcess,
  mode: "automatic" | "explicit",
  onReferenceWork: ((event: ReferenceWorkEvent) => void) | undefined
): Promise<void> {
  const published = await work;
  if (session.closed || session.references.get(alias)?.configuration !== reference) return;
  if (published.status === "error") {
    session.references.set(
      alias,
      oldAvailable === undefined
        ? { _tag: "failed-uncached-remote", configuration: reference, error: published.error }
        : {
            _tag: "failed-cached-remote",
            configuration: reference,
            remote: oldAvailable,
            error: published.error,
          }
    );
    onReferenceWork?.({
      _tag: "failed",
      alias,
      operation: oldAvailable === undefined ? "clone" : "refresh",
      mode,
      error: published.error,
    });
    return;
  }

  session.protectedRoots.add(published.value.root);
  const indexed = await indexManagedCheckout(alias, published.value, git);
  if (session.closed || session.references.get(alias)?.configuration !== reference) return;
  if (indexed.status === "error") {
    const fallback = { checkout: published.value, index: buildReferenceIndex("") };
    session.references.set(alias, {
      _tag: "failed-cached-remote",
      configuration: reference,
      remote: fallback,
      error: indexed.error,
    });
    onReferenceWork?.({
      _tag: "failed",
      alias,
      operation: oldAvailable === undefined ? "clone" : "refresh",
      mode,
      error: indexed.error,
    });
    return;
  }
  session.references.set(alias, {
    _tag: "ready-remote",
    configuration: reference,
    remote: { checkout: published.value, index: indexed.value },
  });
  onReferenceWork?.({
    _tag: "succeeded",
    alias,
    operation: oldAvailable === undefined ? "clone" : "refresh",
    mode,
  });
}

/** Build a tracked-file index from a complete Managed Checkout. */
async function indexManagedCheckout(
  alias: string,
  checkout: ReadyManagedCheckout,
  git: GitProcess
): Promise<ResultType<ReferenceIndex, IndexConstructionError>> {
  const indexed = await git.run({
    operation: "index-managed-checkout",
    arguments: ["-C", checkout.root, "ls-files", "--cached", "-z"],
    timeoutMilliseconds: 30_000,
  });
  if (indexed.status === "error" || indexed.value.exitCode !== 0 || indexed.value.timedOut) {
    const cause = indexed.status === "error" ? indexed.error : safeIndexCause(indexed.value);
    return Result.err(
      new IndexConstructionError({
        alias,
        root: checkout.root,
        cause,
        message: `Could not index Remote Reference @${alias}`,
      })
    );
  }
  return Result.ok(buildReferenceIndex(indexed.value.standardOutput));
}

/** Return usable cached state from every remote state that carries one. */
function runtimeRemote(runtime: ReferenceRuntime): AvailableRemoteReference | undefined {
  return "remote" in runtime ? runtime.remote : undefined;
}

/** Find shared work for a remote runtime without exposing cache implementation details. */
function remoteWorkForRuntime(
  session: RepositoryReferencesSession,
  runtime: ReferenceRuntime
): ActiveRemoteWork | undefined {
  if (runtime._tag === "cloning-remote" || runtime._tag === "refreshing-remote") return runtime.work;
  if (runtime.configuration._tag !== "remote") return undefined;
  const cacheKey = makeCacheKey(runtime.configuration.repository, runtime.configuration.configuredRef);
  return session.activeRemoteWork.get(cacheKey);
}

/** Race one caller wait against abort while deliberately leaving shared work running. */
async function waitWithoutCancelling(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await work;
    return;
  }
  if (signal.aborted) return;
  await Promise.race([
    work,
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
  ]);
}

/** Render one concise availability reason from an explicit runtime state. */
function runtimeFailureReason(runtime: ReferenceRuntime): string {
  if (runtime._tag === "invalid-local") return runtime.error.message;
  if (runtime._tag === "remote-uncached") return runtime.reason;
  if (runtime._tag === "offline-uncached-remote") return runtime.error.message;
  if (runtime._tag === "failed-uncached-remote") return runtime.error.message;
  if (runtime._tag === "cloning-remote") return "initial materialization is still running";
  return "Repository Reference is unavailable";
}

/** Retain only safe process completion fields in an indexing failure cause. */
function safeIndexCause(output: import("./ports.ts").GitProcessOutput) {
  return {
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    signal: output.signal,
    diagnostic: output.standardError.trim().slice(0, 2_000),
  };
}
