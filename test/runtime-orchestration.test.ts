import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result, type Result as ResultType } from "better-result";
import { afterEach, describe, expect, test } from "vitest";

import { GitCloneError } from "../extensions/repository-reference-errors.ts";
import { makeCacheKey } from "../extensions/repository-references/cache-identity.ts";
import type {
  ManagedCheckoutStorageError,
  ManagedCheckoutStore,
  ReadyManagedCheckout,
} from "../extensions/repository-references/managed-checkout-storage.ts";
import { createNodeRepositoryFileSystem } from "../extensions/repository-references/node-file-system.ts";
import type { GitProcess } from "../extensions/repository-references/ports.ts";
import {
  closeRepositoryReferencesSession,
  findMentionedAliases,
  refreshRepositoryReference,
  runtimeRoot,
  shouldBlockSessionWrite,
  startRepositoryReferencesSession,
  waitForRequestedReferences,
} from "../extensions/repository-references/repository-references-service.ts";
import { parseRepositorySource } from "../extensions/repository-references/repository-source.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Remote Reference runtime orchestration", () => {
  test("coalesces duplicate initial work and transitions both Aliases to ready", async () => {
    const fixture = await createRemoteConfiguration(["one", "two"]);
    const pending = makeDeferred<ResultType<ReadyManagedCheckout, ManagedCheckoutStorageError>>();
    let publications = 0;
    const store: ManagedCheckoutStore = {
      open: async () => Result.ok(undefined),
      publish: async () => {
        publications += 1;
        return pending.promise;
      },
    };
    const attempts: Array<string> = [];
    const started = await startRepositoryReferencesSession({
      ...fixture.options,
      managedCheckouts: store,
      clock: { now: () => new Date("2026-01-01T12:00:00.000Z") },
      onAutomaticAttempt: (cacheKey) => attempts.push(cacheKey),
    });
    if (started.status === "error") throw started.error;

    expect(started.value.references.get("one")?._tag).toBe("cloning-remote");
    expect(started.value.references.get("two")?._tag).toBe("cloning-remote");
    expect(publications).toBe(1);
    expect(attempts).toHaveLength(1);

    pending.resolve(Result.ok(fixture.checkout));
    const failures = await waitForRequestedReferences(started.value, new Set(["one", "two"]), undefined);

    expect(failures.size).toBe(0);
    expect(started.value.references.get("one")?._tag).toBe("ready-remote");
    expect(started.value.references.get("two")?._tag).toBe("ready-remote");
    expect(runtimeRoot(started.value.references.get("one") ?? missingRuntime())).toBe(fixture.checkout.root);
  });

  test("keeps a cached root usable while refresh runs and after structured failure", async () => {
    const fixture = await createRemoteConfiguration(["source"], { refresh: { policy: "session" } });
    const pending = makeDeferred<ResultType<ReadyManagedCheckout, ManagedCheckoutStorageError>>();
    const store: ManagedCheckoutStore = {
      open: async () => Result.ok(fixture.checkout),
      publish: async () => pending.promise,
    };
    const started = await startRepositoryReferencesSession({
      ...fixture.options,
      managedCheckouts: store,
      clock: { now: () => new Date("2026-01-01T12:00:00.000Z") },
    });
    if (started.status === "error") throw started.error;

    const refreshing = started.value.references.get("source");
    expect(refreshing?._tag).toBe("refreshing-remote");
    if (refreshing !== undefined) expect(runtimeRoot(refreshing)).toBe(fixture.checkout.root);

    pending.resolve(
      Result.err(
        new GitCloneError({
          repositoryIdentity: "https://github.com/owner/repo",
          exitCode: 128,
          diagnostic: "unavailable",
          cause: new Error("network unavailable"),
          message: "Git clone failed",
        })
      )
    );
    await waitForRequestedReferences(started.value, new Set(["source"]), undefined);
    await Promise.resolve();

    const failed = started.value.references.get("source");
    expect(failed?._tag).toBe("failed-cached-remote");
    if (failed !== undefined) expect(runtimeRoot(failed)).toBe(fixture.checkout.root);
  });

  test("never starts network work offline and distinguishes cached from uncached state", async () => {
    const uncachedFixture = await createRemoteConfiguration(["uncached"]);
    let publications = 0;
    const uncached = await startRepositoryReferencesSession({
      ...uncachedFixture.options,
      offline: true,
      managedCheckouts: {
        open: async () => Result.ok(undefined),
        publish: async () => {
          publications += 1;
          return Result.ok(uncachedFixture.checkout);
        },
      },
    });
    if (uncached.status === "error") throw uncached.error;

    const cachedFixture = await createRemoteConfiguration(["cached"], { refresh: { policy: "session" } });
    const cached = await startRepositoryReferencesSession({
      ...cachedFixture.options,
      offline: true,
      managedCheckouts: {
        open: async () => Result.ok(cachedFixture.checkout),
        publish: async () => {
          publications += 1;
          return Result.ok(cachedFixture.checkout);
        },
      },
    });
    if (cached.status === "error") throw cached.error;

    expect(uncached.value.references.get("uncached")?._tag).toBe("offline-uncached-remote");
    expect(cached.value.references.get("cached")?._tag).toBe("offline-cached-remote");
    expect(publications).toBe(0);
  });

  test("session attempts and failure cooldown suppress automatic work", async () => {
    const sessionFixture = await createRemoteConfiguration(["session"], { refresh: { policy: "session" } });
    const cacheKey = sessionFixture.cacheKey;
    let publications = 0;
    const store: ManagedCheckoutStore = {
      open: async () => Result.ok(sessionFixture.checkout),
      publish: async () => {
        publications += 1;
        return Result.ok(sessionFixture.checkout);
      },
    };
    const sessionSuppressed = await startRepositoryReferencesSession({
      ...sessionFixture.options,
      managedCheckouts: store,
      sessionAutomaticAttempts: new Set([cacheKey]),
    });
    if (sessionSuppressed.status === "error") throw sessionSuppressed.error;

    const ttlFixture = await createRemoteConfiguration(["ttl"], {
      refresh: { policy: "ttl", ttl: "1m" },
    });
    const cooldownSuppressed = await startRepositoryReferencesSession({
      ...ttlFixture.options,
      managedCheckouts: {
        open: async () => Result.ok(ttlFixture.checkout),
        publish: store.publish,
      },
      clock: { now: () => new Date("2026-01-01T12:00:00.000Z") },
      recentAutomaticAttempts: new Map([[ttlFixture.cacheKey, new Date("2026-01-01T11:50:00.000Z")]]),
    });
    if (cooldownSuppressed.status === "error") throw cooldownSuppressed.error;

    expect(sessionSuppressed.value.references.get("session")?._tag).toBe("ready-remote");
    expect(cooldownSuppressed.value.references.get("ttl")?._tag).toBe("stale-remote");
    expect(publications).toBe(0);
  });

  test("materializes an uncached manual reference because initial clone is not a refresh", async () => {
    const fixture = await createRemoteConfiguration(["manual"], { refresh: { policy: "manual" } });
    let publications = 0;
    const started = await startRepositoryReferencesSession({
      ...fixture.options,
      managedCheckouts: {
        open: async () => Result.ok(undefined),
        publish: async () => {
          publications += 1;
          return Result.ok(fixture.checkout);
        },
      },
    });
    if (started.status === "error") throw started.error;
    await waitForRequestedReferences(started.value, new Set(["manual"]), undefined);

    expect(publications).toBe(1);
    expect(started.value.references.get("manual")?._tag).toBe("ready-remote");
  });

  test("manual policy suppresses startup refresh while explicit refresh bypasses policy and cooldown", async () => {
    const fixture = await createRemoteConfiguration(["manual"], { refresh: { policy: "manual" } });
    let publications = 0;
    let automaticAttemptPersisted = false;
    const store: ManagedCheckoutStore = {
      open: async () => Result.ok(fixture.checkout),
      publish: async (_request, _intent, context) => {
        publications += 1;
        automaticAttemptPersisted = context?.automaticAttemptAt !== undefined;
        return Result.ok(fixture.checkout);
      },
    };
    const started = await startRepositoryReferencesSession({
      ...fixture.options,
      managedCheckouts: store,
      recentAutomaticAttempts: new Map([[fixture.cacheKey, new Date("2026-01-01T11:59:00.000Z")]]),
      clock: { now: () => new Date("2026-01-01T12:00:00.000Z") },
    });
    if (started.status === "error") throw started.error;

    expect(started.value.references.get("manual")?._tag).toBe("ready-remote");
    expect(publications).toBe(0);

    const refreshed = await refreshRepositoryReference(started.value, "manual", {
      ...fixture.options,
      managedCheckouts: store,
      offline: false,
      clock: { now: () => new Date("2026-01-01T12:00:00.000Z") },
    });

    expect(refreshed.status).toBe("ok");
    expect(publications).toBe(1);
    expect(automaticAttemptPersisted).toBe(false);
    expect(started.value.references.get("manual")?._tag).toBe("ready-remote");
  });

  test("retains old Managed Checkout write protection after a successful refresh", async () => {
    const fixture = await createRemoteConfiguration(["source"], { refresh: { policy: "manual" } });
    const nextRoot = join(fixture.options.cwd, "next-checkout");
    await mkdir(nextRoot);
    const nextCheckout = { ...fixture.checkout, root: nextRoot };
    const store: ManagedCheckoutStore = {
      open: async () => Result.ok(fixture.checkout),
      publish: async () => Result.ok(nextCheckout),
    };
    const started = await startRepositoryReferencesSession({
      ...fixture.options,
      managedCheckouts: store,
    });
    if (started.status === "error") throw started.error;

    const refreshed = await refreshRepositoryReference(started.value, "source", {
      ...fixture.options,
      managedCheckouts: store,
      offline: false,
      clock: { now: () => new Date("2026-01-01T12:00:00.000Z") },
    });

    expect(refreshed.status).toBe("ok");
    expect(started.value.protectedRoots).toEqual(new Set([fixture.checkout.root, nextRoot]));
    expect(
      await shouldBlockSessionWrite(
        started.value,
        fixture.checkout.root,
        fixture.options.cwd,
        fixture.options.fileSystem
      )
    ).toEqual({ status: "ok", value: true });
    expect(
      await shouldBlockSessionWrite(started.value, nextRoot, fixture.options.cwd, fixture.options.fileSystem)
    ).toEqual({ status: "ok", value: true });
  });

  test("explicit refresh reports offline without starting network work", async () => {
    const fixture = await createRemoteConfiguration(["source"], { refresh: { policy: "manual" } });
    let publications = 0;
    const started = await startRepositoryReferencesSession({
      ...fixture.options,
      managedCheckouts: {
        open: async () => Result.ok(fixture.checkout),
        publish: async () => {
          publications += 1;
          return Result.ok(fixture.checkout);
        },
      },
    });
    if (started.status === "error") throw started.error;

    const refreshed = await refreshRepositoryReference(started.value, "source", {
      ...fixture.options,
      managedCheckouts: {
        open: async () => Result.ok(fixture.checkout),
        publish: async () => {
          publications += 1;
          return Result.ok(fixture.checkout);
        },
      },
      offline: true,
      clock: { now: () => new Date("2026-01-01T12:00:00.000Z") },
    });

    expect(refreshed.status).toBe("error");
    if (refreshed.status === "error") expect(refreshed.error._tag).toBe("OfflineMaterializationError");
    expect(publications).toBe(0);
    expect(started.value.references.get("source")?._tag).toBe("offline-cached-remote");
  });

  test("detects configured mentions and closes obsolete session state", async () => {
    const fixture = await createRemoteConfiguration(["source", "other"]);
    const started = await startRepositoryReferencesSession(fixture.options);
    if (started.status === "error") throw started.error;

    expect(
      findMentionedAliases('Use @source and @"other/path with spaces.ts", not @unknown', started.value.references)
    ).toEqual(new Set(["source", "other"]));
    closeRepositoryReferencesSession(started.value);
    expect(started.value.closed).toBe(true);
    expect(started.value.references.size).toBe(0);
  });
});

