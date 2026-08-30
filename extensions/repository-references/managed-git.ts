import { Result, type Result as ResultType } from "better-result";

import {
  GitAuthenticationError,
  GitCloneError,
  GitFetchError,
  GitProcessKilledError,
  GitRefResolutionError,
  GitTimeoutError,
  type GitNetworkOperation,
  type GitProcessExecutionError,
} from "../repository-reference-errors.ts";
import type { ManagedRefKind } from "./cache-metadata.ts";
import type { GitProcess, GitProcessOutput, RepositoryFileSystem } from "./ports.ts";
import type { RepositorySource as ParsedRepositorySource } from "./repository-source.ts";

/** Fixed production deadline for every clone and fetch process. */
export const GIT_NETWORK_TIMEOUT_MILLISECONDS = 60_000;

/** Optional Managed Git adapter settings used to shorten network deadlines in integration tests. */
export type ManagedGitOptions = {
  /** Clone/fetch timeout; production composition uses the fixed 60-second default. */
  readonly networkTimeoutMilliseconds?: number;
};

/** Expected failures from Managed Checkout Git operations. */
export type ManagedGitError =
  | GitProcessExecutionError
  | GitAuthenticationError
  | GitCloneError
  | GitFetchError
  | GitProcessKilledError
  | GitRefResolutionError
  | GitTimeoutError;

/** Resolved commit and future movement semantics for one configured revision. */
export type ResolvedManagedRevision = {
  /** Full commit object ID. */
  readonly commit: string;
  /** Whether future refreshes follow a branch or retain a pin. */
  readonly kind: ManagedRefKind;
  /** Immutable initial commit for tag and commit refs. */
  readonly pinnedCommit?: string;
};

/** Direct Git capabilities used by Managed Checkout storage. */
export type ManagedGit = {
  /** Clone into an unpublished staging directory with transparent partial-clone fallback. */
  readonly clone: (
    repository: ParsedRepositorySource,
    stagingPath: string
  ) => Promise<ResultType<void, ManagedGitError>>;
  /** Copy an old checkout into staging and fetch current remote refs into isolated namespaces. */
  readonly prepareRefresh: (
    repository: ParsedRepositorySource,
    oldCheckout: string,
    stagingPath: string
  ) => Promise<ResultType<void, ManagedGitError>>;
  /** Resolve a configured ref or retain an existing tag/commit pin. */
  readonly resolveRevision: (
    repository: ParsedRepositorySource,
    stagingPath: string,
    configuredRef: string | undefined,
    pinned: Pick<ResolvedManagedRevision, "kind" | "pinnedCommit"> | undefined,
    remoteNamespace: "origin" | "source"
  ) => Promise<ResultType<ResolvedManagedRevision, ManagedGitError>>;
  /** Produce a detached checkout and remove the clone remote containing the source URL. */
  readonly checkoutDetached: (
    repository: ParsedRepositorySource,
    stagingPath: string,
    commit: string
  ) => Promise<ResultType<void, ManagedGitError>>;
};

/**
 * Create the Git adapter for immutable Managed Checkout staging.
 *
 * Network commands are direct process invocations with the production deadline unless a shorter
 * test deadline is injected. Clone-source credentials are removed before publication.
 */
