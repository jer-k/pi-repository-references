import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Result } from "better-result";
import { afterEach, describe, expect, test } from "vitest";

import { RepositoryFileSystemError } from "../extensions/repository-reference-errors.ts";
import { makeCacheKey } from "../extensions/repository-references/cache-identity.ts";
import { createProperCacheLocks } from "../extensions/repository-references/cache-locks.ts";
import { readCacheMetadata } from "../extensions/repository-references/cache-metadata.ts";
import { createNodeGitProcess } from "../extensions/repository-references/git-process.ts";
import {
  openManagedCheckout,
  publishManagedCheckout,
  type ManagedCheckoutStorageOptions,
} from "../extensions/repository-references/managed-checkout-storage.ts";
import { createManagedGit, GIT_NETWORK_TIMEOUT_MILLISECONDS } from "../extensions/repository-references/managed-git.ts";
import { createNodeRepositoryFileSystem } from "../extensions/repository-references/node-file-system.ts";
import type { GitProcess, GitProcessOutput, RepositoryFileSystem } from "../extensions/repository-references/ports.ts";
import {
  parseRepositorySource,
  type RepositoryCloneSource,
  type RepositorySource,
} from "../extensions/repository-references/repository-source.ts";
import { testCast } from "./test-cast.ts";

const executeFile = promisify(execFile);
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Managed Checkout publication", () => {
  test("materializes default, branch, tag, and commit refs as detached checkouts", async () => {
    const fixture = await createRemoteFixture();
    const storage = createStorage(fixture.workspace);
    const initialMain = await revision(fixture.work, "main");
    const feature = await revision(fixture.work, "feature");

    const defaultCheckout = await publishManagedCheckout(
      storage,
      { repository: fixture.repository, configuredRef: undefined },
      "ensure"
    );
    const branchCheckout = await publishManagedCheckout(
      storage,
      { repository: fixture.repository, configuredRef: "feature" },
      "ensure"
    );
    const tagCheckout = await publishManagedCheckout(
      storage,
      { repository: fixture.repository, configuredRef: "v1" },
      "ensure"
    );
    const commitCheckout = await publishManagedCheckout(
      storage,
      { repository: fixture.repository, configuredRef: initialMain },
      "ensure"
    );

    expect(defaultCheckout.status).toBe("ok");
    expect(branchCheckout.status).toBe("ok");
    expect(tagCheckout.status).toBe("ok");
    expect(commitCheckout.status).toBe("ok");
    if (
      defaultCheckout.status === "ok" &&
      branchCheckout.status === "ok" &&
      tagCheckout.status === "ok" &&
      commitCheckout.status === "ok"
    ) {
      expect(defaultCheckout.value.metadata.resolvedCommit).toBe(initialMain);
      expect(defaultCheckout.value.metadata.refKind).toBe("default-branch");
      expect(branchCheckout.value.metadata.resolvedCommit).toBe(feature);
      expect(branchCheckout.value.metadata.refKind).toBe("branch");
      expect(tagCheckout.value.metadata.pinnedCommit).toBe(initialMain);
      expect(commitCheckout.value.metadata.pinnedCommit).toBe(initialMain);
      for (const checkout of [defaultCheckout, branchCheckout, tagCheckout, commitCheckout]) {
        expect(await revision(checkout.value.root, "HEAD")).toBe(checkout.value.metadata.resolvedCommit);
        expect((await gitOutput(checkout.value.root, "symbolic-ref", "-q", "HEAD")).trim()).toBe("");
        expect((await gitOutput(checkout.value.root, "remote")).trim()).toBe("");
      }
    }
  }, 15_000);

  test("follows moving branches while tags and commits remain pinned", async () => {
    const fixture = await createRemoteFixture();
    const storage = createStorage(fixture.workspace);
    const initialMain = await revision(fixture.work, "main");
    const defaultRequest = { repository: fixture.repository, configuredRef: undefined };
    const tagRequest = { repository: fixture.repository, configuredRef: "v1" };
    const commitRequest = { repository: fixture.repository, configuredRef: initialMain };
    const initialDefault = await publishManagedCheckout(storage, defaultRequest, "ensure");
    const initialTag = await publishManagedCheckout(storage, tagRequest, "ensure");
    const initialCommit = await publishManagedCheckout(storage, commitRequest, "ensure");
    expect(initialDefault.status).toBe("ok");
    expect(initialTag.status).toBe("ok");
    expect(initialCommit.status).toBe("ok");

    await git(fixture.work, "checkout", "main");
    await writeFile(join(fixture.work, "main.txt"), "main two\n");
    await git(fixture.work, "add", ".");
    await git(fixture.work, "commit", "-m", "main two");
    const movedMain = await revision(fixture.work, "HEAD");
    await git(fixture.work, "tag", "-f", "v1");
    await git(fixture.work, "push", "origin", "main");
    await git(fixture.work, "push", "--force", "origin", "refs/tags/v1");

    const refreshedDefault = await publishManagedCheckout(storage, defaultRequest, "refresh");
    const refreshedTag = await publishManagedCheckout(storage, tagRequest, "refresh");
    const refreshedCommit = await publishManagedCheckout(storage, commitRequest, "refresh");

    expect(refreshedDefault).toMatchObject({
      status: "ok",
      value: { metadata: { resolvedCommit: movedMain } },
    });
    expect(refreshedTag).toMatchObject({
      status: "ok",
      value: { metadata: { resolvedCommit: initialMain, pinnedCommit: initialMain } },
    });
    expect(refreshedCommit).toMatchObject({
      status: "ok",
      value: { metadata: { resolvedCommit: initialMain, pinnedCommit: initialMain } },
    });
  }, 15_000);

  test("coalesces concurrent initial publication through the shared cache entry", async () => {
    const fixture = await createRemoteFixture();
    const storage = createStorage(fixture.workspace);
    const request = { repository: fixture.repository, configuredRef: undefined };

    const [left, right] = await Promise.all([
      publishManagedCheckout(storage, request, "ensure"),
      publishManagedCheckout(storage, request, "ensure"),
    ]);

    expect(left.status).toBe("ok");
    expect(right.status).toBe("ok");
    if (left.status === "ok" && right.status === "ok") {
      expect(left.value.cacheKey).toBe(right.value.cacheKey);
      expect(left.value.root).toBe(right.value.root);
    }
  });

  test("recreates a deleted disposable cache root on demand", async () => {
    const fixture = await createRemoteFixture();
    const storage = createStorage(fixture.workspace);
    const request = { repository: fixture.repository, configuredRef: undefined };
    const initial = await publishManagedCheckout(storage, request, "ensure");
    if (initial.status === "error") throw initial.error;
    await rm(storage.cacheRoot, { recursive: true, force: true });

    const recreated = await publishManagedCheckout(storage, request, "ensure");

    expect(recreated).toMatchObject({
      status: "ok",
      value: { cacheKey: initial.value.cacheKey, metadata: { resolvedCommit: initial.value.metadata.resolvedCommit } },
    });
  }, 10_000);

  test("persists a failed automatic attempt while keeping old metadata usable", async () => {
    const fixture = await createRemoteFixture();
    const storage = createStorage(fixture.workspace);
    const request = { repository: fixture.repository, configuredRef: undefined };
    const initial = await publishManagedCheckout(storage, request, "ensure");
    if (initial.status === "error") throw initial.error;
    await rename(fixture.bare, `${fixture.bare}.unavailable`);

    const attemptedAt = new Date("2026-02-03T04:05:06.000Z");
    const refreshed = await publishManagedCheckout(storage, request, "refresh", {
      automaticAttemptAt: attemptedAt,
    });
    const reopened = await openManagedCheckout(storage, request);

    expect(refreshed.status).toBe("error");
    expect(reopened).toMatchObject({
      status: "ok",
      value: {
        root: initial.value.root,
        metadata: {
          resolvedCommit: initial.value.metadata.resolvedCommit,
          lastAutomaticAttempt: attemptedAt.toISOString(),
        },
      },
    });
  });

  test("leaves the old checkout selected after a failed refresh", async () => {
    const fixture = await createRemoteFixture();
    const storage = createStorage(fixture.workspace);
    const request = { repository: fixture.repository, configuredRef: undefined };
    const initial = await publishManagedCheckout(storage, request, "ensure");
    if (initial.status === "error") throw initial.error;
    const unavailableRemote = `${fixture.bare}.unavailable`;
    await rename(fixture.bare, unavailableRemote);

    const refreshed = await publishManagedCheckout(storage, request, "refresh");
    const reopened = await openManagedCheckout(storage, request);

    expect(refreshed.status).toBe("error");
    if (refreshed.status === "error") expect(refreshed.error._tag).toBe("GitFetchError");
    expect(reopened).toMatchObject({
      status: "ok",
      value: { root: initial.value.root, metadata: { resolvedCommit: initial.value.metadata.resolvedCommit } },
    });
  });

  test("preserves old metadata when atomic metadata publication fails", async () => {
    const fixture = await createRemoteFixture();
    const storage = createStorage(fixture.workspace);
    const request = { repository: fixture.repository, configuredRef: undefined };
    const initial = await publishManagedCheckout(storage, request, "ensure");
    if (initial.status === "error") throw initial.error;
    await git(fixture.work, "checkout", "main");
    await writeFile(join(fixture.work, "main.txt"), "main changed\n");
    await git(fixture.work, "add", ".");
    await git(fixture.work, "commit", "-m", "main changed");
    await git(fixture.work, "push", "origin", "main");

    const publicationCause = new Error("atomic rename denied");
    const failingFileSystem: RepositoryFileSystem = {
      ...storage.fileSystem,
      rename: async (sourcePath, destinationPath) => {
        if (!destinationPath.endsWith("metadata.json")) {
          return storage.fileSystem.rename(sourcePath, destinationPath);
        }
        return Result.err(
          new RepositoryFileSystemError({
            operation: "rename",
            path: destinationPath,
            cause: publicationCause,
            message: "atomic rename denied",
          })
        );
      },
    };
    const failedStorage: ManagedCheckoutStorageOptions = {
      ...storage,
      fileSystem: failingFileSystem,
      git: createManagedGit(createNodeGitProcess(), failingFileSystem),
    };

    const refreshed = await publishManagedCheckout(failedStorage, request, "refresh");
    const reopened = await openManagedCheckout(storage, request);

    expect(refreshed.status).toBe("error");
    if (refreshed.status === "error") expect(refreshed.error._tag).toBe("CacheMetadataWriteError");
    expect(reopened).toMatchObject({
      status: "ok",
      value: { root: initial.value.root, metadata: { resolvedCommit: initial.value.metadata.resolvedCommit } },
    });
  });

  test("returns a ref error without exposing an incomplete initial clone", async () => {
    const fixture = await createRemoteFixture();
    const storage = createStorage(fixture.workspace);
    const request = { repository: fixture.repository, configuredRef: "does-not-exist" };

    const published = await publishManagedCheckout(storage, request, "ensure");
    const opened = await openManagedCheckout(storage, request);

    expect(published.status).toBe("error");
    if (published.status === "error") expect(published.error._tag).toBe("GitRefResolutionError");
    expect(opened).toEqual({ status: "ok", value: undefined });
  });
});