async function createRemoteConfiguration(aliases: ReadonlyArray<string>, extra: { readonly refresh?: unknown } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "repository-runtime-"));
  temporaryDirectories.push(workspace);
  const agentDirectory = join(workspace, "agent");
  const checkoutRoot = join(workspace, "checkout");
  await mkdir(agentDirectory);
  await mkdir(checkoutRoot);
  await writeFile(join(checkoutRoot, "tracked.ts"), "tracked\n");
  await writeFile(
    join(agentDirectory, "repository-references.json"),
    JSON.stringify({
      version: 1,
      references: Object.fromEntries(
        aliases.map((alias) => [
          alias,
          {
            repository: "owner/repo",
            ...extra,
          },
        ])
      ),
    })
  );
  const fileSystem = createNodeRepositoryFileSystem();
  const git: GitProcess = {
    run: async () =>
      Result.ok({
        exitCode: 0,
        standardOutput: "tracked.ts\0",
        standardError: "",
        signal: undefined,
        timedOut: false,
      }),
  };
  const checkout: ReadyManagedCheckout = {
    cacheKey: "cache-key",
    root: checkoutRoot,
    metadata: {
      version: 1,
      repositoryIdentity: "https://github.com/owner/repo",
      configuredRef: "<default-branch>",
      refKind: "default-branch",
      resolvedCommit: "a".repeat(40),
      publicationSequence: 1,
      currentCheckout: `checkouts/${"a".repeat(40)}`,
      createdAt: "2025-01-01T00:00:00.000Z",
      lastSuccessfulRefresh: "2025-01-01T00:00:00.000Z",
    },
  };
  const options = {
    agentDirectory,
    cwd: workspace,
    homeDirectory: workspace,
    projectTrusted: false,
    fileSystem,
    fullFileSystem: fileSystem,
    git,
  };
  const repository = parseRepositorySource("owner/repo");
  if (repository.status === "error") throw repository.error;
  const cacheKey = makeCacheKey(repository.value, undefined);
  return { options, checkout, cacheKey };
}

function makeDeferred<T>() {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolver === undefined) throw new Error("Deferred resolver was not initialized");
      resolver(value);
    },
  };
}

function missingRuntime(): never {
  throw new Error("Expected runtime state");
}
