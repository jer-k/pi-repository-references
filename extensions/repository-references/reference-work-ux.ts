import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { renderActiveReferenceWork } from "./reference-status.ts";
import type { ReferenceWorkEvent } from "./repository-references-service.ts";

/** Stable Pi footer status key for Repository Reference background work. */
export const REFERENCE_WORK_STATUS = "repository-references-work";

/** Session-owned background UX controls. */
export type ReferenceWorkUx = {
  readonly onReferenceWork: (event: ReferenceWorkEvent) => void;
  readonly stop: () => void;
};

/** Create terminal-guarded footer and notification behavior for one Pi session. */
export function createReferenceWorkUx(context: Pick<ExtensionContext, "mode" | "hasUI" | "ui">): ReferenceWorkUx {
  const activeWork = new Map<string, "clone" | "refresh">();
  let active = true;

  return {
    onReferenceWork: (event) => {
      if (!active) return;
      if (event._tag === "started") activeWork.set(event.alias, event.operation);
      else activeWork.delete(event.alias);
      if (context.mode === "tui") {
        context.ui.setStatus(REFERENCE_WORK_STATUS, renderActiveReferenceWork(activeWork));
      }
      if (event.mode !== "automatic" || !context.hasUI) return;
      if (event._tag === "succeeded" && event.operation === "clone") {
        context.ui.notify(`Repository Reference @${event.alias} is ready`, "info");
      }
      if (event._tag === "failed") {
        context.ui.notify(`Repository Reference @${event.alias} failed: ${event.error.message}`, "error");
      }
    },
    stop: () => {
      active = false;
      activeWork.clear();
      if (context.mode === "tui") context.ui.setStatus(REFERENCE_WORK_STATUS, undefined);
    },
  };
}
