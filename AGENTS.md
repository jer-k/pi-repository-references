# pi-repository-references

## Whitespace

Use whitespace to make the structure of code immediately apparent. Group related
statements together and separate distinct phases of control flow with blank lines.
Avoid both dense blocks and unnecessary blank lines.

Prefer formatting that makes operations, early returns, and side effects easy to scan.

Bad example

```ts
async function revParse(
  process: GitProcess,
  repository: ParsedRepositorySource,
  stagingPath: string,
  expression: string,
  mode: "required" | "probe" = "required"
): Promise<ResultType<string, ManagedGitError>> {
  const output = await process.run({
    operation: "resolve-managed-ref",
    arguments: ["-C", stagingPath, "rev-parse", "--verify", expression],
    timeoutMilliseconds: GIT_NETWORK_TIMEOUT_MILLISECONDS,
  });
  if (output.status === "error") return output;
  const commit = output.value.standardOutput.trim().toLowerCase();
  if (output.value.exitCode === 0 && /^[0-9a-f]{40,64}$/u.test(commit)) return Result.ok(commit);
  return Result.err(
    new GitRefResolutionError({
      repositoryIdentity: repository.identity,
      configuredRef: expression,
      cause: safeProcessCause(output.value),
      message:
        mode === "probe"
          ? `Revision candidate is unavailable in ${repository.identity}`
          : `Could not resolve revision in ${repository.identity}`,
    })
  );
}
```

Good example

```ts
async function revParse(
  process: GitProcess,
  repository: ParsedRepositorySource,
  stagingPath: string,
  expression: string,
  mode: "required" | "probe" = "required"
): Promise<ResultType<string, ManagedGitError>> {
  const output = await process.run({
    operation: "resolve-managed-ref",
    arguments: ["-C", stagingPath, "rev-parse", "--verify", expression],
    timeoutMilliseconds: GIT_NETWORK_TIMEOUT_MILLISECONDS,
  });
  if (output.status === "error") {
    return output;
  }

  const commit = output.value.standardOutput.trim().toLowerCase();
  const isValidCommit = output.value.exitCode === 0 && /^[0-9a-f]{40,64}$/u.test(commit);
  if (isValidCommit) {
    return Result.ok(commit);
  }

  return Result.err(
    new GitRefResolutionError({
      repositoryIdentity: repository.identity,
      configuredRef: expression,
      cause: safeProcessCause(output.value),
      message:
        mode === "probe"
          ? `Revision candidate is unavailable in ${repository.identity}`
          : `Could not resolve revision in ${repository.identity}`,
    })
  );
}
```

## Error handling

Represent expected and recoverable errors as `Result<T, E>` values using
`better-result`.

Use tagged errors from `extensions/repository-reference-errors.ts` and wrap
filesystem or JSON operations with `Result.try` / `Result.tryPromise`.

Do not convert programmer defects into `Result` values. Exceptions are allowed
at integration boundaries, for cancellation, and in tests. Pi tool handlers
should use the `throwRepositoryReferenceError` boundary; UI handlers should
notify the user and return.

## Documentation

Add concise JSDoc to every new production function, method, and non-obvious
helper. Document exported APIs' behavior, side effects, and possible
`Result` errors. Test-only helpers do not require JSDoc unless they are
non-obvious.

## Testing

Add tests for both success and structured failure cases. Prefer asserting
`Result.status`, tagged error `_tag`, and preserved causes where relevant.

Security-sensitive behavior, filesystem failures, and concurrent mutations
should have regression tests.

Before finishing, run:

    npm test
    npm run typecheck
    npm run lint
    npm run test:integration

## Documentation updates

Update `README.md` when changing user-visible commands, configuration, tools,
or installation behavior.
