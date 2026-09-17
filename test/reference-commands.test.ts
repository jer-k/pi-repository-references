import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";
import { describe, expect, test } from "vitest";

import { GitCloneError } from "../extensions/repository-reference-errors.ts";
import { parseAlias } from "../extensions/repository-references/alias.ts";
import type { CacheMetadata } from "../extensions/repository-references/cache-metadata.ts";
import type { RepositoryReferenceErrorLog } from "../extensions/repository-references/error-log.ts";
import type { GitProcess, RepositoryFileSystem } from "../extensions/repository-references/ports.ts";
import { registerReferenceCommands } from "../extensions/repository-references/reference-commands.ts";
import { parseRefreshPolicy } from "../extensions/repository-references/refresh-policy.ts";
import {
  type ReferenceRuntime,
  type RepositoryReferencesSession,
} from "../extensions/repository-references/repository-references-service.ts";
import { parseRepositorySource } from "../extensions/repository-references/repository-source.ts";
import { testCast } from "./test-cast.ts";

type RegisteredCommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

describe("Repository Reference commands", () => {
  test("registers status and refresh commands with Alias completion", async () => {
    const session = makeSession([makeRemoteRuntime("source", "remote-uncached"), makeRemoteRuntime("other", "ready")]);
    const commands = new Map<string, RegisteredCommandOptions>();
    registerReferenceCommands(
      testCast<{ registerCommand: (name: string, options: RegisteredCommandOptions) => void }, ExtensionAPI>({
        registerCommand: (name, options) => commands.set(name, options),
      }),
      { getSession: () => session, getRefreshOptions: () => undefined }
    );

    expect([...commands.keys()]).toEqual(["references", "references-logs", "references-refresh"]);
    expect(await commands.get("references-refresh")?.getArgumentCompletions?.("sou")).toEqual([
      { value: "source", label: "source", description: "source description" },
    ]);

    const notifications: Array<{ readonly message: string; readonly type: string | undefined }> = [];
    await commands.get("references")?.handler("", commandContext(notifications));
    expect(notifications[0]?.message).toContain("@source — remote https://example.invalid/owner/source");
    expect(notifications[0]?.message).toContain("state: uncached");
    expect(notifications[0]?.message).toContain("@other");
  });

  test("refreshes every Alias sequentially and isolates structured failures", async () => {
    const session = makeSession([
      makeRemoteRuntime("good", "remote-uncached"),
      makeRemoteRuntime("bad", "remote-uncached"),
    ]);
    const publications: Array<string> = [];
    const commands = new Map<string, RegisteredCommandOptions>();
    registerReferenceCommands(
      testCast<{ registerCommand: (name: string, options: RegisteredCommandOptions) => void }, ExtensionAPI>({
        registerCommand: (name, options) => commands.set(name, options),
      }),
      {
        getSession: () => session,
        getRefreshOptions: () => ({
          git: successfulIndexGit(),
          fullFileSystem: testCast<{}, RepositoryFileSystem>({}),
          clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
          offline: false,
          managedCheckouts: {
            open: async () => Result.ok(undefined),
            publish: async (request) => {
              publications.push(request.repository.identity);
              if (request.repository.identity.endsWith("/bad")) {
                return Result.err(
                  new GitCloneError({
                    repositoryIdentity: request.repository.identity,
                    exitCode: 128,
                    diagnostic: "unavailable",
                    cause: new Error("unavailable"),
                    message: "Git clone failed",
                  })
                );
              }
              return Result.ok({ cacheKey: "good", root: "/cache/good", metadata: metadata("good") });
            },
          },
        }),
      }
    );
    const notifications: Array<{ readonly message: string; readonly type: string | undefined }> = [];

    await commands.get("references-refresh")?.handler("", commandContext(notifications));

    expect(publications).toHaveLength(2);
    expect(session.references.get("good")?._tag).toBe("ready-remote");
    expect(session.references.get("bad")?._tag).toBe("failed-uncached-remote");
    expect(notifications.at(-1)).toMatchObject({
      type: "warning",
      message: expect.stringContaining("@good: ready"),
    });
    expect(notifications.at(-1)?.message).toContain("@bad: failed — Git clone failed");
  });

  test("views retained errors and can ask Pi to review the log", async () => {
    const commands = new Map<string, RegisteredCommandOptions>();
    const sentMessages: Array<string> = [];
    const errorLog: RepositoryReferenceErrorLog = {
      path: "/agent/repository-references/errors.jsonl",
      record: async () => Result.ok(undefined),
      read: async () =>
        Result.ok([
          {
            version: 1,
            timestamp: "2026-01-01T00:00:00.000Z",
            context: { alias: "effect", operation: "fetch", mode: "automatic" },
            error: { _tag: "GitFetchError", message: "Git fetch failed", diagnostic: "connection reset" },
          },
        ]),
      flush: async () => undefined,
    };
    registerReferenceCommands(
      testCast<
        {
          registerCommand: (name: string, options: RegisteredCommandOptions) => void;
          sendUserMessage: (message: string) => void;
        },
        ExtensionAPI
      >({
        registerCommand: (name, options) => commands.set(name, options),
        sendUserMessage: (message) => sentMessages.push(message),
      }),
      {
        getSession: () => undefined,
        getRefreshOptions: () => undefined,
        getErrorLog: () => errorLog,
      }
    );
    const notifications: Array<{ readonly message: string; readonly type: string | undefined }> = [];

    await commands.get("references-logs")?.handler("", commandContext(notifications));
    await commands.get("references-logs")?.handler("review", commandContext(notifications));

    expect(notifications.at(-1)?.message).toContain("connection reset");
    expect(notifications.at(-1)?.message).toContain(errorLog.path);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain(errorLog.path);
    expect(sentMessages[0]).toContain("diagnose the newest failures");
  });

  test("reports offline refreshes without invoking Managed Checkout publication", async () => {
    const session = makeSession([makeRemoteRuntime("source", "remote-uncached")]);
    let publications = 0;
    const commands = new Map<string, RegisteredCommandOptions>();
    registerReferenceCommands(
      testCast<{ registerCommand: (name: string, options: RegisteredCommandOptions) => void }, ExtensionAPI>({
        registerCommand: (name, options) => commands.set(name, options),
      }),
      {
        getSession: () => session,
        getRefreshOptions: () => ({
          git: successfulIndexGit(),
          fullFileSystem: testCast<{}, RepositoryFileSystem>({}),
          clock: { now: () => new Date() },
          offline: true,
          managedCheckouts: {
            open: async () => Result.ok(undefined),
            publish: async () => {
              publications += 1;
              return Result.ok({ cacheKey: "unused", root: "/unused", metadata: metadata("unused") });
            },
          },
        }),
      }
    );
    const notifications: Array<{ readonly message: string; readonly type: string | undefined }> = [];

    await commands.get("references-refresh")?.handler("source", commandContext(notifications));

    expect(publications).toBe(0);
    expect(notifications.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("cannot refresh while Pi is offline"),
    });
  });
});

