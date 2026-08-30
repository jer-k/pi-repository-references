import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";

import { renderReferenceStatuses } from "./reference-status.ts";
import {
  refreshRepositoryReference,
  type RefreshRepositoryReferenceOptions,
  type RepositoryReferencesSession,
} from "./repository-references-service.ts";

/** Late-bound session dependencies used by command handlers across Pi reloads. */
export type ReferenceCommandDependencies = {
  readonly getSession: () => RepositoryReferencesSession | undefined;
  readonly getRefreshOptions: () => RefreshRepositoryReferenceOptions | undefined;
};

/** Register `/references` and `/references-refresh [alias]` command adapters. */
export function registerReferenceCommands(pi: ExtensionAPI, dependencies: ReferenceCommandDependencies): void {
  pi.registerCommand("references", {
    description: "Show configured Repository References and their current status",
    handler: async (_arguments, context) => {
      const session = dependencies.getSession();
      if (session === undefined) {
        notify(context, "Repository References are unavailable because session initialization failed.", "error");
        return;
      }
      notify(context, renderReferenceStatuses(session), "info");
    },
  });

  pi.registerCommand("references-refresh", {
    description: "Refresh or revalidate one Repository Reference, or all references",
    getArgumentCompletions: (argumentPrefix) => completeAlias(argumentPrefix, dependencies.getSession()),
    handler: async (arguments_, context) => {
      const session = dependencies.getSession();
      const options = dependencies.getRefreshOptions();
      if (session === undefined || options === undefined) {
        notify(context, "Repository References are unavailable because session initialization failed.", "error");
        return;
      }

      const parsed = parseRefreshArguments(arguments_);
      if (parsed._tag === "invalid") {
        notify(context, parsed.message, "error");
        return;
      }
      const aliases = parsed.alias === undefined ? [...session.references.keys()] : [parsed.alias];
      if (aliases.length === 0) {
        notify(context, "No Repository References are configured.", "info");
        return;
      }

      const outcomes: Array<{ readonly alias: string; readonly error: string | undefined }> = [];
      for (const alias of aliases) {
        const refreshed = await refreshRepositoryReference(session, alias, options);
        outcomes.push({ alias, error: refreshed.status === "error" ? refreshed.error.message : undefined });
      }
      const failures = outcomes.filter((outcome) => outcome.error !== undefined);
      const message = outcomes
        .map((outcome) =>
          outcome.error === undefined ? `@${outcome.alias}: ready` : `@${outcome.alias}: failed — ${outcome.error}`
        )
        .join("\n");
      notify(
        context,
        message,
        failures.length === 0 ? "info" : failures.length === outcomes.length ? "error" : "warning"
      );
    },
  });
}

/** Parse the command's optional single bare Alias argument. */
function parseRefreshArguments(
  input: string
):
  | { readonly _tag: "valid"; readonly alias: string | undefined }
  | { readonly _tag: "invalid"; readonly message: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { _tag: "valid", alias: undefined };
  if (trimmed.includes(" ") || trimmed.startsWith("@")) {
    return { _tag: "invalid", message: "Usage: /references-refresh [alias] (use the bare Alias without @)" };
  }
  return { _tag: "valid", alias: trimmed };
}

/** Complete configured bare Aliases for the optional refresh argument. */
function completeAlias(
  argumentPrefix: string,
  session: RepositoryReferencesSession | undefined
): AutocompleteItem[] | null {
  if (session === undefined || argumentPrefix.trim() !== argumentPrefix || argumentPrefix.includes(" ")) return null;
  const candidates = [...session.references].map(([alias, runtime]) => {
    const description = runtime.configuration.description;
    return description === undefined ? { value: alias, label: alias } : { value: alias, label: alias, description };
  });
  return fuzzyFilter(candidates, argumentPrefix, (candidate) => candidate.value).slice(0, 20);
}

/** Notify only through modes whose Pi context supports user-visible UI events. */
function notify(context: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
  if (context.hasUI) context.ui.notify(message, type);
}
