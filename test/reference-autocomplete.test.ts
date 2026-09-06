import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";

import { createReferenceAutocompleteProvider } from "../extensions/repository-references/reference-autocomplete.ts";
import { parseConfigurationDocument } from "../extensions/repository-references/reference-configuration.ts";
import { buildReferenceIndex } from "../extensions/repository-references/reference-index.ts";
import type {
  ReferenceRuntime,
  RepositoryReferencesSession,
} from "../extensions/repository-references/repository-references-service.ts";

describe("Repository Reference autocomplete", () => {
  test("prepends fuzzy Alias roots to delegated project completion", async () => {
    const session = createAutocompleteSession();
    const delegated = createDelegatedProvider([
      { value: "@src/project.ts", label: "@src/project.ts", description: "project file" },
    ]);
    const provider = createReferenceAutocompleteProvider(delegated.provider, () => session);

    const suggestions = await provider.getSuggestions(["inspect @sour"], 0, 13, completionOptions());

    expect(suggestions?.prefix).toBe("@sour");
    expect(suggestions?.items[0]).toMatchObject({
      value: "@source/",
      description: "Source implementation [ready]",
    });
    expect(suggestions?.items.at(-1)?.description).toBe("project file");
  });

  test("keeps every configured Alias in root completion with availability state", async () => {
    const session = createAutocompleteSession();
    const delegated = createDelegatedProvider([]);
    const provider = createReferenceAutocompleteProvider(delegated.provider, () => session);

    const suggestions = await provider.getSuggestions(["@"], 0, 1, completionOptions());

    expect(suggestions?.items.map((item) => item.value)).toEqual(["@source/", "@other/", "@unavailable/"]);
    expect(suggestions?.items[2]?.description).toBe("unavailable");
  });

  test("isolates exact-Alias child completion and includes files and derived directories", async () => {
    const session = createAutocompleteSession();
    const delegated = createDelegatedProvider([{ value: "project.ts", label: "project.ts" }]);
    const provider = createReferenceAutocompleteProvider(delegated.provider, () => session);

    const fuzzy = await provider.getSuggestions(["@source/src/eff"], 0, 15, completionOptions());
    const directory = await provider.getSuggestions(["@source/pack"], 0, 12, completionOptions());

    expect(fuzzy?.items[0]?.value).toBe("@source/src/Effect.ts");
    expect(fuzzy?.items.some((item) => item.value.includes("other-only"))).toBe(false);
    expect(directory?.items).toContainEqual({
      value: "@source/packages/",
      label: "@source/packages/",
    });
    expect(delegated.calls()).toBe(0);
  });

  test("quotes complete Alias paths containing spaces and applies Pi insertion semantics", async () => {
    const session = createAutocompleteSession();
    const delegated = createDelegatedProvider([]);
    const provider = createReferenceAutocompleteProvider(delegated.provider, () => session);
    const input = "read @source/examples/path";

    const suggestions = await provider.getSuggestions([input], 0, input.length, completionOptions());
    const item = suggestions?.items.find((candidate) => candidate.value.includes("with spaces/file.ts"));
    if (suggestions === null || suggestions === undefined || item === undefined) {
      throw new Error("Expected path-with-spaces completion");
    }
    const applied = provider.applyCompletion([input], 0, input.length, item, suggestions.prefix);

    expect(item.value).toBe('@"source/examples/path with spaces/file.ts"');
    expect(applied.lines[0]).toBe('read @"source/examples/path with spaces/file.ts" ');
  });

  test("returns no children while unavailable and reads rebuilt indexes through the live session", async () => {
    let session = createAutocompleteSession();
    const delegated = createDelegatedProvider([]);
    const provider = createReferenceAutocompleteProvider(delegated.provider, () => session);

    const unavailableInput = "@unavailable/src";
    expect(
      await provider.getSuggestions([unavailableInput], 0, unavailableInput.length, completionOptions())
    ).toBeNull();
    expect(delegated.calls()).toBe(0);

    session = createAutocompleteSession("rebuilt.ts\0");
    const rebuiltInput = "@source/reb";
    const rebuilt = await provider.getSuggestions([rebuiltInput], 0, rebuiltInput.length, completionOptions());
    expect(rebuilt?.items[0]?.value).toBe("@source/rebuilt.ts");
  });
});

function createAutocompleteSession(
  sourceFiles = "src/Effect.ts\0packages/effect/index.ts\0examples/path with spaces/file.ts\0untracked.ts\0"
) {
  const parsed = parseConfigurationDocument(
    {
      version: 1,
      references: {
        source: { path: "/references/source", description: "Source implementation" },
        other: { path: "/references/other" },
        unavailable: { repository: "owner/unavailable" },
      },
    },
    "/config/repository-references.json",
    "/home"
  );
  if (parsed.status === "error") {
    throw parsed.error;
  }
  const source = parsed.value.references.get("source");
  const other = parsed.value.references.get("other");
  const unavailable = parsed.value.references.get("unavailable");
  if (
    source === undefined ||
    source._tag !== "local" ||
    other === undefined ||
    other._tag !== "local" ||
    unavailable === undefined ||
    unavailable._tag !== "remote"
  ) {
    throw new Error("Expected parsed autocomplete fixture configuration");
  }

  const references = new Map<string, ReferenceRuntime>();
  references.set("source", {
    _tag: "ready-local",
    configuration: source,
    local: {
      _tag: "ready-local",
      alias: source.alias,
      root: source.path,
      index: buildReferenceIndex(sourceFiles),
    },
  });
  references.set("other", {
    _tag: "ready-local",
    configuration: other,
    local: {
      _tag: "ready-local",
      alias: other.alias,
      root: other.path,
      index: buildReferenceIndex("other-only.ts\0"),
    },
  });
  references.set("unavailable", {
    _tag: "remote-uncached",
    configuration: {
      ...unavailable,
      refresh: { _tag: "manual" },
    },
    reason: "not materialized",
  });
  const session: RepositoryReferencesSession = {
    references,
    protectedRoots: new Set([source.path, other.path]),
    activeRemoteWork: new Map(),
    activeAliasSettlements: new Map(),
    automaticAttempts: new Set(),
    configurationGeneration: Symbol("autocomplete-test"),
    closed: false,
  };
  return session;
}

function createDelegatedProvider(items: ReadonlyArray<AutocompleteItem>) {
  let callCount = 0;
  const provider: AutocompleteProvider = {
    getSuggestions: async (lines, line, col) => {
      callCount += 1;
      const beforeCursor = (lines[line] ?? "").slice(0, col);
      const prefix = beforeCursor.match(/@[^\s]*$/u)?.[0] ?? "";
      return items.length === 0 ? null : { prefix, items: [...items] };
    },
    applyCompletion: (lines, line, col, item, prefix) => {
      const current = lines[line] ?? "";
      const next = `${current.slice(0, col - prefix.length)}${item.value}${item.label.endsWith("/") ? "" : " "}${current.slice(col)}`;
      const updated = [...lines];
      updated[line] = next;
      return { lines: updated, cursorLine: line, cursorCol: next.length };
    },
  };
  return { provider, calls: () => callCount };
}

function completionOptions() {
  return { signal: new AbortController().signal };
}
