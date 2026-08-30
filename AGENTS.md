# pi-repository-references

## Error handling

Represent expected and recoverable errors as `Result<T, E>` values using
`better-result`.

Use tagged errors from `extensions/hubble-errors.ts` and wrap filesystem or
JSON operations with `Result.try` / `Result.tryPromise`.

Do not convert programmer defects into `Result` values. Exceptions are allowed
at integration boundaries, for cancellation, and in tests. Pi tool handlers
should use the existing `throwReferenceError` boundary; UI handlers should notify
the user and return.

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
