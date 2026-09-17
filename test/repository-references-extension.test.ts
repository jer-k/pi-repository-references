import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import extension from "../extensions/repository-references.ts";
import { testCast } from "./test-cast.ts";

test("loads the extension factory without starting session resources", () => {
  const registeredEvents: Array<string> = [];
  const registeredCommands: Array<string> = [];
  const pi = {
    on(event: string) {
      registeredEvents.push(event);
    },
    registerCommand(name: string) {
      registeredCommands.push(name);
    },
  };

  expect(() => extension(testCast<typeof pi, ExtensionAPI>(pi))).not.toThrow();
  expect(registeredCommands).toEqual(["references", "references-logs", "references-refresh"]);
  expect(registeredEvents).toEqual(["session_start", "before_agent_start", "tool_call", "session_shutdown"]);
});
