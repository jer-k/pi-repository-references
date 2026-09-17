import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";
import { afterEach, describe, expect, test } from "vitest";

import { GitFetchError, RepositoryFileSystemError } from "../extensions/repository-reference-errors.ts";
import { createProperCacheLocks } from "../extensions/repository-references/cache-locks.ts";
import {
  createRepositoryReferenceErrorLog,
  ERROR_LOG_FILE_NAME,
} from "../extensions/repository-references/error-log.ts";
import { createNodeRepositoryFileSystem } from "../extensions/repository-references/node-file-system.ts";
import type { Clock, RepositoryFileSystem } from "../extensions/repository-references/ports.ts";

const temporaryDirectories: Array<string> = [];

const NOW = new Date("2026-03-10T12:00:00.000Z");
const CLOCK: Clock = { now: () => NOW };
const CONFIGURATION = {
  _tag: "enabled" as const,
  ttl: { literal: "7d", milliseconds: 7 * 24 * 60 * 60 * 1_000 },
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("structured Repository References error log", () => {
  test("prunes expired and malformed records when it opens", async () => {
    const root = await makeTemporaryDirectory();
    const path = join(root, ERROR_LOG_FILE_NAME);
    await writeFile(
      path,
      [
        JSON.stringify(entry("2026-03-01T00:00:00.000Z", "expired")),
        "not json",
        JSON.stringify(entry("2026-03-09T00:00:00.000Z", "retained")),
        "",
      ].join("\n")
    );

    const opened = await createRepositoryReferenceErrorLog({
      cacheRoot: root,
      configuration: CONFIGURATION,
      fileSystem: createNodeRepositoryFileSystem(),
      locks: createProperCacheLocks(join(root, "locks")),
      clock: CLOCK,
    });

    expect(opened.status).toBe("ok");
    if (opened.status === "ok") {
      const records = await opened.value.read();
      expect(records).toMatchObject({
        status: "ok",
        value: [{ context: { operation: "retained" } }],
      });
      expect(await readFile(path, "utf8")).not.toContain("expired");
      expect(await readFile(path, "utf8")).not.toContain("not json");
    }
  });

  test("retains the Git diagnostic and safe cause chain while redacting likely credentials", async () => {
    const root = await makeTemporaryDirectory();
    const opened = await createRepositoryReferenceErrorLog({
      cacheRoot: root,
      configuration: CONFIGURATION,
      fileSystem: createNodeRepositoryFileSystem(),
      locks: createProperCacheLocks(join(root, "locks")),
      clock: CLOCK,
    });
    if (opened.status === "error") {
      throw opened.error;
    }

    const recorded = await opened.value.record(
      { alias: "effect", operation: "fetch", mode: "automatic" },
      new GitFetchError({
        repositoryIdentity: "https://github.com/Effect-TS/effect",
        exitCode: 128,
        diagnostic: "fatal: unable to access 'https://person:password@example.invalid/repo': connection reset",
        cause: {
          exitCode: 128,
          token: "do-not-log",
          nested: { url: "https://person:password@example.invalid/repo" },
        },
        message: "Git fetch failed",
      })
    );
    const records = await opened.value.read();

    expect(recorded.status).toBe("ok");
    expect(records.status).toBe("ok");
    if (records.status === "ok") {
      const serialized = JSON.stringify(records.value);
      expect(serialized).toContain("GitFetchError");
      expect(serialized).toContain("connection reset");
      expect(serialized).toContain("https://<credentials>@example.invalid/repo");
      expect(serialized).not.toContain("do-not-log");
      expect(serialized).not.toContain("person:password");
    }
  });

  test("serializes concurrent writers from separate log instances without losing records", async () => {
    const root = await makeTemporaryDirectory();
    const first = await createLog(root);
    const second = await createLog(root);
    const error = new GitFetchError({
      repositoryIdentity: "https://example.invalid/owner/repo",
      exitCode: 128,
      diagnostic: "network unavailable",
      cause: { exitCode: 128 },
      message: "Git fetch failed",
    });

    const writes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).record(
          { alias: `source-${String(index)}`, operation: "fetch", mode: "explicit" },
          error
        )
      )
    );
    const records = await first.read();

    expect(writes.every((result) => result.status === "ok")).toBe(true);
    expect(records.status).toBe("ok");
    if (records.status === "ok") {
      expect(records.value).toHaveLength(20);
      expect(new Set(records.value.map((record) => record.context.alias)).size).toBe(20);
    }
  });

  test("returns a structured filesystem failure when startup pruning cannot write", async () => {
    const root = await makeTemporaryDirectory();
    const cause = new Error("permission denied");
    const base = createNodeRepositoryFileSystem();
    const fileSystem: RepositoryFileSystem = {
      ...base,
      writeTextFile: async (path) =>
        Result.err(
          new RepositoryFileSystemError({
            operation: "write-file",
            path,
            cause,
            message: "write denied",
          })
        ),
    };

    const opened = await createRepositoryReferenceErrorLog({
      cacheRoot: root,
      configuration: CONFIGURATION,
      fileSystem,
      locks: createProperCacheLocks(join(root, "locks")),
      clock: CLOCK,
    });

    expect(opened.status).toBe("error");
    if (opened.status === "error") {
      expect(opened.error._tag).toBe("RepositoryFileSystemError");
      expect(opened.error.cause).toBe(cause);
    }
  });
});

async function createLog(root: string) {
  const opened = await createRepositoryReferenceErrorLog({
    cacheRoot: root,
    configuration: CONFIGURATION,
    fileSystem: createNodeRepositoryFileSystem(),
    locks: createProperCacheLocks(join(root, "locks")),
    clock: CLOCK,
  });
  if (opened.status === "error") {
    throw opened.error;
  }
  return opened.value;
}

function entry(timestamp: string, operation: string) {
  return {
    version: 1,
    timestamp,
    context: { operation },
    error: { _tag: "GitFetchError", message: operation },
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "repository-reference-error-log-"));
  temporaryDirectories.push(path);
  await mkdir(path, { recursive: true });
  return path;
}
