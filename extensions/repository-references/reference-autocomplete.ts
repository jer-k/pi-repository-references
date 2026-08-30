import {
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import type { ReferenceRuntime, RepositoryReferencesSession } from "./repository-references-service.ts";
import { runtimeIndex, runtimeRoot } from "./repository-references-service.ts";

const MAX_SUGGESTIONS = 20;

/**
 * Layer Repository Reference Alias and child completion over Pi's existing provider.
 *
 * Root results are prepended to delegated project-file results. Exact Alias child completion is
 * isolated to that reference's current immutable index and never reveals its physical root.
 */
export function createReferenceAutocompleteProvider(
  current: AutocompleteProvider,
  getSession: () => RepositoryReferencesSession | undefined
): AutocompleteProvider {
  return {
    triggerCharacters: ["@"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const session = getSession();
      if (session === undefined || session.closed) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const child = extractChildToken(beforeCursor, session.references);
      if (child !== undefined) return completeChild(session, child);

      const root = extractRootToken(beforeCursor);
      if (root === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const ownItems = completeRoots(session.references, root.query);
      const delegated = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (options.signal.aborted) return delegated;
      const delegatedItems = delegated?.prefix === root.prefix ? delegated.items : [];
      const items = [...ownItems, ...delegatedItems].slice(0, MAX_SUGGESTIONS);
      return items.length === 0 ? delegated : { prefix: root.prefix, items };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

type RootToken = { readonly prefix: string; readonly query: string };
type ChildToken = {
  readonly prefix: string;
  readonly alias: string;
  readonly query: string;
};

/** Parse a root Alias token at the cursor without reinterpreting ordinary project paths. */
function extractRootToken(beforeCursor: string): RootToken | undefined {
  const match = beforeCursor.match(/(?:^|[ \t])(@([a-z0-9._-]*))$/u);
  const prefix = match?.[1];
  const query = match?.[2];
  return prefix === undefined || query === undefined ? undefined : { prefix, query };
}

/** Parse an exact known Alias child token, including Pi's open quoted path syntax. */
function extractChildToken(
  beforeCursor: string,
  references: ReadonlyMap<string, ReferenceRuntime>
): ChildToken | undefined {
  const quoted = beforeCursor.match(/(?:^|[ \t])(@"([a-z0-9][a-z0-9._-]*)\/([^"\n]*))$/u);
  const unquoted = beforeCursor.match(/(?:^|[ \t])(@([a-z0-9][a-z0-9._-]*)\/([^\s"]*))$/u);
  const match = quoted ?? unquoted;
  const prefix = match?.[1];
  const alias = match?.[2];
  const query = match?.[3];
  if (prefix === undefined || alias === undefined || query === undefined || !references.has(alias)) {
    return undefined;
  }
  return { prefix, alias, query };
}

/** Fuzzy-rank every configured Alias before delegated project-file results. */
function completeRoots(
  references: ReadonlyMap<string, ReferenceRuntime>,
  query: string
): ReadonlyArray<AutocompleteItem> {
  const candidates = [...references.entries()];
  const ranked = query.length === 0 ? candidates : fuzzyFilter(candidates, query, ([alias]) => alias);
  return ranked.slice(0, MAX_SUGGESTIONS).map(([alias, runtime]) => ({
    value: `@${alias}/`,
    label: `@${alias}/`,
    description: rootDescription(runtime),
  }));
}

/** Complete only tracked/visible paths in one exact ready Alias. */
function completeChild(session: RepositoryReferencesSession, token: ChildToken): AutocompleteSuggestions | null {
  const runtime = session.references.get(token.alias);
  if (runtime === undefined || runtimeRoot(runtime) === undefined) return null;
  const index = runtimeIndex(runtime);
  if (index === undefined) return null;
  const candidates = [...[...index.directories].map((path) => `${path}/`), ...index.files];
  const ranked = token.query.length === 0 ? candidates : fuzzyFilter(candidates, token.query, (path) => path);
  const items = ranked.slice(0, MAX_SUGGESTIONS).map((path) => childItem(token.alias, path));
  return items.length === 0 ? null : { prefix: token.prefix, items };
}

/** Preserve Alias syntax and apply whole-token Pi quoting when a completed path contains spaces. */
function childItem(alias: string, path: string): AutocompleteItem {
  const aliasPath = `${alias}/${path}`;
  const value = /\s/u.test(aliasPath) ? `@"${aliasPath}"` : `@${aliasPath}`;
  return { value, label: `@${aliasPath}` };
}

/** Combine optional Description with a concise unavailable/background state. */
function rootDescription(runtime: ReferenceRuntime): string {
  const state = autocompleteState(runtime);
  return runtime.configuration.description === undefined ? state : `${runtime.configuration.description} [${state}]`;
}

/** Project runtime detail into root-completion state text. */
function autocompleteState(runtime: ReferenceRuntime): string {
  switch (runtime._tag) {
    case "ready-local":
    case "ready-remote":
      return "ready";
    case "cloning-remote":
      return "cloning";
    case "refreshing-remote":
      return "refreshing";
    case "stale-remote":
    case "failed-cached-remote":
      return "stale";
    case "offline-cached-remote":
      return "offline, cached";
    case "offline-uncached-remote":
      return "offline, unavailable";
    case "invalid-local":
    case "remote-uncached":
    case "failed-uncached-remote":
      return "unavailable";
  }
}