describe("Managed Git failure classification", () => {
  test("falls back to a normal clone only for unsupported partial filtering", async () => {
    const requests: Array<ReadonlyArray<string>> = [];
    const process: GitProcess = {
      run: async (request) => {
        requests.push(request.arguments);
        return requests.length === 1
          ? Result.ok(output(128, "fatal: filtering is not recognized by server"))
          : Result.ok(output(0));
      },
    };
    const removed: Array<string> = [];
    const managedGit = createManagedGit(process, {
      remove: async (path) => {
        removed.push(path);
        return Result.ok(undefined);
      },
    });
    const repository = remoteSource("/tmp/unused.git");

    const result = await managedGit.clone(repository, "/tmp/staging");

    expect(result.status).toBe("ok");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("--filter=blob:none");
    expect(requests[1]).not.toContain("--filter=blob:none");
    expect(removed).toEqual(["/tmp/staging"]);
  });

  test("classifies authentication, timeout, and killed clone failures without credentials", async () => {
    const credentialSource = parseRepositorySource("https://token@example.com/owner/repo.git");
    if (credentialSource.status === "error") throw credentialSource.error;
    const cases = [
      {
        processOutput: output(128, "fatal: Authentication failed for 'https://token@example.com/owner/repo.git'"),
        tag: "GitAuthenticationError",
      },
      { processOutput: { ...output(-1), timedOut: true, signal: "SIGTERM" }, tag: "GitTimeoutError" },
      { processOutput: { ...output(-1), signal: "SIGKILL" }, tag: "GitProcessKilledError" },
    ];

    for (const failure of cases) {
      const process: GitProcess = { run: async () => Result.ok(failure.processOutput) };
      const managedGit = createManagedGit(process, {
        remove: async () => Result.ok(undefined),
      });
      const result = await managedGit.clone(credentialSource.value, "/tmp/staging");

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error._tag).toBe(failure.tag);
        expect(JSON.stringify(result.error)).not.toContain("token@");
      }
    }
  });

  test("applies the fixed production timeout to clone and fetch", async () => {
    const timeouts: Array<number> = [];
    const process: GitProcess = {
      run: async (request) => {
        timeouts.push(request.timeoutMilliseconds);
        return Result.ok(output(0));
      },
    };
    const managedGit = createManagedGit(process, { remove: async () => Result.ok(undefined) });
    const repository = remoteSource("/tmp/unused.git");

    await managedGit.clone(repository, "/tmp/clone");
    await managedGit.prepareRefresh(repository, "/tmp/old", "/tmp/refresh");

    expect(timeouts).toContain(GIT_NETWORK_TIMEOUT_MILLISECONDS);
    expect(timeouts.at(-1)).toBe(GIT_NETWORK_TIMEOUT_MILLISECONDS);
  });
});

