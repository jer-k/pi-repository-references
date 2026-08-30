/** Preserves a source type while making an explicitly requested test target available to TypeScript. */
function testUnion<Source, Target>(value: Source): Source | Target {
  return value;
}

/**
 * Adapts a focused test fake to a wider framework contract after the test has established which members are exercised.
 */
export function testCast<Source, Target>(value: Source): Target {
  // SAFETY: Callers use this only at test boundaries where each focused fake supplies every member the behavior under
  // test can access. Production values never pass through this adapter.
  return testUnion<Source, Target>(value) as Target;
}
