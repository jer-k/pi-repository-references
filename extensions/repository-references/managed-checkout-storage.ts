import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

import { Result, type Result as ResultType } from "better-result";

import {
  CacheLockError,
  CacheMetadataParseError,
  CacheMetadataReadError,
  CacheMetadataWriteError,
  CachePublicationError,
  type RepositoryFileSystemError,
} from "../repository-reference-errors.ts";
import { DEFAULT_BRANCH_CACHE_REF, makeCacheKey } from "./cache-identity.ts";
import { readCacheMetadata, writeCacheMetadata, type CacheMetadata } from "./cache-metadata.ts";
import type { ManagedGit, ManagedGitError, ResolvedManagedRevision } from "./managed-git.ts";
import type { CacheLocks, Clock, RepositoryFileSystem } from "./ports.ts";
import type { RepositorySource as ParsedRepositorySource } from "./repository-source.ts";

/** A complete immutable Managed Checkout selected by validated metadata. */
export type ReadyManagedCheckout = {
  /** Credential-free shared cache key. */
  readonly cacheKey: string;
  /** Canonical physical checkout root. */
  readonly root: string;
  /** Metadata that atomically selected this root. */
  readonly metadata: CacheMetadata;
};

/** Expected failures while opening or publishing Managed Checkout state. */
export type ManagedCheckoutStorageError =
  | CacheLockError
  | CacheMetadataParseError
  | CacheMetadataReadError
  | CacheMetadataWriteError
  | CachePublicationError
  | ManagedGitError;

/** Dependencies and cache location for Managed Checkout storage. */
export type ManagedCheckoutStorageOptions = {
  /** Private cache root, normally `$PI_CODING_AGENT_DIR/repository-references`. */
  readonly cacheRoot: string;
  /** Concrete filesystem boundary. */
  readonly fileSystem: RepositoryFileSystem;
  /** Per-entry inter-process lock adapter. */
  readonly locks: CacheLocks;
  /** Managed Git staging adapter. */
  readonly git: ManagedGit;
  /** Injected wall clock for durable timestamps. */
  readonly clock: Clock;
  /** Injected unique staging suffix, primarily for deterministic testing. */
  readonly makeUniqueSuffix?: () => string;
};

/** Optional orchestration context for one publication attempt. */
export type ManagedCheckoutPublicationContext = {
  /** Timestamp persisted before automatic cached refresh work begins. */
  readonly automaticAttemptAt?: Date;
};

/** Input identifying one shared Remote Reference cache entry. */
export type ManagedCheckoutRequest = {
  /** Parsed clone source and normalized credential-free identity. */
  readonly repository: ParsedRepositorySource;
  /** Optional configured branch, tag, or commit. */
  readonly configuredRef: string | undefined;
};

/** Application-facing Managed Checkout persistence capability. */
export type ManagedCheckoutStore = {
  /** Open a complete published checkout or report an uncached entry. */
  readonly open: (
    request: ManagedCheckoutRequest
  ) => Promise<ResultType<ReadyManagedCheckout | undefined, CacheMetadataReadError | CacheMetadataParseError>>;
  /** Ensure or refresh an immutable checkout publication. */
  readonly publish: (
    request: ManagedCheckoutRequest,
    intent: "ensure" | "refresh",
    context?: ManagedCheckoutPublicationContext
  ) => Promise<ResultType<ReadyManagedCheckout, ManagedCheckoutStorageError>>;
};

/** Bind concrete cache adapters into the narrow store used by runtime orchestration. */
export function createManagedCheckoutStore(options: ManagedCheckoutStorageOptions): ManagedCheckoutStore {
  return {
    open: (request) => openManagedCheckout(options, request),
    publish: (request, intent, context) => publishManagedCheckout(options, request, intent, context),
  };
}

/**
 * Open the currently published checkout without acquiring a mutation lock.
 *
 * Readers see only the checkout selected by atomically published metadata. Missing metadata means
 * the entry is uncached; malformed metadata or a missing selected checkout is a structured error.
 */
export async function openManagedCheckout(
  options: Pick<ManagedCheckoutStorageOptions, "cacheRoot" | "fileSystem">,
  request: ManagedCheckoutRequest
): Promise<ResultType<ReadyManagedCheckout | undefined, CacheMetadataReadError | CacheMetadataParseError>> {
  const paths = makeEntryPaths(options.cacheRoot, request);
  const metadata = await readCacheMetadata(paths.metadata, options.fileSystem);
  if (metadata.status === "error") return metadata;
  if (metadata.value === undefined) return Result.ok(undefined);

  const expectedRef = request.configuredRef ?? DEFAULT_BRANCH_CACHE_REF;
  if (
    metadata.value.repositoryIdentity !== request.repository.identity ||
    metadata.value.configuredRef !== expectedRef
  ) {
    return invalidMetadata(paths.metadata, "metadata identity does not match its cache entry");
  }

  const checkoutPath = join(paths.entry, metadata.value.currentCheckout);
  if (!isContained(paths.entry, checkoutPath)) {
    return invalidMetadata(paths.metadata, "selected checkout escapes its cache entry");
  }
  const kind = await options.fileSystem.entryKind(checkoutPath, "follow");
  if (kind.status === "error") {
    return invalidMetadata(paths.metadata, "selected checkout is missing", kind.error);
  }
  if (kind.value !== "directory") {
    return invalidMetadata(paths.metadata, "selected checkout is not a directory");
  }
  const root = await options.fileSystem.realPath(checkoutPath);
  if (root.status === "error") {
    return invalidMetadata(paths.metadata, "selected checkout cannot be canonicalized", root.error);
  }
  return Result.ok({ cacheKey: paths.cacheKey, root: root.value, metadata: metadata.value });
}

