import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Result, type Result as ResultType } from "better-result";
import lockfile from "proper-lockfile";

import { CacheLockError } from "../repository-reference-errors.ts";
import type { CacheLockLease, CacheLocks } from "./ports.ts";

/**
 * Create inter-process cache locks backed by atomic lock directories from `proper-lockfile`.
 *
 * Locks are scoped to credential-free resource keys and automatically considered stale after two
 * minutes so an abruptly terminated Pi process cannot permanently strand a shared resource.
 */
export function createProperCacheLocks(lockDirectory: string): CacheLocks {
  return {
    acquire: (cacheKey) => acquireLock(lockDirectory, cacheKey),
  };
}

/** Acquire one cache key and project third-party failures into a tagged lock error. */
async function acquireLock(
  lockDirectory: string,
  cacheKey: string
): Promise<ResultType<CacheLockLease, CacheLockError>> {
  const acquired = await Result.tryPromise({
    try: async () => {
      await mkdir(lockDirectory, { recursive: true });
      return lockfile.lock(join(lockDirectory, cacheKey), {
        realpath: false,
        stale: 120_000,
        update: 30_000,
        retries: { retries: 600, factor: 1, minTimeout: 100, maxTimeout: 100 },
      });
    },
    catch: (cause) =>
      new CacheLockError({
        cacheKey,
        operation: "acquire",
        cause,
        message: `Could not acquire Repository References lock ${cacheKey}`,
      }),
  });
  if (acquired.status === "error") {
    return acquired;
  }

  let released = false;
  return Result.ok({
    release: async () => {
      if (released) {
        return Result.ok(undefined);
      }
      const result = await Result.tryPromise({
        try: () => acquired.value(),
        catch: (cause) =>
          new CacheLockError({
            cacheKey,
            operation: "release",
            cause,
            message: `Could not release Repository References lock ${cacheKey}`,
          }),
      });
      if (result.status === "ok") {
        released = true;
      }
      return result;
    },
  });
}
