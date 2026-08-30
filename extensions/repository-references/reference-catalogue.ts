import type { ReferenceRuntime, RepositoryReferencesSession } from "./repository-references-service.ts";
import { runtimeRoot } from "./repository-references-service.ts";

/** Inputs used to compose one turn's ambient Repository Reference catalogue. */
export type ReferenceCatalogueInput = {
  readonly session: RepositoryReferencesSession;
  readonly mentionedAliases: ReadonlySet<string>;
  readonly materializationFailures: ReadonlyMap<string, string>;
};

/**
 * Render compact per-turn Repository Reference guidance without changing the user's Alias text.
 *
 * Described references are included only while usable. Explicit mentions are included regardless
 * of Description or availability, with concise failures when materialization did not succeed.
 */
export function renderReferenceCatalogue(input: ReferenceCatalogueInput): string | undefined {
  const lines: Array<string> = [];
  for (const [alias, runtime] of input.session.references) {
    const mentioned = input.mentionedAliases.has(alias);
    const available = runtimeRoot(runtime) !== undefined;
    if (!mentioned && (runtime.configuration.description === undefined || !available)) continue;
    lines.push(renderReference(alias, runtime, input.materializationFailures.get(alias)));
  }
  if (lines.length === 0) return undefined;

  return [
    "Repository References (read-only):",
    ...lines,
    "Inspect these roots with Pi's built-in read, grep, find, and ls tools. Do not edit them; make changes in the active project instead.",
  ].join("\n");
}

/** Append one catalogue to Pi's chained system prompt without mutating either input. */
export function appendReferenceCatalogue(systemPrompt: string, catalogue: string): string {
  return `${systemPrompt}\n\n${catalogue}`;
}

/** Return roots whose physical paths were disclosed by one rendered catalogue. */
export function catalogueExposedRoots(
  session: RepositoryReferencesSession,
  mentionedAliases: ReadonlySet<string>
): ReadonlySet<string> {
  const roots = new Set<string>();
  for (const [alias, runtime] of session.references) {
    const root = runtimeRoot(runtime);
    if (root !== undefined && (mentionedAliases.has(alias) || runtime.configuration.description !== undefined)) {
      roots.add(root);
    }
  }
  return roots;
}

/** Render one available or explicitly requested reference line. */
function renderReference(alias: string, runtime: ReferenceRuntime, materializationFailure: string | undefined): string {
  const root = runtimeRoot(runtime);
  const source = runtime.configuration._tag === "local" ? "Local Reference" : "Remote Reference";
  const description = runtime.configuration.description;
  const details = [
    `@${alias}`,
    source,
    root === undefined ? undefined : `root: ${root}`,
    description === undefined ? undefined : `Description: ${description}`,
    `state: ${renderAvailability(runtime)}`,
    materializationFailure === undefined ? undefined : `failure: ${materializationFailure}`,
  ].filter((part) => part !== undefined);
  return `- ${details.join(" — ")}`;
}

/** Project the detailed runtime union into concise prompt vocabulary. */
function renderAvailability(runtime: ReferenceRuntime): string {
  switch (runtime._tag) {
    case "ready-local":
    case "ready-remote":
      return "ready";
    case "invalid-local":
      return `unavailable (${runtime.error.message})`;
    case "remote-uncached":
      return `unavailable (${runtime.reason})`;
    case "cloning-remote":
      return "cloning";
    case "refreshing-remote":
      return "refreshing; old checkout remains usable";
    case "stale-remote":
      return `stale (${runtime.reason})`;
    case "offline-cached-remote":
      return runtime.stale ? "offline, stale cache" : "offline, cached";
    case "offline-uncached-remote":
      return `offline, unavailable (${runtime.error.message})`;
    case "failed-cached-remote":
      return `stale after failure (${runtime.error.message})`;
    case "failed-uncached-remote":
      return `unavailable (${runtime.error.message})`;
  }
}
