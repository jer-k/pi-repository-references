import { createHash } from "node:crypto";

import type { RepositorySource } from "./repository-source.ts";

/** Credential-free sentinel used when a Remote Reference follows its default branch. */
export const DEFAULT_BRANCH_CACHE_REF = "<default-branch>";

/**
 * Derive a stable cache key from normalized repository identity and configured revision.
 *
 * The clone source is deliberately excluded because it may contain credentials.
 */
export function makeCacheKey(
  repository: Pick<RepositorySource, "identity">,
  configuredRef: string | undefined
): string {
  return createHash("sha256")
    .update(repository.identity)
    .update("\0")
    .update(configuredRef ?? DEFAULT_BRANCH_CACHE_REF)
    .digest("hex");
}