/**
 * Ensure or refresh a complete Managed Checkout under its per-entry inter-process lock.
 *
 * `ensure` coalesces with publication by another process after lock acquisition. `refresh` stages
 * from the old checkout and fetches moving refs. Every failure leaves previously published metadata
 * untouched and therefore keeps an old checkout usable. Automatic cached attempts persist their
 * attempt timestamp before network work so a failed refresh participates in cooldown decisions.
 */
export async function publishManagedCheckout(
  options: ManagedCheckoutStorageOptions,
  request: ManagedCheckoutRequest,
  intent: "ensure" | "refresh",
  context: ManagedCheckoutPublicationContext = {}
): Promise<ResultType<ReadyManagedCheckout, ManagedCheckoutStorageError>> {
  const paths = makeEntryPaths(options.cacheRoot, request);
  const observed = await openManagedCheckout(options, request);
  if (observed.status === "error") return observed;

  const prepared = await options.fileSystem.makeDirectory(paths.entry);
  if (prepared.status === "error") return publicationFailure(paths.cacheKey, prepared.error);

  const acquired = await options.locks.acquire(paths.cacheKey);
  if (acquired.status === "error") return acquired;

  const operation = await publishWhileLocked(
    options,
    request,
    paths,
    intent,
    observed.value?.metadata.publicationSequence,
    context.automaticAttemptAt
  );
  const released = await acquired.value.release();
  if (operation.status === "error") return operation;
  return released.status === "error" ? released : operation;
}

/** Perform complete staging and atomic publication while the caller holds the cache-entry lock. */
async function publishWhileLocked(
  options: ManagedCheckoutStorageOptions,
  request: ManagedCheckoutRequest,
  paths: EntryPaths,
  intent: "ensure" | "refresh",
  observedPublicationSequence: number | undefined,
  automaticAttemptAt: Date | undefined
): Promise<ResultType<ReadyManagedCheckout, ManagedCheckoutStorageError>> {
  const current = await openManagedCheckout(options, request);
  if (current.status === "error") return current;
  if (current.value !== undefined && intent === "ensure") return Result.ok(current.value);
  if (
    current.value !== undefined &&
    intent === "refresh" &&
    current.value.metadata.publicationSequence !== observedPublicationSequence
  ) {
    return Result.ok(current.value);
  }

  let selected = current.value;
  if (selected !== undefined && automaticAttemptAt !== undefined) {
    const attemptedMetadata = {
      ...selected.metadata,
      lastAutomaticAttempt: automaticAttemptAt.toISOString(),
    };
    const attemptWritten = await writeCacheMetadata(
      paths.metadata,
      attemptedMetadata,
      `attempt-${randomUUID()}`,
      options.fileSystem
    );
    if (attemptWritten.status === "error") return attemptWritten;
    selected = { ...selected, metadata: attemptedMetadata };
  }

  const stagingParent = join(paths.entry, "staging");
  const checkoutParent = join(paths.entry, "checkouts");
  for (const directory of [stagingParent, checkoutParent]) {
    const created = await options.fileSystem.makeDirectory(directory);
    if (created.status === "error") return publicationFailure(paths.cacheKey, created.error);
  }

  const suffix = options.makeUniqueSuffix?.() ?? randomUUID();
  const stagingPath = join(stagingParent, suffix);
  const staged =
    selected === undefined
      ? await options.git.clone(request.repository, stagingPath)
      : await options.git.prepareRefresh(request.repository, selected.root, stagingPath);
  if (staged.status === "error") {
    await options.fileSystem.remove(stagingPath, "recursive");
    return staged;
  }

  const pinned = selected === undefined ? undefined : makeExistingPin(selected.metadata);
  const revision = await options.git.resolveRevision(
    request.repository,
    stagingPath,
    request.configuredRef,
    pinned,
    selected === undefined ? "origin" : "source"
  );
  if (revision.status === "error") {
    await options.fileSystem.remove(stagingPath, "recursive");
    return revision;
  }

  const checkedOut = await options.git.checkoutDetached(request.repository, stagingPath, revision.value.commit);
  if (checkedOut.status === "error") {
    await options.fileSystem.remove(stagingPath, "recursive");
    return checkedOut;
  }

  const checkoutRelativePath = `checkouts/${revision.value.commit}`;
  const checkoutPath = join(paths.entry, checkoutRelativePath);
  const existing = await options.fileSystem.entryKind(checkoutPath, "follow");
  if (existing.status === "ok") {
    if (existing.value !== "directory") {
      await options.fileSystem.remove(stagingPath, "recursive");
      return publicationFailure(paths.cacheKey, existing.value);
    }
    await options.fileSystem.remove(stagingPath, "recursive");
  } else if (isMissingCause(existing.error.cause)) {
    const published = await options.fileSystem.rename(stagingPath, checkoutPath);
    if (published.status === "error") {
      await options.fileSystem.remove(stagingPath, "recursive");
      return publicationFailure(paths.cacheKey, published.error);
    }
  } else {
    await options.fileSystem.remove(stagingPath, "recursive");
    return publicationFailure(paths.cacheKey, existing.error);
  }

  const root = await options.fileSystem.realPath(checkoutPath);
  if (root.status === "error") return publicationFailure(paths.cacheKey, root.error);

  const now = options.clock.now().toISOString();
  const metadata = makePublishedMetadata(
    request,
    revision.value,
    checkoutRelativePath,
    selected?.metadata,
    now,
    automaticAttemptAt
  );
  const metadataWritten = await writeCacheMetadata(paths.metadata, metadata, suffix, options.fileSystem);
  if (metadataWritten.status === "error") return metadataWritten;
  return Result.ok({ cacheKey: paths.cacheKey, root: root.value, metadata });
}

