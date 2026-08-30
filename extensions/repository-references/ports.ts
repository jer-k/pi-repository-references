import type { Result } from "better-result";

import type {
  CacheLockError,
  GitProcessExecutionError,
  RepositoryFileSystemError,
} from "../repository-reference-errors.ts";

/** Wall-clock access used by refresh policy and cache metadata. */
export type Clock = {
  /** Return the current wall-clock instant. */
  readonly now: () => Date;
};

/** Input for one direct, non-shell Git process execution. */
export type GitProcessRequest = {
  /** Safe operation name used for failure classification. */
  readonly operation: string;
  /** Git arguments, excluding the executable itself. */
  readonly arguments: ReadonlyArray<string>;
  /** Working directory for the process, when required. */
  readonly workingDirectory?: string;
  /** Maximum execution time for this process. */
  readonly timeoutMilliseconds: number;
};

/** Completed Git process output retained inside the Git adapter boundary. */
export type GitProcessOutput = {
  /** Normal process exit status. */
  readonly exitCode: number;
  /** Standard output from Git. */
  readonly standardOutput: string;
  /** Standard error from Git; callers must sanitize it before diagnostics. */
  readonly standardError: string;
  /** Signal that ended the process, when it did not exit normally. */
  readonly signal: string | undefined;
  /** Whether the adapter's timeout ended the process. */
  readonly timedOut: boolean;
};

/** Direct Git execution required by managed checkout operations. */
export type GitProcess = {
  /** Execute Git without shell interpolation and with terminal credential prompts disabled. */
  readonly run: (request: GitProcessRequest) => Promise<Result<GitProcessOutput, GitProcessExecutionError>>;
};

/** An acquired inter-process cache-entry lease. */
export type CacheLockLease = {
  /** Release this lease; repeated release behavior is owned by the lock adapter. */
  readonly release: () => Promise<Result<void, CacheLockError>>;
};

/** Per-cache-entry inter-process serialization required for publication. */
export type CacheLocks = {
  /** Acquire exclusive mutation rights for one credential-free cache key. */
  readonly acquire: (cacheKey: string) => Promise<Result<CacheLockLease, CacheLockError>>;
};

/** Directory entry information needed by repository-reference storage. */
export type RepositoryDirectoryEntry = {
  /** Entry basename. */
  readonly name: string;
  /** Portable entry kind without leaking Node filesystem types into application code. */
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
};

/** Filesystem effects needed by configuration, path, and cache adapters. */
export type RepositoryFileSystem = {
  /** Read a UTF-8 text file. */
  readonly readTextFile: (path: string) => Promise<Result<string, RepositoryFileSystemError>>;
  /** Resolve a path through symbolic links to its canonical filesystem path. */
  readonly realPath: (path: string) => Promise<Result<string, RepositoryFileSystemError>>;
  /** Inspect an entry, optionally following its final symbolic link. */
  readonly entryKind: (
    path: string,
    symbolicLinks: "follow" | "preserve"
  ) => Promise<Result<"file" | "directory" | "symbolic-link" | "other", RepositoryFileSystemError>>;
  /** Create a directory and any absent ancestors. */
  readonly makeDirectory: (path: string) => Promise<Result<void, RepositoryFileSystemError>>;
  /** Write a UTF-8 text file. */
  readonly writeTextFile: (path: string, contents: string) => Promise<Result<void, RepositoryFileSystemError>>;
  /** Atomically rename a filesystem entry where supported by the host filesystem. */
  readonly rename: (sourcePath: string, destinationPath: string) => Promise<Result<void, RepositoryFileSystemError>>;
  /** Remove an entry, with recursive removal available for private staging directories. */
  readonly remove: (path: string, mode: "entry" | "recursive") => Promise<Result<void, RepositoryFileSystemError>>;
  /** List direct children of a directory. */
  readonly readDirectory: (
    path: string
  ) => Promise<Result<ReadonlyArray<RepositoryDirectoryEntry>, RepositoryFileSystemError>>;
};
