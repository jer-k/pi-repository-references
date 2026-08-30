import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";

import { Result, type Result as ResultType } from "better-result";

import { RepositoryFileSystemError } from "../repository-reference-errors.ts";
import type { RepositoryDirectoryEntry, RepositoryFileSystem } from "./ports.ts";

type FileSystemOperation = RepositoryFileSystemError["operation"];

/** Wrap a Node filesystem promise and retain its rejection as a structured cause. */
function tryFileSystem<T>(
  operation: FileSystemOperation,
  path: string,
  effect: () => Promise<T>
): Promise<ResultType<T, RepositoryFileSystemError>> {
  return Result.tryPromise({
    try: effect,
    catch: (cause) =>
      new RepositoryFileSystemError({
        operation,
        path,
        cause,
        message: `Filesystem operation ${operation} failed for ${path}`,
      }),
  });
}

/** Project Node's filesystem metadata into the portable filesystem port. */
function kindOfStats(stats: Stats): RepositoryDirectoryEntry["kind"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symbolic-link";
  return "other";
}

/** Project a Node directory entry into the portable filesystem port. */
function toDirectoryEntry(entry: Dirent): RepositoryDirectoryEntry {
  if (entry.isFile()) return { name: entry.name, kind: "file" };
  if (entry.isDirectory()) return { name: entry.name, kind: "directory" };
  if (entry.isSymbolicLink()) return { name: entry.name, kind: "symbolic-link" };
  return { name: entry.name, kind: "other" };
}

/**
 * Create the concrete filesystem adapter used by repository-reference services.
 *
 * Every expected Node filesystem rejection is returned as a `RepositoryFileSystemError`
 * retaining the original cause.
 */
export function createNodeRepositoryFileSystem(): RepositoryFileSystem {
  return {
    readTextFile: (path) => tryFileSystem("read-file", path, () => readFile(path, "utf8")),
    realPath: (path) => tryFileSystem("realpath", path, () => realpath(path)),
    entryKind: (path, symbolicLinks) =>
      tryFileSystem("stat", path, () => (symbolicLinks === "follow" ? stat(path) : lstat(path))).then(
        Result.map(kindOfStats)
      ),
    makeDirectory: (path) =>
      tryFileSystem("make-directory", path, async () => {
        await mkdir(path, { recursive: true });
      }),
    writeTextFile: (path, contents) => tryFileSystem("write-file", path, () => writeFile(path, contents, "utf8")),
    rename: (sourcePath, destinationPath) =>
      tryFileSystem("rename", `${sourcePath} -> ${destinationPath}`, () => rename(sourcePath, destinationPath)),
    remove: (path, mode) =>
      tryFileSystem("remove", path, () => rm(path, { force: true, recursive: mode === "recursive" })),
    readDirectory: (path) =>
      tryFileSystem("read-directory", path, () => readdir(path, { withFileTypes: true })).then(
        Result.map((entries) => entries.map(toDirectoryEntry))
      ),
  };
}