export function createManagedGit(
  process: GitProcess,
  fileSystem: Pick<RepositoryFileSystem, "remove">,
  options: ManagedGitOptions = {}
): ManagedGit {
  const networkTimeoutMilliseconds = options.networkTimeoutMilliseconds ?? GIT_NETWORK_TIMEOUT_MILLISECONDS;
  return {
    clone: async (repository, stagingPath) => {
      const partial = await runNetwork(
        process,
        "clone",
        repository,
        [
          "clone",
          "--no-checkout",
          "--no-recurse-submodules",
          "--filter=blob:none",
          repository.cloneSource,
          stagingPath,
        ],
        networkTimeoutMilliseconds
      );
      if (partial.status === "ok") return Result.ok(undefined);
      if (!isUnsupportedFilter(partial.error)) return partial;

      const removed = await fileSystem.remove(stagingPath, "recursive");
      if (removed.status === "error") {
        return Result.err(
          new GitCloneError({
            repositoryIdentity: repository.identity,
            exitCode: -1,
            diagnostic: "Could not clear partial-clone staging before fallback",
            cause: removed.error,
            message: `Could not retry a normal clone of ${repository.identity}`,
          })
        );
      }
      return runNetwork(
        process,
        "clone",
        repository,
        ["clone", "--no-checkout", "--no-recurse-submodules", repository.cloneSource, stagingPath],
        networkTimeoutMilliseconds
      );
    },
    prepareRefresh: async (repository, oldCheckout, stagingPath) => {
      const copied = await process.run({
        operation: "copy-managed-checkout",
        arguments: ["clone", "--no-checkout", "--no-hardlinks", oldCheckout, stagingPath],
        timeoutMilliseconds: GIT_NETWORK_TIMEOUT_MILLISECONDS,
      });
      if (copied.status === "error") return copied;
      if (copied.value.timedOut) {
        return Result.err(
          new GitTimeoutError({
            operation: "clone",
            repositoryIdentity: repository.identity,
            timeoutMilliseconds: GIT_NETWORK_TIMEOUT_MILLISECONDS,
            cause: safeProcessCause(copied.value),
            message: `Git clone timed out while staging ${repository.identity}`,
          })
        );
      }
      if (copied.value.signal !== undefined) {
        return Result.err(
          new GitProcessKilledError({
            operation: "clone",
            repositoryIdentity: repository.identity,
            signal: copied.value.signal,
            cause: safeProcessCause(copied.value),
            message: `Git clone was killed while staging ${repository.identity}`,
          })
        );
      }
      if (copied.value.exitCode !== 0) {
        return Result.err(
          new GitCloneError({
            repositoryIdentity: repository.identity,
            exitCode: copied.value.exitCode,
            diagnostic: sanitizeDiagnostic(copied.value.standardError, repository.cloneSource),
            cause: safeProcessCause(copied.value),
            message: `Could not stage the current Managed Checkout for ${repository.identity}`,
          })
        );
      }
      return runNetwork(
        process,
        "fetch",
        repository,
        [
          "-C",
          stagingPath,
          "fetch",
          "--force",
          repository.cloneSource,
          "+HEAD:refs/remotes/source/HEAD",
          "+refs/heads/*:refs/remotes/source/*",
          "+refs/tags/*:refs/tags/*",
        ],
        networkTimeoutMilliseconds
      );
    },
    resolveRevision: (repository, stagingPath, configuredRef, pinned, remoteNamespace) =>
      resolveRevision(process, repository, stagingPath, configuredRef, pinned, remoteNamespace),
    checkoutDetached: async (repository, stagingPath, commit) => {
      const checkedOut = await runLocal(process, repository, stagingPath, ["checkout", "--detach", "--force", commit]);
      if (checkedOut.status === "error") return checkedOut;
      const removedRemote = await runLocal(process, repository, stagingPath, ["remote", "remove", "origin"]);
      if (removedRemote.status === "error" && !removedRemote.error.message.includes("No such remote")) {
        return removedRemote;
      }
      return Result.ok(undefined);
    },
  };
}

/** Resolve branch-first configured refs and preserve previously recorded immutable pins. */
async function resolveRevision(
  process: GitProcess,
  repository: ParsedRepositorySource,
  stagingPath: string,
  configuredRef: string | undefined,
  pinned: Pick<ResolvedManagedRevision, "kind" | "pinnedCommit"> | undefined,
  remoteNamespace: "origin" | "source"
): Promise<ResultType<ResolvedManagedRevision, ManagedGitError>> {
  if (pinned?.pinnedCommit !== undefined && (pinned.kind === "tag" || pinned.kind === "commit")) {
    const retained = await revParse(process, repository, stagingPath, `${pinned.pinnedCommit}^{commit}`);
    return retained.status === "error"
      ? retained
      : Result.ok({ commit: retained.value, kind: pinned.kind, pinnedCommit: retained.value });
  }

  if (configuredRef === undefined) {
    const resolved = await revParse(process, repository, stagingPath, `refs/remotes/${remoteNamespace}/HEAD^{commit}`);
    return resolved.status === "error" ? resolved : Result.ok({ commit: resolved.value, kind: "default-branch" });
  }

  const branch = await revParse(
    process,
    repository,
    stagingPath,
    `refs/remotes/${remoteNamespace}/${configuredRef}^{commit}`,
    "probe"
  );
  if (branch.status === "ok") return Result.ok({ commit: branch.value, kind: "branch" });

  const tag = await revParse(process, repository, stagingPath, `refs/tags/${configuredRef}^{commit}`, "probe");
  if (tag.status === "ok") return Result.ok({ commit: tag.value, kind: "tag", pinnedCommit: tag.value });

  const commit = await revParse(process, repository, stagingPath, `${configuredRef}^{commit}`, "probe");
  if (commit.status === "ok") return Result.ok({ commit: commit.value, kind: "commit", pinnedCommit: commit.value });

  return Result.err(
    new GitRefResolutionError({
      repositoryIdentity: repository.identity,
      configuredRef,
      cause: commit.error,
      message: `Could not resolve ref ${configuredRef} in ${repository.identity}`,
    })
  );
}