describe("Managed Checkout identity and metadata", () => {
  test("returns a structured lock acquisition failure with its filesystem cause", async () => {
    const workspace = await makeTemporaryDirectory();
    const blocker = join(workspace, "not-a-directory");
    await writeFile(blocker, "file");

    const acquired = await createProperCacheLocks(join(blocker, "locks")).acquire("safe-cache-key");

    expect(acquired.status).toBe("error");
    if (acquired.status === "error") {
      expect(acquired.error._tag).toBe("CacheLockError");
      expect(acquired.error.operation).toBe("acquire");
      expect(acquired.error.cause).toBeInstanceOf(Error);
    }
  });

  test("keeps cache keys stable across normalized source spellings and distinct across refs", () => {
    const left = parseRepositorySource("https://GitHub.com/owner/repo.git/");
    const right = parseRepositorySource("https://github.com/owner/repo");
    if (left.status === "error" || right.status === "error") throw new Error("Expected parsed sources");

    expect(makeCacheKey(left.value, undefined)).toBe(makeCacheKey(right.value, undefined));
    expect(makeCacheKey(left.value, undefined)).not.toBe(makeCacheKey(right.value, "main"));
  });

  test("returns structured malformed metadata and filesystem failures", async () => {
    const workspace = await makeTemporaryDirectory();
    const fileSystem = createNodeRepositoryFileSystem();
    const repository = remoteSource("/tmp/unused.git");
    const key = makeCacheKey(repository, undefined);
    const entry = join(workspace, "entries", key);
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, "metadata.json"), "{invalid");

    const malformed = await openManagedCheckout(
      { cacheRoot: workspace, fileSystem },
      { repository, configuredRef: undefined }
    );
    const cause = new Error("denied");
    const fileSystemError = new RepositoryFileSystemError({
      operation: "read-file",
      path: "/metadata.json",
      cause,
      message: "denied",
    });
    const unavailable = await readCacheMetadata("/metadata.json", {
      readTextFile: async () => Result.err(fileSystemError),
    });

    expect(malformed.status).toBe("error");
    if (malformed.status === "error") expect(malformed.error._tag).toBe("CacheMetadataParseError");
    expect(unavailable.status).toBe("error");
    if (unavailable.status === "error") {
      expect(unavailable.error._tag).toBe("CacheMetadataReadError");
      expect(unavailable.error.cause).toBe(fileSystemError);
    }
  });
});

