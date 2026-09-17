import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { GitCloneError } from "../extensions/repository-reference-errors.ts";
import { createReferenceWorkUx, REFERENCE_WORK_STATUS } from "../extensions/repository-references/reference-work-ux.ts";
import { testCast } from "./test-cast.ts";

test("shows compact TUI work status and applies background notification policy", () => {
  const statuses: Array<{ readonly key: string; readonly text: string | undefined }> = [];
  const notifications: Array<{ readonly message: string; readonly type: string | undefined }> = [];
  const ux = createReferenceWorkUx(
    testCast<
      {
        mode: "tui";
        hasUI: true;
        ui: {
          setStatus: (key: string, text: string | undefined) => void;
          notify: (message: string, type?: "info" | "warning" | "error") => void;
        };
      },
      Pick<ExtensionContext, "mode" | "hasUI" | "ui">
    >({
      mode: "tui",
      hasUI: true,
      ui: {
        setStatus: (key, text) => statuses.push({ key, text }),
        notify: (message, type) => notifications.push({ message, type }),
      },
    })
  );

  ux.onReferenceWork({ _tag: "started", alias: "one", operation: "clone", mode: "automatic" });
  ux.onReferenceWork({ _tag: "started", alias: "two", operation: "refresh", mode: "automatic" });
  ux.onReferenceWork({ _tag: "succeeded", alias: "two", operation: "refresh", mode: "automatic" });
  ux.onReferenceWork({ _tag: "succeeded", alias: "one", operation: "clone", mode: "automatic" });

  expect(statuses).toContainEqual({ key: REFERENCE_WORK_STATUS, text: "references: 1 cloning, 1 refreshing" });
  expect(statuses.at(-1)).toEqual({ key: REFERENCE_WORK_STATUS, text: undefined });
  expect(notifications).toEqual([{ message: "Repository Reference @one is ready", type: "info" }]);
});

test("notifies automatic failures, suppresses explicit notifications, and stops cleanly", () => {
  const statuses: Array<string | undefined> = [];
  const notifications: Array<string> = [];
  const ux = createReferenceWorkUx(
    testCast<
      {
        mode: "tui";
        hasUI: true;
        ui: {
          setStatus: (_key: string, text: string | undefined) => void;
          notify: (message: string) => void;
        };
      },
      Pick<ExtensionContext, "mode" | "hasUI" | "ui">
    >({
      mode: "tui",
      hasUI: true,
      ui: {
        setStatus: (_key, text) => statuses.push(text),
        notify: (message) => notifications.push(message),
      },
    }),
    "run /references-logs for retained diagnostics"
  );
  const error = new GitCloneError({
    repositoryIdentity: "https://example.invalid/owner/repo",
    exitCode: 128,
    diagnostic: "unavailable",
    cause: new Error("unavailable"),
    message: "Git clone failed",
  });

  ux.onReferenceWork({ _tag: "started", alias: "source", operation: "clone", mode: "automatic" });
  ux.onReferenceWork({ _tag: "failed", alias: "source", operation: "clone", mode: "automatic", error });
  ux.onReferenceWork({ _tag: "started", alias: "source", operation: "refresh", mode: "explicit" });
  ux.onReferenceWork({ _tag: "failed", alias: "source", operation: "refresh", mode: "explicit", error });
  ux.stop();
  ux.onReferenceWork({ _tag: "started", alias: "ignored", operation: "clone", mode: "automatic" });

  expect(notifications).toEqual([
    "Repository Reference @source failed: Git clone failed; run /references-logs for retained diagnostics",
  ]);
  expect(statuses.at(-1)).toBeUndefined();
});

test("does not use terminal footer outside TUI mode", () => {
  let statuses = 0;
  const notifications: Array<string> = [];
  const ux = createReferenceWorkUx(
    testCast<
      {
        mode: "rpc";
        hasUI: true;
        ui: {
          setStatus: () => void;
          notify: (message: string) => void;
        };
      },
      Pick<ExtensionContext, "mode" | "hasUI" | "ui">
    >({
      mode: "rpc",
      hasUI: true,
      ui: {
        setStatus: () => {
          statuses += 1;
        },
        notify: (message) => notifications.push(message),
      },
    })
  );

  ux.onReferenceWork({ _tag: "started", alias: "source", operation: "clone", mode: "automatic" });
  ux.onReferenceWork({ _tag: "succeeded", alias: "source", operation: "clone", mode: "automatic" });

  expect(statuses).toBe(0);
  expect(notifications).toEqual(["Repository Reference @source is ready"]);
});
