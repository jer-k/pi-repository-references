import { Result, type Result as ResultType } from "better-result";

import { InvalidDurationError } from "../repository-reference-errors.ts";

/** A parsed positive TTL duration with its exact configured representation. */
export type Duration = {
  /** Positive duration in milliseconds. */
  readonly milliseconds: number;
  /** Exact validated configuration literal. */
  readonly literal: string;
};

const DURATION_PATTERN = /^(?<amount>[1-9][0-9]*)(?<unit>[mhd])$/;
const MILLISECONDS_BY_UNIT = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
} as const;

/**
 * Parse a positive integer duration ending in `m`, `h`, or `d`.
 *
 * @param input - Candidate duration literal.
 * @returns A duration, or `InvalidDurationError` for malformed, zero, or unsafe values.
 */
export function parseDuration(input: string): ResultType<Duration, InvalidDurationError> {
  const match = DURATION_PATTERN.exec(input);
  const amountText = match?.groups?.amount;
  const unit = match?.groups?.unit;
  if (amountText === undefined || (unit !== "m" && unit !== "h" && unit !== "d")) {
    return invalidDuration(input);
  }

  const milliseconds = Number(amountText) * MILLISECONDS_BY_UNIT[unit];
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return invalidDuration(input);
  }

  return Result.ok({ literal: input, milliseconds });
}

/** Construct the shared invalid-duration result. */
function invalidDuration(input: string): ResultType<never, InvalidDurationError> {
  return Result.err(
    new InvalidDurationError({
      input,
      message: `Invalid TTL duration ${JSON.stringify(input)}; expected a positive integer followed by m, h, or d`,
    })
  );
}
