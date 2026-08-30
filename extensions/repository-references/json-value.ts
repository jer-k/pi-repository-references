/** A value produced by successful JSON text parsing. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/**
 * Parse JSON text into its recursive value domain.
 *
 * JSON syntax failures are intentionally allowed to throw so the owning configuration adapter can classify them.
 */
export function parseJsonValue(contents: string): JsonValue {
  return JSON.parse(contents);
}
