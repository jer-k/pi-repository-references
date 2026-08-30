import { Result, type Result as ResultType } from "better-result";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { InvalidDurationError, InvalidRefreshPolicyError } from "../repository-reference-errors.ts";
import { parseDuration, type Duration } from "./duration.ts";
import type { JsonValue } from "./json-value.ts";

/** Refresh once during each Pi process session. */
export type SessionRefreshPolicy = { readonly _tag: "session" };

/** Refresh only through explicit user requests. */
export type ManualRefreshPolicy = { readonly _tag: "manual" };

/** Refresh automatically after a configured successful-refresh age. */
export type TtlRefreshPolicy = {
  readonly _tag: "ttl";
  readonly ttl: Duration;
};

/** A fully parsed automatic or explicit refresh policy. */
export type RefreshPolicy = SessionRefreshPolicy | ManualRefreshPolicy | TtlRefreshPolicy;

/** Automatic failure retry suppression window. */
export const AUTOMATIC_REFRESH_COOLDOWN_MILLISECONDS = 15 * 60 * 1000;

/** Inputs used to decide whether one Remote Reference should refresh automatically. */
export type AutomaticRefreshInput = {
  readonly policy: RefreshPolicy;
  readonly now: Date;
  readonly lastSuccessfulRefresh: string | undefined;
  readonly lastAutomaticAttempt: string | undefined;
  readonly sessionAttempted: boolean;
};

/** Exhaustive automatic refresh decision and its suppression reason. */
export type AutomaticRefreshDecision =
  | { readonly _tag: "refresh" }
  | {
      readonly _tag: "skip";
      readonly reason: "manual" | "session-already-attempted" | "ttl-fresh" | "failure-cooldown";
    };

/** Built-in seven-day policy used when neither configuration file supplies one. */
export const DEFAULT_REFRESH_POLICY: TtlRefreshPolicy = {
  _tag: "ttl",
  ttl: { literal: "7d", milliseconds: 7 * 24 * 60 * 60 * 1000 },
};

/**
 * Decide whether automatic remote work is due without performing effects.
 *
 * TTL references refresh only after the boundary is strictly exceeded. A failed-attempt cooldown
 * applies to every automatic policy and expires exactly fifteen minutes after that attempt.
 */
export function decideAutomaticRefresh(input: AutomaticRefreshInput): AutomaticRefreshDecision {
  if (input.policy._tag === "manual") return { _tag: "skip", reason: "manual" };
  if (input.policy._tag === "session" && input.sessionAttempted) {
    return { _tag: "skip", reason: "session-already-attempted" };
  }

  const lastAttempt = parseInstant(input.lastAutomaticAttempt);
  const lastSuccess = parseInstant(input.lastSuccessfulRefresh);
  const lastAttemptFailed = lastAttempt !== undefined && (lastSuccess === undefined || lastAttempt > lastSuccess);
  if (lastAttemptFailed && input.now.getTime() - lastAttempt < AUTOMATIC_REFRESH_COOLDOWN_MILLISECONDS) {
    return { _tag: "skip", reason: "failure-cooldown" };
  }
  if (input.policy._tag === "session") return { _tag: "refresh" };

  if (lastSuccess === undefined || input.now.getTime() - lastSuccess > input.policy.ttl.milliseconds) {
    return { _tag: "refresh" };
  }
  return { _tag: "skip", reason: "ttl-fresh" };
}

const SessionPolicySchema = Type.Object({ policy: Type.Literal("session") }, { additionalProperties: false });
const ManualPolicySchema = Type.Object({ policy: Type.Literal("manual") }, { additionalProperties: false });
const TtlPolicySchema = Type.Object(
  {
    policy: Type.Literal("ttl"),
    ttl: Type.String({ pattern: "^[1-9][0-9]*[mhd]$" }),
  },
  { additionalProperties: false }
);
const RefreshPolicySchema = Type.Union([SessionPolicySchema, ManualPolicySchema, TtlPolicySchema]);
type RefreshPolicyProtocol = Static<typeof RefreshPolicySchema>;

/**
 * Parse a strict Refresh Policy object from untrusted JSON configuration.
 *
 * @param input - Candidate JSON policy value.
 * @param issuePath - Configuration path used in diagnostics.
 * @returns A parsed policy, or a precise policy/duration error.
 */
export function parseRefreshPolicy(
  input: JsonValue,
  issuePath = "refresh"
): ResultType<RefreshPolicy, InvalidRefreshPolicyError | InvalidDurationError> {
  if (!Value.Check(RefreshPolicySchema, input)) {
    const firstError = Value.Errors(RefreshPolicySchema, input)[0];
    const suffix = firstError?.instancePath.replaceAll("/", ".") ?? "";
    return invalidPolicy(`${issuePath}${suffix}`, firstError?.message ?? "invalid policy");
  }

  return parseRefreshPolicyProtocol(input);
}

/** Convert a schema-parsed policy protocol into the domain policy. */
function parseRefreshPolicyProtocol(input: RefreshPolicyProtocol): ResultType<RefreshPolicy, InvalidDurationError> {
  if (input.policy === "session") return Result.ok({ _tag: "session" });
  if (input.policy === "manual") return Result.ok({ _tag: "manual" });

  const duration = parseDuration(input.ttl);
  return duration.status === "error" ? duration : Result.ok({ _tag: "ttl", ttl: duration.value });
}

/** Parse a validated durable instant defensively for pure policy callers. */
function parseInstant(input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  const value = Date.parse(input);
  return Number.isFinite(value) ? value : undefined;
}

/** Construct a policy parse failure. */
function invalidPolicy(issuePath: string, reason: string): ResultType<never, InvalidRefreshPolicyError> {
  return Result.err(
    new InvalidRefreshPolicyError({
      issuePath,
      reason,
      message: `Invalid Refresh Policy at ${issuePath}: ${reason}`,
    })
  );
}
