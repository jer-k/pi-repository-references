import { join } from "node:path";

import { createProperCacheLocks } from "../../extensions/repository-references/cache-locks.ts";
import { createNodeGitProcess } from "../../extensions/repository-references/git-process.ts";
import {
  createManagedCheckoutStore,
  type ReadyManagedCheckout,
} from "../../extensions/repository-references/managed-checkout-storage.ts";
import { createManagedGit } from "../../extensions/repository-references/managed-git.ts";
import { createNodeRepositoryFileSystem } from "../../extensions/repository-references/node-file-system.ts";
import type {
  RepositoryCloneSource,
  RepositorySource,
} from "../../extensions/repository-references/repository-source.ts";
import { parseRepositorySource } from "../../extensions/repository-references/repository-source.ts";
import { testCast } from "../test-cast.ts";

const [cacheRoot, clonePath] = process.argv.slice(2);
if (cacheRoot === undefined || clonePath === undefined) throw new Error("Expected cache root and clone path");

const parsed = parseRepositorySource("https://example.invalid/concurrent/repository.git");
if (parsed.status === "error") throw parsed.error;
const repository: RepositorySource = {
  ...parsed.value,
  cloneSource: testCast<string, RepositoryCloneSource>(clonePath),
};
const fileSystem = createNodeRepositoryFileSystem();
const store = createManagedCheckoutStore({
  cacheRoot,
  fileSystem,
  locks: createProperCacheLocks(join(cacheRoot, "locks")),
  git: createManagedGit(createNodeGitProcess(), fileSystem),
  clock: { now: () => new Date() },
});
const published = await store.publish({ repository, configuredRef: undefined }, "ensure");
if (published.status === "error") {
  process.stderr.write(`${published.error._tag}: ${published.error.message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify(projectCheckout(published.value)));
}

function projectCheckout(checkout: ReadyManagedCheckout) {
  return {
    cacheKey: checkout.cacheKey,
    root: checkout.root,
    commit: checkout.metadata.resolvedCommit,
    sequence: checkout.metadata.publicationSequence,
  };
}