function makeSession(runtimes: ReadonlyArray<readonly [string, ReferenceRuntime]>): RepositoryReferencesSession {
  return {
    references: new Map(runtimes),
    protectedRoots: new Set(),
    activeRemoteWork: new Map(),
    activeAliasSettlements: new Map(),
    automaticAttempts: new Set(),
    configurationGeneration: Symbol("command-test"),
    closed: false,
  };
}

function makeRemoteRuntime(
  aliasInput: string,
  state: "remote-uncached" | "ready"
): readonly [string, ReferenceRuntime] {
  const alias = parseAlias(aliasInput);
  const repository = parseRepositorySource(`https://example.invalid/owner/${aliasInput}`);
  const refresh = parseRefreshPolicy({ policy: "ttl", ttl: "7d" });
  if (alias.status === "error" || repository.status === "error" || refresh.status === "error") {
    throw new Error("Expected valid test configuration");
  }
  const configuration = {
    _tag: "remote" as const,
    alias: alias.value,
    repository: repository.value,
    configuredRef: undefined,
    description: `${aliasInput} description`,
    refresh: refresh.value,
  };
  return state === "remote-uncached"
    ? [aliasInput, { _tag: "remote-uncached", configuration, reason: "not materialized" }]
    : [
        aliasInput,
        {
          _tag: "ready-remote",
          configuration,
          remote: {
            checkout: { cacheKey: aliasInput, root: `/cache/${aliasInput}`, metadata: metadata(aliasInput) },
            index: { files: new Set(), directories: new Set() },
          },
        },
      ];
}

function metadata(key: string): CacheMetadata {
  return {
    version: 1,
    repositoryIdentity: `https://example.invalid/owner/${key}`,
    configuredRef: "__default_branch__",
    refKind: "default-branch",
    resolvedCommit: "a".repeat(40),
    publicationSequence: 1,
    currentCheckout: `checkouts/${"a".repeat(40)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSuccessfulRefresh: "2026-01-01T00:00:00.000Z",
  };
}

function successfulIndexGit(): GitProcess {
  return {
    run: async () =>
      Result.ok({
        exitCode: 0,
        standardOutput: "tracked.ts\0",
        standardError: "",
        signal: undefined,
        timedOut: false,
      }),
  };
}

function commandContext(
  notifications: Array<{ readonly message: string; readonly type: string | undefined }>
): ExtensionCommandContext {
  return testCast<
    {
      hasUI: true;
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
    },
    ExtensionCommandContext
  >({
    hasUI: true,
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  });
}