function createStorage(workspace: string): ManagedCheckoutStorageOptions {
  const cacheRoot = join(workspace, "cache");
  const fileSystem = createNodeRepositoryFileSystem();
  let suffix = 0;
  return {
    cacheRoot,
    fileSystem,
    locks: createProperCacheLocks(join(cacheRoot, "locks")),
    git: createManagedGit(createNodeGitProcess(), fileSystem),
    clock: { now: () => new Date("2026-01-02T03:04:05.000Z") },
    makeUniqueSuffix: () => `stage-${String((suffix += 1))}`,
  };
}

async function createRemoteFixture() {
  const workspace = await makeTemporaryDirectory();
  const work = join(workspace, "work");
  const bare = join(workspace, "remote.git");
  await mkdir(work);
  await git(work, "init", "-b", "main");
  await git(work, "config", "user.email", "test@example.com");
  await git(work, "config", "user.name", "Test");
  await writeFile(join(work, "main.txt"), "main one\n");
  await git(work, "add", ".");
  await git(work, "commit", "-m", "main one");
  await git(work, "tag", "v1");
  await git(work, "checkout", "-b", "feature");
  await writeFile(join(work, "feature.txt"), "feature one\n");
  await git(work, "add", ".");
  await git(work, "commit", "-m", "feature one");
  await git(work, "checkout", "main");
  await git(workspace, "init", "--bare", bare);
  await git(work, "remote", "add", "origin", bare);
  await git(work, "push", "--all", "origin");
  await git(work, "push", "--tags", "origin");
  await git(workspace, `--git-dir=${bare}`, "symbolic-ref", "HEAD", "refs/heads/main");
  return { workspace, work, bare, repository: remoteSource(bare) };
}

function remoteSource(localClonePath: string): RepositorySource {
  const parsed = parseRepositorySource("https://example.invalid/owner/repo.git");
  if (parsed.status === "error") throw parsed.error;
  return {
    ...parsed.value,
    cloneSource: testCast<string, RepositoryCloneSource>(localClonePath),
  };
}

function output(exitCode: number, standardError = ""): GitProcessOutput {
  return {
    exitCode,
    standardOutput: "",
    standardError,
    signal: undefined,
    timedOut: false,
  };
}

async function revision(cwd: string, name: string): Promise<string> {
  return (await gitOutput(cwd, "rev-parse", name)).trim();
}

async function git(cwd: string, ...arguments_: ReadonlyArray<string>): Promise<void> {
  await executeFile("git", arguments_, { cwd });
}

async function gitOutput(cwd: string, ...arguments_: ReadonlyArray<string>): Promise<string> {
  try {
    return (await executeFile("git", arguments_, { cwd })).stdout;
  } catch (error) {
    if (arguments_.includes("symbolic-ref")) return "";
    throw error;
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "managed-checkout-"));
  temporaryDirectories.push(path);
  return path;
}
