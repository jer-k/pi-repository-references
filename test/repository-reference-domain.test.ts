import { describe, expect, test } from "vitest";

import { parseAlias, renderAlias } from "../extensions/repository-references/alias.ts";
import { parseDuration } from "../extensions/repository-references/duration.ts";
import {
  AUTOMATIC_REFRESH_COOLDOWN_MILLISECONDS,
  decideAutomaticRefresh,
  parseRefreshPolicy,
  type RefreshPolicy,
} from "../extensions/repository-references/refresh-policy.ts";
import {
  parseRepositorySource,
  revealRepositoryCloneSource,
} from "../extensions/repository-references/repository-source.ts";

describe("Alias", () => {
  test.each(["a", "effect", "sdk-next", "foo.bar", "foo_bar", "0repo"])("parses %s without normalization", (input) => {
    const result = parseAlias(input);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(renderAlias(result.value)).toBe(input);
    }
  });

  test.each(["", "Effect", "@effect", "-effect", "effect/path", "two words"])(
    "rejects %s with a tagged error",
    (input) => {
      const result = parseAlias(input);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error._tag).toBe("InvalidAliasError");
      }
    }
  );
});

describe("TTL durations and Refresh Policies", () => {
  test.each([
    ["30m", 30 * 60 * 1000],
    ["12h", 12 * 60 * 60 * 1000],
    ["7d", 7 * 24 * 60 * 60 * 1000],
  ] as const)("parses %s", (input, milliseconds) => {
    const result = parseDuration(input);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.milliseconds).toBe(milliseconds);
    }
  });

  test.each(["0m", "1s", "1.5h", "-1d", " 1h", "9007199254740991d"])("rejects invalid duration %s", (input) => {
    const result = parseDuration(input);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("InvalidDurationError");
    }
  });

  test("parses session, manual, and TTL policies", () => {
    expect(parseRefreshPolicy({ policy: "session" })).toMatchObject({
      status: "ok",
      value: { _tag: "session" },
    });
    expect(parseRefreshPolicy({ policy: "manual" })).toMatchObject({
      status: "ok",
      value: { _tag: "manual" },
    });
    expect(parseRefreshPolicy({ policy: "ttl", ttl: "12h" })).toMatchObject({
      status: "ok",
      value: { _tag: "ttl", ttl: { literal: "12h" } },
    });
  });

  test.each([
    {
      policy: { _tag: "manual" as const },
      success: undefined,
      attempt: undefined,
      sessionAttempted: false,
      expected: { _tag: "skip", reason: "manual" },
    },
    {
      policy: { _tag: "session" as const },
      success: undefined,
      attempt: undefined,
      sessionAttempted: false,
      expected: { _tag: "refresh" },
    },
    {
      policy: { _tag: "session" as const },
      success: undefined,
      attempt: undefined,
      sessionAttempted: true,
      expected: { _tag: "skip", reason: "session-already-attempted" },
    },
    {
      policy: { _tag: "ttl" as const, ttl: { literal: "30m", milliseconds: 30 * 60 * 1000 } },
      success: "2026-01-01T11:30:00.000Z",
      attempt: undefined,
      sessionAttempted: false,
      expected: { _tag: "skip", reason: "ttl-fresh" },
    },
    {
      policy: { _tag: "ttl" as const, ttl: { literal: "30m", milliseconds: 30 * 60 * 1000 } },
      success: "2026-01-01T11:29:59.999Z",
      attempt: undefined,
      sessionAttempted: false,
      expected: { _tag: "refresh" },
    },
  ])("makes the $policy._tag automatic decision", ({ policy, success, attempt, sessionAttempted, expected }) => {
    expect(
      decideAutomaticRefresh({
        policy,
        now: new Date("2026-01-01T12:00:00.000Z"),
        lastSuccessfulRefresh: success,
        lastAutomaticAttempt: attempt,
        sessionAttempted,
      })
    ).toEqual(expected);
  });

  test("does not apply failure cooldown when an automatic attempt succeeded", () => {
    expect(
      decideAutomaticRefresh({
        policy: { _tag: "session" },
        now: new Date("2026-01-01T12:00:00.000Z"),
        lastSuccessfulRefresh: "2026-01-01T11:59:00.000Z",
        lastAutomaticAttempt: "2026-01-01T11:59:00.000Z",
        sessionAttempted: false,
      })
    ).toEqual({ _tag: "refresh" });
  });

  test("suppresses failures before but not at the fifteen-minute cooldown boundary", () => {
    const policy: RefreshPolicy = { _tag: "session" };
    const now = new Date("2026-01-01T12:00:00.000Z");
    const beforeBoundary = new Date(now.getTime() - AUTOMATIC_REFRESH_COOLDOWN_MILLISECONDS + 1).toISOString();
    const atBoundary = new Date(now.getTime() - AUTOMATIC_REFRESH_COOLDOWN_MILLISECONDS).toISOString();

    expect(
      decideAutomaticRefresh({
        policy,
        now,
        lastSuccessfulRefresh: undefined,
        lastAutomaticAttempt: beforeBoundary,
        sessionAttempted: false,
      })
    ).toMatchObject({ _tag: "skip", reason: "failure-cooldown" });
    expect(
      decideAutomaticRefresh({
        policy,
        now,
        lastSuccessfulRefresh: undefined,
        lastAutomaticAttempt: atBoundary,
        sessionAttempted: false,
      })
    ).toEqual({ _tag: "refresh" });
  });

  test.each([
    { policy: "sometimes" },
    { policy: "ttl" },
    { policy: "ttl", ttl: "0m" },
    { policy: "manual", ttl: "1d" },
    { policy: "session", extra: true },
  ])("strictly rejects malformed policy $policy", (input) => {
    const result = parseRefreshPolicy(input);

    expect(result.status).toBe("error");
  });
});