/** Project old metadata into the optional pin input expected by ref resolution. */
function makeExistingPin(metadata: CacheMetadata) {
  return metadata.pinnedCommit === undefined
    ? { kind: metadata.refKind }
    : { kind: metadata.refKind, pinnedCommit: metadata.pinnedCommit };
}

/** Build metadata while preserving exact optional-property semantics. */
function makePublishedMetadata(
  request: ManagedCheckoutRequest,
  revision: ResolvedManagedRevision,
  checkoutRelativePath: string,
  current: CacheMetadata | undefined,
  now: string,
  automaticAttemptAt: Date | undefined
): CacheMetadata {
  const required = {
    version: 1 as const,
    repositoryIdentity: request.repository.identity,
    configuredRef: request.configuredRef ?? DEFAULT_BRANCH_CACHE_REF,
    refKind: revision.kind,
    resolvedCommit: revision.commit,
    publicationSequence: (current?.publicationSequence ?? 0) + 1,
    currentCheckout: checkoutRelativePath,
    createdAt: current?.createdAt ?? now,
    lastSuccessfulRefresh: now,
  };
  const pin = revision.pinnedCommit;
  const automaticAttempt = automaticAttemptAt?.toISOString() ?? current?.lastAutomaticAttempt;
  if (pin === undefined) {
    return automaticAttempt === undefined ? required : { ...required, lastAutomaticAttempt: automaticAttempt };
  }
  if (automaticAttempt === undefined) return { ...required, pinnedCommit: pin };
  return { ...required, pinnedCommit: pin, lastAutomaticAttempt: automaticAttempt };
}

type EntryPaths = {
  readonly cacheKey: string;
  readonly entry: string;
  readonly metadata: string;
};

/** Derive private cache-entry paths from only credential-free identity material. */
function makeEntryPaths(cacheRoot: string, request: ManagedCheckoutRequest): EntryPaths {
  const cacheKey = makeCacheKey(request.repository, request.configuredRef);
  const entry = join(cacheRoot, "entries", cacheKey);
  return { cacheKey, entry, metadata: join(entry, "metadata.json") };
}

/** Check descendant containment without string-prefix comparisons. */
function isContained(root: string, target: string): boolean {
  const descendant = relative(root, target);
  return descendant === "" || (!descendant.startsWith("..") && !isAbsolute(descendant));
}

/** Construct a malformed cache metadata result. */
function invalidMetadata(
  path: string,
  reason: string,
  cause: CacheMetadataParseError["cause"] = undefined
): ResultType<never, CacheMetadataParseError> {
  return Result.err(
    new CacheMetadataParseError({
      path,
      reason,
      cause,
      message: `Managed Checkout metadata at ${path} is invalid: ${reason}`,
    })
  );
}

/** Construct a staging or atomic checkout publication failure. */
function publicationFailure(
  cacheKey: string,
  cause: RepositoryFileSystemError | string
): ResultType<never, CachePublicationError> {
  return Result.err(
    new CachePublicationError({
      cacheKey,
      cause,
      message: `Could not publish Managed Checkout ${cacheKey}`,
    })
  );
}

/** Return whether a filesystem failure denotes a missing checkout path. */
function isMissingCause(cause: RepositoryFileSystemError["cause"]): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
