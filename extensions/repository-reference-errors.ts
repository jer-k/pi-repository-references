import { TaggedError } from "better-result";

/** Operation names that are safe to include in Git diagnostics. */
export type GitNetworkOperation = "clone" | "fetch";

/** Failure to read a repository-reference configuration file. */
export class ConfigurationReadError extends TaggedError("ConfigurationReadError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Failure to parse a repository-reference configuration file as JSON. */
export class ConfigurationJsonParseError extends TaggedError("ConfigurationJsonParseError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A configuration document uses a version this extension does not support. */
export class UnsupportedConfigurationVersionError extends TaggedError("UnsupportedConfigurationVersionError")<{
  readonly path: string;
  readonly actualVersion: string;
  readonly message: string;
}> {}

/** A configuration document does not satisfy the supported schema. */
export class ConfigurationValidationError extends TaggedError("ConfigurationValidationError")<{
  readonly path: string;
  readonly issuePath: string;
  readonly reason: string;
  readonly message: string;
}> {}

/** A configured Local Reference is not a usable non-bare Git working-tree root. */
export class InvalidLocalReferenceError extends TaggedError("InvalidLocalReferenceError")<{
  readonly alias: string;
  readonly path: string;
  readonly reason:
    | "missing"
    | "not-directory"
    | "not-git-working-tree"
    | "bare-repository"
    | "not-working-tree-root"
    | "unavailable";
  readonly cause: unknown;
  readonly message: string;
}> {}

/** An Alias does not satisfy the configured Alias grammar. */
export class InvalidAliasError extends TaggedError("InvalidAliasError")<{
  readonly input: string;
  readonly message: string;
}> {}

/** A TTL duration is not a supported positive duration literal. */
export class InvalidDurationError extends TaggedError("InvalidDurationError")<{
  readonly input: string;
  readonly message: string;
}> {}

/** A Refresh Policy is malformed or has fields invalid for its selected policy. */
export class InvalidRefreshPolicyError extends TaggedError("InvalidRefreshPolicyError")<{
  readonly issuePath: string;
  readonly reason: string;
  readonly message: string;
}> {}

/** An Alias path mention has invalid syntax. */
export class InvalidReferencePathError extends TaggedError("InvalidReferencePathError")<{
  readonly input: string;
  readonly reason: "invalid-quoting" | "empty-path-segment" | "lexical-traversal";
  readonly message: string;
}> {}

/** A known Alias cannot currently be resolved to an available repository root. */
export class ReferenceUnavailableError extends TaggedError("ReferenceUnavailableError")<{
  readonly alias: string;
  readonly reason: string;
  readonly message: string;
}> {}

/** A physical tool path cannot be normalized to the target Pi will use. */
export class PhysicalPathResolutionError extends TaggedError("PhysicalPathResolutionError")<{
  readonly requestedPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** An Alias descendant resolves outside its repository root. */
export class ReferencePathEscapeError extends TaggedError("ReferencePathEscapeError")<{
  readonly alias: string;
  readonly requestedPath: string;
  readonly root: string;
  readonly message: string;
}> {}

/** A filesystem failure prevented containment-safe Alias path resolution. */
export class ReferencePathResolutionError extends TaggedError("ReferencePathResolutionError")<{
  readonly alias: string;
  readonly requestedPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A configured repository source is unsupported or ambiguous. */
export class RepositorySourceParseError extends TaggedError("RepositorySourceParseError")<{
  readonly reason: string;
  readonly cause?: unknown;
  readonly message: string;
}> {}

/** Git could not start or otherwise failed before returning a normal exit status. */
export class GitProcessExecutionError extends TaggedError("GitProcessExecutionError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** An initial Git clone exited unsuccessfully. */
export class GitCloneError extends TaggedError("GitCloneError")<{
  readonly repositoryIdentity: string;
  readonly exitCode: number;
  readonly diagnostic: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A Git fetch exited unsuccessfully. */
export class GitFetchError extends TaggedError("GitFetchError")<{
  readonly repositoryIdentity: string;
  readonly exitCode: number;
  readonly diagnostic: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Git could not resolve the configured branch, tag, commit, or default branch. */
export class GitRefResolutionError extends TaggedError("GitRefResolutionError")<{
  readonly repositoryIdentity: string;
  readonly configuredRef: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Git authentication failed without exposing the configured credential-bearing source. */
export class GitAuthenticationError extends TaggedError("GitAuthenticationError")<{
  readonly operation: GitNetworkOperation;
  readonly repositoryIdentity: string;
  readonly diagnostic: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A clone or fetch exceeded its configured process timeout. */
export class GitTimeoutError extends TaggedError("GitTimeoutError")<{
  readonly operation: GitNetworkOperation;
  readonly repositoryIdentity: string;
  readonly timeoutMilliseconds: number;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A Git process was killed for a reason other than the extension timeout. */
export class GitProcessKilledError extends TaggedError("GitProcessKilledError")<{
  readonly operation: string;
  readonly repositoryIdentity: string;
  readonly signal: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A cache entry's inter-process lock could not be acquired or released. */
export class CacheLockError extends TaggedError("CacheLockError")<{
  readonly cacheKey: string;
  readonly operation: "acquire" | "release";
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Cache metadata could not be read. */
export class CacheMetadataReadError extends TaggedError("CacheMetadataReadError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Cache metadata is malformed or has an unsupported version. */
export class CacheMetadataParseError extends TaggedError("CacheMetadataParseError")<{
  readonly path: string;
  readonly reason: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Cache metadata could not be atomically persisted. */
export class CacheMetadataWriteError extends TaggedError("CacheMetadataWriteError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A complete staging checkout could not be atomically published. */
export class CachePublicationError extends TaggedError("CachePublicationError")<{
  readonly cacheKey: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A missing Managed Checkout cannot be materialized while Pi is offline. */
export class OfflineMaterializationError extends TaggedError("OfflineMaterializationError")<{
  readonly alias: string;
  readonly message: string;
}> {}

/** A repository's file and directory index could not be constructed. */
export class IndexConstructionError extends TaggedError("IndexConstructionError")<{
  readonly alias: string;
  readonly root: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A concrete filesystem operation failed. */
export class RepositoryFileSystemError extends TaggedError("RepositoryFileSystemError")<{
  readonly operation:
    | "read-file"
    | "realpath"
    | "stat"
    | "make-directory"
    | "write-file"
    | "rename"
    | "remove"
    | "read-directory";
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Every expected failure that may reach the Pi integration boundary. */
export type RepositoryReferenceError =
  | ConfigurationReadError
  | ConfigurationJsonParseError
  | UnsupportedConfigurationVersionError
  | ConfigurationValidationError
  | InvalidLocalReferenceError
  | InvalidAliasError
  | InvalidDurationError
  | InvalidRefreshPolicyError
  | InvalidReferencePathError
  | PhysicalPathResolutionError
  | ReferenceUnavailableError
  | ReferencePathEscapeError
  | ReferencePathResolutionError
  | RepositorySourceParseError
  | GitProcessExecutionError
  | GitCloneError
  | GitFetchError
  | GitRefResolutionError
  | GitAuthenticationError
  | GitTimeoutError
  | GitProcessKilledError
  | CacheLockError
  | CacheMetadataReadError
  | CacheMetadataParseError
  | CacheMetadataWriteError
  | CachePublicationError
  | OfflineMaterializationError
  | IndexConstructionError
  | RepositoryFileSystemError;

/**
 * Translate a structured repository-reference failure to Pi's exception-based tool boundary.
 *
 * UI handlers should render or notify the error instead of using this boundary.
 *
 * @param error - The expected failure that Pi must receive as a thrown tool error.
 * @throws The supplied structured error, unchanged.
 */
export function throwRepositoryReferenceError(error: RepositoryReferenceError): never {
  throw error;
}