/** Resolve one revision expression to a full commit ID. */
async function revParse(
  process: GitProcess,
  repository: ParsedRepositorySource,
  stagingPath: string,
  expression: string,
  mode: "required" | "probe" = "required"
): Promise<ResultType<string, ManagedGitError>> {
  const output = await process.run({
    operation: "resolve-managed-ref",
    arguments: ["-C", stagingPath, "rev-parse", "--verify", expression],
    timeoutMilliseconds: GIT_NETWORK_TIMEOUT_MILLISECONDS,
  });
  if (output.status === "error") return output;
  const commit = output.value.standardOutput.trim().toLowerCase();
  if (output.value.exitCode === 0 && /^[0-9a-f]{40,64}$/u.test(commit)) return Result.ok(commit);
  return Result.err(
    new GitRefResolutionError({
      repositoryIdentity: repository.identity,
      configuredRef: expression,
      cause: safeProcessCause(output.value),
      message:
        mode === "probe"
          ? `Revision candidate is unavailable in ${repository.identity}`
          : `Could not resolve revision in ${repository.identity}`,
    })
  );
}

/** Run a non-network staging command and classify unsuccessful completion as ref resolution. */
async function runLocal(
  process: GitProcess,
  repository: ParsedRepositorySource,
  stagingPath: string,
  arguments_: ReadonlyArray<string>
): Promise<ResultType<void, ManagedGitError>> {
  const output = await process.run({
    operation: "prepare-managed-checkout",
    arguments: ["-C", stagingPath, ...arguments_],
    timeoutMilliseconds: GIT_NETWORK_TIMEOUT_MILLISECONDS,
  });
  if (output.status === "error") return output;
  if (output.value.exitCode === 0) return Result.ok(undefined);
  return Result.err(
    new GitRefResolutionError({
      repositoryIdentity: repository.identity,
      configuredRef: "resolved commit",
      cause: safeProcessCause(output.value),
      message: `Could not prepare detached checkout for ${repository.identity}`,
    })
  );
}

/** Run and classify one clone or fetch without exposing its credential-bearing source. */
async function runNetwork(
  process: GitProcess,
  operation: GitNetworkOperation,
  repository: ParsedRepositorySource,
  arguments_: ReadonlyArray<string>,
  timeoutMilliseconds: number
): Promise<ResultType<void, ManagedGitError>> {
  const output = await process.run({
    operation,
    arguments: arguments_,
    timeoutMilliseconds,
  });
  if (output.status === "error") return output;
  if (output.value.timedOut) {
    return Result.err(
      new GitTimeoutError({
        operation,
        repositoryIdentity: repository.identity,
        timeoutMilliseconds,
        cause: safeProcessCause(output.value),
        message: `Git ${operation} timed out for ${repository.identity}; reproduce with normal git ${operation}`,
      })
    );
  }
  if (output.value.signal !== undefined) {
    return Result.err(
      new GitProcessKilledError({
        operation,
        repositoryIdentity: repository.identity,
        signal: output.value.signal,
        cause: safeProcessCause(output.value),
        message: `Git ${operation} was killed for ${repository.identity}`,
      })
    );
  }
  if (output.value.exitCode === 0) return Result.ok(undefined);

  const diagnostic = sanitizeDiagnostic(output.value.standardError, repository.cloneSource);
  if (isAuthenticationDiagnostic(output.value.standardError)) {
    return Result.err(
      new GitAuthenticationError({
        operation,
        repositoryIdentity: repository.identity,
        diagnostic,
        cause: safeProcessCause(output.value),
        message: `Git ${operation} authentication failed for ${repository.identity}; reproduce with normal git ${operation} to diagnose credentials`,
      })
    );
  }
  const ErrorType = operation === "clone" ? GitCloneError : GitFetchError;
  return Result.err(
    new ErrorType({
      repositoryIdentity: repository.identity,
      exitCode: output.value.exitCode,
      diagnostic,
      cause: safeProcessCause(output.value),
      message: `Git ${operation} failed for ${repository.identity}; reproduce with normal git ${operation}`,
    })
  );
}

/** Identify the narrow diagnostics that justify retrying without partial-clone filtering. */
function isUnsupportedFilter(error: ManagedGitError): boolean {
  if (error._tag !== "GitCloneError") return false;
  return /(?:filtering .*not recognized|does not support.*filter|unknown option.*filter|invalid filter-spec)/iu.test(
    error.diagnostic
  );
}

/** Identify common HTTPS and SSH authentication failures. */
function isAuthenticationDiagnostic(diagnostic: string): boolean {
  return /(?:authentication failed|could not read username|permission denied \(publickey|access denied|repository not found)/iu.test(
    diagnostic
  );
}

/** Remove configured source strings and URL userinfo from a bounded Git diagnostic. */
function sanitizeDiagnostic(diagnostic: string, cloneSource: string): string {
  return diagnostic
    .replaceAll(cloneSource, "<repository>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1<credentials>@")
    .slice(0, 2_000)
    .trim();
}

/** Retain process classification without retaining stdout, stderr, or argument values. */
function safeProcessCause(output: GitProcessOutput) {
  return { exitCode: output.exitCode, signal: output.signal, timedOut: output.timedOut };
}
