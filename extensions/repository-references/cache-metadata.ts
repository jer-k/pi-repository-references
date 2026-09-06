import { Result, type Result as ResultType } from "better-result";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  CacheMetadataParseError,
  CacheMetadataReadError,
  CacheMetadataWriteError,
  type RepositoryFileSystemError,
} from "../repository-reference-errors.ts";
import type { RepositoryFileSystem } from "./ports.ts";

const COMMIT_PATTERN = "^[0-9a-f]{40,64}$";
const INSTANT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const metadataSchema = Type.Object(
  {
    version: Type.Literal(1),
    repositoryIdentity: Type.String({ minLength: 1 }),
    configuredRef: Type.String({ minLength: 1 }),
    refKind: Type.Union([
      Type.Literal("default-branch"),
      Type.Literal("branch"),
      Type.Literal("tag"),
      Type.Literal("commit"),
    ]),
    resolvedCommit: Type.String({ pattern: COMMIT_PATTERN }),
    publicationSequence: Type.Integer({ minimum: 1 }),
    pinnedCommit: Type.Optional(Type.String({ pattern: COMMIT_PATTERN })),
    currentCheckout: Type.String({ pattern: `^checkouts/[0-9a-f]{40,64}$` }),
    createdAt: Type.String({ pattern: INSTANT_PATTERN }),
    lastSuccessfulRefresh: Type.String({ pattern: INSTANT_PATTERN }),
    lastAutomaticAttempt: Type.Optional(Type.String({ pattern: INSTANT_PATTERN })),
  },
  { additionalProperties: false }
);

/** The revision behavior recorded for a Managed Checkout. */
export type ManagedRefKind = "default-branch" | "branch" | "tag" | "commit";

/** Validated durable state selecting the current immutable Managed Checkout. */
export type CacheMetadata = {
  /** Metadata format version. */
  readonly version: 1;
  /** Credential-free normalized repository identity. */
  readonly repositoryIdentity: string;
  /** Configured ref or explicit default-branch sentinel. */
  readonly configuredRef: string;
  /** How future refreshes treat the selected revision. */
  readonly refKind: ManagedRefKind;
  /** Commit exposed by the current published checkout. */
  readonly resolvedCommit: string;
  /** Monotonic entry-local publication number used to coalesce lock waiters. */
  readonly publicationSequence: number;
  /** Initially selected immutable revision for tags and commits. */
  readonly pinnedCommit?: string;
  /** Entry-relative path to the published checkout. */
  readonly currentCheckout: string;
  /** ISO timestamp of initial metadata creation. */
  readonly createdAt: string;
  /** ISO timestamp of the most recent successful clone or refresh. */
  readonly lastSuccessfulRefresh: string;
  /** ISO timestamp of the most recent automatic attempt, when recorded by orchestration. */
  readonly lastAutomaticAttempt?: string;
};

/**
 * Read and parse cache metadata, returning `undefined` when no metadata has been published.
 */
export async function readCacheMetadata(
  path: string,
  fileSystem: Pick<RepositoryFileSystem, "readTextFile">
): Promise<ResultType<CacheMetadata | undefined, CacheMetadataReadError | CacheMetadataParseError>> {
  const read = await fileSystem.readTextFile(path);
  if (read.status === "error") {
    if (isMissingCause(read.error.cause)) {
      return Result.ok(undefined);
    }
    return Result.err(
      new CacheMetadataReadError({
        path,
        cause: read.error,
        message: `Could not read Managed Checkout metadata at ${path}`,
      })
    );
  }

  const decoded = Result.try({
    try: () => JSON.parse(read.value),
    catch: (cause) =>
      new CacheMetadataParseError({
        path,
        reason: "invalid JSON",
        cause,
        message: `Managed Checkout metadata at ${path} is not valid JSON`,
      }),
  });
  if (decoded.status === "error") {
    return decoded;
  }
  if (!Value.Check(metadataSchema, decoded.value)) {
    const issue = [...Value.Errors(metadataSchema, decoded.value)][0];
    return Result.err(
      new CacheMetadataParseError({
        path,
        reason: issue?.message ?? "schema validation failed",
        cause: issue,
        message: `Managed Checkout metadata at ${path} is invalid`,
      })
    );
  }
  if (!hasValidPinCombination(decoded.value)) {
    return Result.err(
      new CacheMetadataParseError({
        path,
        reason: "pinnedCommit must exist only for tag and commit refs",
        cause: undefined,
        message: `Managed Checkout metadata at ${path} has inconsistent ref state`,
      })
    );
  }
  return Result.ok(decoded.value);
}

/**
 * Persist metadata through a sibling temporary file and atomic rename.
 *
 * The previous metadata remains selected when writing or publication fails.
 */
export async function writeCacheMetadata(
  path: string,
  metadata: CacheMetadata,
  temporarySuffix: string,
  fileSystem: Pick<RepositoryFileSystem, "writeTextFile" | "rename" | "remove">
): Promise<ResultType<void, CacheMetadataWriteError>> {
  const temporaryPath = `${path}.${temporarySuffix}.tmp`;
  const written = await fileSystem.writeTextFile(temporaryPath, `${JSON.stringify(metadata, undefined, 2)}\n`);
  if (written.status === "error") {
    return metadataWriteFailure(path, written.error);
  }

  const renamed = await fileSystem.rename(temporaryPath, path);
  if (renamed.status === "error") {
    await fileSystem.remove(temporaryPath, "entry");
    return metadataWriteFailure(path, renamed.error);
  }
  return Result.ok(undefined);
}

/** Return whether metadata's optional pin agrees with the resolved ref kind. */
function hasValidPinCombination(metadata: CacheMetadata): boolean {
  const immutable = metadata.refKind === "tag" || metadata.refKind === "commit";
  return immutable ? metadata.pinnedCommit === metadata.resolvedCommit : metadata.pinnedCommit === undefined;
}

/** Construct an atomic metadata persistence failure. */
function metadataWriteFailure(
  path: string,
  cause: RepositoryFileSystemError
): ResultType<never, CacheMetadataWriteError> {
  return Result.err(
    new CacheMetadataWriteError({
      path,
      cause,
      message: `Could not publish Managed Checkout metadata at ${path}`,
    })
  );
}

/** Return whether a filesystem failure denotes an absent metadata file. */
function isMissingCause(cause: RepositoryFileSystemError["cause"]): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
