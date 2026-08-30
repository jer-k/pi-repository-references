import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import extension from "../extensions/repository-references.ts";
import { testCast } from "./test-cast.ts";

test("loads the extension factory", () => {
  const pi = {};

  expect(() => extension(testCast<typeof pi, ExtensionAPI>(pi))).not.toThrow();
});
