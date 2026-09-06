import { Result, type Result as ResultType } from "better-result";

import { IndexConstructionError, InvalidLocalReferenceError } from "../repository-reference-errors.ts";
import type { Alias } from "./alias.ts";
import type { GitProcess, RepositoryFileSystem } from "./ports.ts";
import { buildReferenceIndex, type ReferenceIndex } from "./reference-index.ts";

/** A validated Local Reference rooted at a canonical non-bare Git working tree. */
export type ReadyLocalReference = {
  readonly _tag: "ready-local";
  readonly alias: Alias;
  readonly root: string;
  readonly index: ReferenceIndex;
};

/** Expected Local Reference validation and indexing failures. */
export type LocalReferenceError = InvalidLocalReferenceError | IndexConstructionError;

/** Inputs required to validate and index one Local Reference. */
export type OpenLocalReferenceOptions = {
  readonly alias: Alias;
  readonly configuredPath: string;
  readonly fileSystem: Pick<RepositoryFileSystem, "realPath" | "entryKind">;
  readonly git: GitProcess;
};

/**
 * Validate a configured path as an exact non-bare Git working-tree root and build its visible index.
 *
 * This operation executes only read-oriented Git commands and never changes working-tree state.
 */
export async function openLocalReference(
  options: OpenLocalReferenceOptions
): Promise<ResultType<ReadyLocalReference, LocalReferenceError>> {
  const canonicalPath = await options.fileSystem.realPath(options.configuredPath);
  if (canonicalPath.status === "error") {
    return invalidLocal(
      options,
      isMissingCause(canonicalPath.error.cause) ? "missing" : "unavailable",
      canonicalPath.error.cause
    );
  }

  const kind = await options.fileSystem.entryKind(canonicalPath.value, "follow");
  if (kind.status === "error") {
    return invalidLocal(options, "unavailable", kind.error.cause);
  }
  if (kind.value !== "directory") {
    return invalidLocal(options, "not-directory", undefined);
  }

  const inside = await runGit(options, canonicalPath.value, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status === "error") {
    return inside;
  }
  if (inside.value.exitCode !== 0 || inside.value.standardOutput.trim() !== "true") {
    return invalidLocal(options, "not-git-working-tree", gitFailureCause(inside.value));
  }

  const bare = await runGit(options, canonicalPath.value, ["rev-parse", "--is-bare-repository"]);
  if (bare.status === "error") {
    return bare;
  }
  if (bare.value.exitCode !== 0 || bare.value.standardOutput.trim() === "true") {
    return invalidLocal(options, "bare-repository", gitFailureCause(bare.value));
  }

  const topLevel = await runGit(options, canonicalPath.value, ["rev-parse", "--show-toplevel"]);
  if (topLevel.status === "error") {
    return topLevel;
  }
  if (topLevel.value.exitCode !== 0) {
    return invalidLocal(options, "not-git-working-tree", gitFailureCause(topLevel.value));
  }
  const canonicalTopLevel = await options.fileSystem.realPath(topLevel.value.standardOutput.trim());
  if (canonicalTopLevel.status === "error") {
    return invalidLocal(options, "unavailable", canonicalTopLevel.error.cause);
  }
  if (canonicalTopLevel.value !== canonicalPath.value) {
    return invalidLocal(options, "not-working-tree-root", undefined);
  }

  const indexed = await options.git.run({
    operation: "index-local-reference",
    arguments: ["-C", canonicalPath.value, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    timeoutMilliseconds: 30_000,
  });
  if (indexed.status === "error" || indexed.value.exitCode !== 0 || indexed.value.timedOut) {
    const cause = indexed.status === "error" ? indexed.error : gitFailureCause(indexed.value);
    return Result.err(
      new IndexConstructionError({
        alias: options.alias,
        root: canonicalPath.value,
        cause,
        message: `Could not index Local Reference @${options.alias}`,
      })
    );
  }

  return Result.ok({
    _tag: "ready-local",
    alias: options.alias,
    root: canonicalPath.value,
    index: buildReferenceIndex(indexed.value.standardOutput),
  });
}

/** Execute one read-only local Git inspection and map launch failure. */
async function runGit(
  options: OpenLocalReferenceOptions,
  root: string,
  arguments_: ReadonlyArray<string>
): Promise<ResultType<import("./ports.ts").GitProcessOutput, InvalidLocalReferenceError>> {
  const output = await options.git.run({
    operation: "validate-local-reference",
    arguments: ["-C", root, ...arguments_],
    timeoutMilliseconds: 30_000,
  });
  return output.status === "error" ? invalidLocal(options, "unavailable", output.error) : Result.ok(output.value);
}

/** Construct a tagged Local Reference validation failure. */
function invalidLocal(
  options: OpenLocalReferenceOptions,
  reason: InvalidLocalReferenceError["reason"],
  cause: unknown
): ResultType<never, InvalidLocalReferenceError> {
  return Result.err(
    new InvalidLocalReferenceError({
      alias: options.alias,
      path: options.configuredPath,
      reason,
      cause,
      message: `Invalid Local Reference @${options.alias}: ${reason}`,
    })
  );
}

/** Preserve a non-zero Git completion as a safe structured cause. */
function gitFailureCause(output: import("./ports.ts").GitProcessOutput) {
  return {
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    signal: output.signal,
    diagnostic: output.standardError.trim(),
  };
}

/** Return whether a filesystem adapter cause denotes an absent path. */
function isMissingCause(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
