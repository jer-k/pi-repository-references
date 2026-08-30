import { Result, type Result as ResultType } from "better-result";

import { InvalidAliasError } from "../repository-reference-errors.ts";

declare const aliasBrand: unique symbol;

/** A configured lowercase Repository Reference name without its usage `@` prefix. */
export type Alias = string & { readonly [aliasBrand]: true };

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Parse an exact configured Alias without applying normalization.
 *
 * @param input - Candidate bare Alias.
 * @returns The refined Alias, or `InvalidAliasError` when it violates the Alias grammar.
 */
export function parseAlias(input: string): ResultType<Alias, InvalidAliasError> {
  if (!ALIAS_PATTERN.test(input)) {
    return Result.err(
      new InvalidAliasError({
        input,
        message: `Invalid Repository Reference Alias: ${JSON.stringify(input)}`,
      })
    );
  }

  // SAFETY: ALIAS_PATTERN establishes the only Alias invariant, and callers cannot access the brand.
  return Result.ok(input as Alias);
}

/** Render an Alias as its unprefixed configuration value. */
export function renderAlias(alias: Alias): string {
  return alias;
}