describe("repository sources", () => {
  test.each([
    ["Effect-TS/effect", "https://github.com/Effect-TS/effect", "https"],
    ["git.example.com/Owner/repository.git/", "https://git.example.com/Owner/repository", "https"],
    ["HTTPS://Git.Example.COM/Owner/repository.git/", "https://git.example.com/Owner/repository", "https"],
    ["ssh://git@Git.Example.COM/Owner/repository.git", "ssh://git@git.example.com/Owner/repository", "ssh"],
    ["git@GitHub.COM:Owner/repository.git", "ssh://git@github.com/Owner/repository", "ssh"],
    ["git://Git.Example.COM/Owner/repository.git", "git://git.example.com/Owner/repository", "git"],
    ["http://Git.Example.COM/Owner/repository.git", "http://git.example.com/Owner/repository", "http"],
  ] as const)("normalizes %s", (input, identity, transport) => {
    const result = parseRepositorySource(input);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.identity).toBe(identity);
      expect(result.value.transport).toBe(transport);
      const expectedCloneSource =
        input === "Effect-TS/effect"
          ? "https://github.com/Effect-TS/effect"
          : input === "git.example.com/Owner/repository.git/"
            ? "https://git.example.com/Owner/repository.git"
            : input;
      expect(revealRepositoryCloneSource(result.value.cloneSource)).toBe(expectedCloneSource);
    }
  });

  test("keeps transport differences as distinct identities", () => {
    const https = parseRepositorySource("https://github.com/owner/repo.git");
    const ssh = parseRepositorySource("git@github.com:owner/repo.git");

    expect(https.status).toBe("ok");
    expect(ssh.status).toBe("ok");
    if (https.status === "ok" && ssh.status === "ok") {
      expect(https.value.identity).not.toBe(ssh.value.identity);
    }
  });

  test("excludes HTTP credentials and query tokens from cache identities", () => {
    const result = parseRepositorySource("https://user:secret@Git.Example.com/owner/repo.git?token=secret");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.identity).toBe("https://git.example.com/owner/repo");
      expect(result.value.identity).not.toContain("secret");
    }
  });

  test.each(["", " owner/repo", "owner", "owner/repo/extra", "ftp://example.com/a/b", "example/a/b"])(
    "rejects unsupported or ambiguous source %s",
    (input) => {
      const result = parseRepositorySource(input);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error._tag).toBe("RepositorySourceParseError");
      }
    }
  );
});
