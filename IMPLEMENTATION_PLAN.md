# Pi Repository References Implementation Plan

## Objective

Implement the decision-complete behavior in [`SPEC.md`](./SPEC.md) as a Pi Git package that provides named, read-only Repository References backed by local Git working trees or shared Managed Checkouts.

The implementation will follow the domain language in [`CONTEXT.md`](./CONTEXT.md), the structured error conventions in [`AGENTS.md`](./AGENTS.md), and Pi's extension, package, lifecycle, and autocomplete APIs.

## Current state

The repository currently contains:

- A loadable extension factory at `extensions/repository-references.ts`.
- Package metadata that exposes the extension to Pi.
- Smoke tests for extension and package loading.
- Passing test, typecheck, lint, and integration-test baselines.

Most product behavior remains to be implemented.

## Design principles

- Keep `extensions/repository-references.ts` as the Pi composition root.
- Put cohesive implementation modules under `extensions/repository-references/`.
- Parse untrusted configuration and paths into refined domain values at their boundaries.
- Represent expected failures with `better-result` and tagged errors from `extensions/repository-reference-errors.ts`.
- Use `throwRepositoryReferenceError` only where a Pi boundary requires an exception; UI handlers notify and return.
- Keep Git, filesystem, clock, locking, and process-session behavior behind narrow injectable ports.
- Model lifecycle and availability with tagged states rather than independent booleans.
- Do not use module mocks. Test through domain APIs, injected ports, real filesystems, real Git repositories, and Pi runtime seams.
- Add concise JSDoc to every new production function, method, and non-obvious helper.
- Update `README.md` for all user-visible behavior before completion.

## Proposed module organization

The exact split may evolve to preserve cohesion, but the implementation should have modules with responsibilities similar to:

```text
extensions/
  repository-references.ts                 Pi composition root
  repository-reference-errors.ts           tagged errors and Pi error boundary
  repository-references/
    alias.ts                                Alias parsing and rendering
    duration.ts                             TTL duration parsing
    refresh-policy.ts                       policy resolution and refresh decisions
    repository-source.ts                    remote source parsing and normalization
    reference-configuration.ts              strict config parsing, loading, and merging
    reference-path.ts                       mention parsing and containment-safe paths
    git-process.ts                          non-interactive Git process adapter
    local-reference.ts                      local working-tree validation and indexing
    cache-metadata.ts                       cache metadata parsing and atomic persistence
    cache-lock.ts                           inter-process cache-entry locking
    managed-checkout.ts                     clone, fetch, ref resolution, and publication
    reference-index.ts                      file and directory indexes
    reference-autocomplete.ts               layered TUI autocomplete provider
    reference-catalogue.ts                  ambient prompt catalogue rendering
    repository-references-service.ts        lifecycle and operation orchestration
    reference-status.ts                     command and footer status projections
```

Tests should mirror the production ownership rather than relying on a single large test file.

## Phase 1: Foundation and error contracts

1. Add `better-result` as a production dependency.
2. Add a proven inter-process locking dependency if the lock cannot be implemented more safely with a small atomic-filesystem module.
3. Add Pi-provided runtime imports to `peerDependencies` where required, including `typebox` and `@earendil-works/pi-tui` if production code imports them directly.
4. Define precise tagged errors for:
   - Configuration reads, JSON parsing, versions, and validation.
   - Invalid Local References.
   - Alias and path resolution failures.
   - Repository-source parsing.
   - Git clone, fetch, ref resolution, authentication, and timeout failures.
   - Cache locks, metadata, and publication.
   - Offline materialization.
   - Index construction.
5. Preserve underlying causes and safe contextual fields without leaking credentials.
6. Add the `throwRepositoryReferenceError` integration boundary.
7. Define narrow ports for clocks, Git execution, locks, and required filesystem behavior.

### Exit criteria

- Structured errors can be asserted by `Result.status` and `_tag`.
- Filesystem, JSON, and process failures preserve their causes.
- Package dependencies are valid for installation as a Pi Git package.

## Phase 2: Domain and configuration parsing

Implement parsers for:

1. Aliases matching `^[a-z0-9][a-z0-9._-]*$` without normalization.
2. Positive TTL durations ending in `m`, `h`, or `d`.
3. Session, manual, and TTL Refresh Policies.
4. Local and Remote Reference entries with exact field sets.
5. Version 1 configuration documents with strict unknown-field rejection.
6. Supported repository source forms:
   - GitHub shorthand.
   - Unambiguous host shorthand.
   - HTTP, HTTPS, SSH, and Git URLs.
   - SCP-style SSH addresses.
7. Stable repository identities that normalize host casing, trailing separators, and `.git` while preserving meaningful transport differences.

Implement configuration loading and merging:

1. Load the optional global file from `getAgentDir()/repository-references.json`.
2. Load the optional project file from `<cwd>/<CONFIG_DIR_NAME>/repository-references.json` only when `ctx.isProjectTrusted()` is true.
3. Resolve relative Local Reference paths from the containing configuration directory.
4. Expand home-relative paths.
5. Apply complete project-entry replacement rather than field-level merging.
6. Apply project file-wide Refresh Policy replacement.
7. Apply the built-in seven-day TTL when neither file provides a policy.
8. Disable the complete reference set when either loaded document has a read, parse, version, or validation failure.
9. Treat absent files as successful empty inputs.

### Tests

- Every schema requirement in §5 of the specification.
- Unknown fields at every nesting level.
- Invalid aliases and empty descriptions.
- Local/remote field exclusivity.
- Whole-entry project overrides.
- Refresh inheritance and replacement.
- Relative, absolute, and home-relative paths.
- Malformed JSON and filesystem failures with paths and preserved causes.

### Exit criteria

- Valid global and project documents produce a fully parsed merged configuration.
- Any loaded configuration error disables the complete configured set with one structured diagnostic.

## Phase 3: Local Reference vertical slice

Deliver Local References end to end before introducing remote cache complexity.

1. Resolve each configured Local Reference to a canonical path.
2. Verify that it is the root of an existing non-bare Git working tree.
3. Never fetch, checkout, reset, clean, or otherwise mutate it.
4. Build its index from:

   ```text
   git ls-files --cached --others --exclude-standard
   ```

5. Derive directory entries from indexed files.
6. Parse `@alias`, `@alias/path`, and Pi-style quoted Alias paths.
7. Reject lexical `..` traversal before normalization.
8. Resolve symlinks and reject targets outside the canonical root.
9. Rewrite Alias paths for `read`, `grep`, `find`, and `ls` tool calls.
10. Block `edit` and `write` through both Alias paths and physical Local Reference paths.
11. Leave unknown Aliases untouched for normal Pi handling.

### Tests

- Tracked, modified, and untracked non-ignored source visibility.
- Root and descendant Alias paths.
- Spaces and quoted paths.
- Lexical traversal.
- Escaping symlinks.
- Missing descendants and nearest-existing-parent containment.
- Alias and physical-path write blocking.
- Unknown Alias pass-through.

### Exit criteria

- A Local Reference is usable in TUI, print, JSON, and RPC modes through Pi's built-in tools without autocomplete support.

## Phase 4: Managed Checkout storage and Git adapter

Implement remote materialization under:

```text
$PI_CODING_AGENT_DIR/repository-references/
```

### Cache identity and layout

1. Hash the normalized repository identity and configured ref, using an explicit sentinel for the default branch.
2. Keep the internal layout private.
3. Store immutable, commit-addressed published checkout directories.
4. Store validated metadata that points to the current published checkout and records timestamps needed for refresh decisions.
5. Write metadata to a sibling temporary file and atomically rename it into place.
6. Keep old published checkouts in the first release.
7. Treat deletion of the cache root as supported and recreate entries on demand.

### Git process behavior

1. Execute Git directly without shell command construction.
2. Disable terminal credential prompts.
3. Preserve the user's credential helpers, SSH agent, keys, and SSH configuration.
4. Apply a fixed production timeout of 60 seconds to each clone and fetch.
5. Classify killed and timed-out processes separately from ordinary non-zero exits.
6. Provide authentication diagnostics that suggest reproducing the operation with normal `git clone` or `git fetch`.
7. Avoid exposing repository credentials in errors, metadata, snapshots, or notifications.

### Clone and ref behavior

1. Clone into an unpublished staging directory.
2. Attempt `--filter=blob:none` first.
3. Fall back to a normal clone when filtering is unsupported.
4. Resolve the remote default branch when `ref` is absent.
5. Resolve configured branches, tags, and commits.
6. Follow moving branches on refresh.
7. Record the initially resolved commit for tags and commits so they remain pinned.
8. Produce detached Managed Checkouts.
9. Do not initialize submodules recursively.
10. Add no Git LFS-specific behavior.

### Publication and locking

1. Serialize mutation per cache entry with an inter-process lock.
2. Re-read current metadata after acquiring the lock to account for work completed by another process.
3. Finish clone, fetch, ref resolution, and checkout entirely in staging.
4. Atomically publish only a complete checkout.
5. Never replace usable metadata after failure, interruption, or timeout.
6. Never expose an incomplete initial clone as ready.

### Tests

- Repository normalization and cache-key stability.
- Default branch, moving branch, tag, and commit behavior.
- Partial-clone fallback.
- Invalid and unavailable refs.
- Authentication-style errors and timeout classification.
- Metadata parse and filesystem failures.
- Initial publication and refresh preservation behavior.

### Exit criteria

- Multiple aliases and projects can resolve the same cache entry.
- Readers see either the complete old checkout or the complete new checkout.
- Failed refreshes leave old source usable.

## Phase 5: Refresh policy and runtime orchestration

Create a cohesive application service that owns configuration reconciliation, reference state, materialization, refresh, indexing, and status.

### State model

Represent meaningful states explicitly, including:

- Ready Local Reference.
- Invalid Local Reference.
- Uncached Remote Reference.
- Cloning Remote Reference.
- Ready Remote Reference.
- Refreshing Remote Reference with a usable old root.
- Stale Remote Reference.
- Offline cached and uncached states.
- Runtime failure with or without a usable old checkout.

### Refresh decisions

1. Attempt `session` refresh once per Pi session.
2. Preserve that attempt across `/reload` without incorrectly suppressing refresh in a newly resumed process.
3. Attempt TTL refresh when the last successful refresh is older than the configured duration.
4. Never automatically refresh manual references.
5. Persist the last successful refresh and last automatic attempt in cache metadata.
6. Suppress automatic retries for 15 minutes after failure.
7. Let explicit refresh bypass TTL and cooldown.
8. Suppress every network Git operation when `PI_OFFLINE` is active.
9. Keep cached source usable and stale while offline.

### Startup and waiting

At `session_start`:

1. Load and parse configuration.
2. Revalidate Local References.
3. Open valid cached Managed Checkouts immediately.
4. Build indexes for available roots.
5. Start missing clones and due refreshes in the background.
6. Coalesce duplicate same-process work.
7. Allow the inter-process lock to coalesce work across processes.

When a reference is explicitly requested:

1. Await its current initial materialization if it has no usable checkout.
2. Race the caller's wait against the active agent abort signal where available.
3. Do not cancel shared publication merely because one caller stops waiting.
4. Never delay an unrelated agent turn for unmentioned background work.

### Tests

- Every Refresh Policy decision.
- Reload behavior for session refreshes.
- TTL boundary times.
- Failure cooldown.
- Explicit bypass.
- Cached and uncached offline behavior.
- Same-process request coalescing.
- State transitions after success and structured failure.

### Exit criteria

- Startup, reload, explicit requests, and background refreshes match §§8 and 13 of the specification.

## Phase 6: Ambient discovery and Pi tool hooks

Register the Pi integration behavior in the composition root.

### Lifecycle hooks

- `session_start`: create session-owned state, load configuration, reconcile references, and schedule background work.
- `before_agent_start`: detect explicit Alias mentions, wait for required uncached materialization, and append the per-turn catalogue.
- `tool_call`: resolve read-oriented paths and enforce read-only protection.
- `session_shutdown`: clear footer/autocomplete state and release only session-owned resources.

No process, timer, watcher, or other background resource may start in the extension factory.

### Ambient catalogue

1. Advertise every available reference with a Description.
2. Include explicitly mentioned references even without a Description.
3. Omit undescribed and unmentioned references.
4. Include Alias, physical root, source kind, Description, and availability information as needed.
5. Explain that Repository References are read-only and should be inspected with built-in read-oriented tools.
6. Expose a concise structured failure when an explicitly mentioned reference cannot materialize.
7. Preserve the user's Alias text in the prompt and session.

### Tool behavior

1. Use `isToolCallEventType` to narrow built-in tools.
2. Rewrite only explicit known Alias syntax.
3. Rewrite the optional `path` inputs of `grep`, `find`, and `ls` only when present.
4. Block unavailable known references with a concise reason.
5. Block `edit` and `write` beneath current and previously exposed reference roots.
6. Recognize physical Managed Checkout roots exposed in ambient context.
7. Do not inspect or rewrite arbitrary Bash command strings.

### Tests

- Description-driven discoverability.
- Explicit mention behavior.
- Concise unavailable-reference errors.
- System-prompt composition without prompt mutation.
- Built-in tool input mutation.
- Read-only blocking for Alias, current physical root, and an old root exposed before refresh.
- Behavior in all Pi modes.

### Exit criteria

- Prompts and built-in tools satisfy acceptance criteria 2, 4, and 7 without a parallel custom toolset.

## Phase 7: TUI autocomplete

Add a layered provider with `ctx.ui.addAutocompleteProvider()` during TUI session startup.

### Root completion

1. Trigger on `@`.
2. Match Alias prefixes fuzzily.
3. Put reference suggestions before delegated project-file results.
4. Include Descriptions when present.
5. Allow unavailable references to appear with state information.
6. Keep every configured Alias eligible for root completion.

### Child completion

1. Detect an exact Alias followed by `/`.
2. Search only that reference's current index.
3. Include indexed files and derived directories.
4. Preserve `@alias/...` as the inserted editor value.
5. Apply Pi-style quoting around complete paths containing spaces.
6. Return no child results while the reference is unavailable.
7. Use Pi TUI fuzzy ranking and compatible result bounds.
8. Rebuild indexes as references become ready and after explicit refresh or reload.

### Tests

- Root composition and ordering.
- Delegation to normal project completion.
- Exact-Alias child isolation.
- Fuzzy matching.
- Directory entries.
- Paths containing spaces.
- Local untracked files.
- Remote tracked files.
- Unavailable state.
- Reload reconstruction.

### Exit criteria

- Autocomplete satisfies §10 while Alias resolution remains independent of the TUI.

## Phase 8: Commands and background UX

### `/references`

Display every configured Alias with:

- Local or remote source.
- Configured ref or default branch.
- Resolved root when available.
- Effective Refresh Policy.
- Ready, cloning, refreshing, stale, offline, or error state.
- Last successful remote refresh.
- Concise current error.

### `/references-refresh [alias]`

1. Add Alias argument completion.
2. Revalidate and reindex a Local Reference without changing Git state.
3. Force fetch/materialization for a Remote Reference.
4. Bypass TTL and failure cooldown.
5. Report offline state without trying Git.
6. Process all references when no Alias is supplied.
7. Isolate failures so one reference does not stop unrelated refreshes.
8. Do not add a cancellation UI in the first release.

### Background UX

1. Show a compact footer status while clone or refresh work is active.
2. Notify when a previously missing repository becomes ready.
3. Notify on failure.
4. Do not notify for routine successful TTL refreshes.
5. Keep complete details available through `/references`.
6. Guard terminal-only behavior with `ctx.mode === "tui"` and general UI behavior with `ctx.hasUI`.

### Tests

- Command registration and argument completion.
- Local and remote explicit refresh behavior.
- Refresh-all failure isolation.
- Offline command behavior.
- Footer lifecycle and notification policy.

### Exit criteria

- Commands and status behavior satisfy §11 in interactive and RPC-capable contexts.

## Phase 9: Integration and concurrency suite

Integration tests will use real Git and temporary local infrastructure without public-network access.

### Test harness

1. Create temporary working repositories and bare remotes.
2. Create reusable helpers for commits, branches, tags, and ref movement.
3. Serve bare repositories over loopback `git://` with `git daemon`, producing accepted Remote Reference URLs.
4. Configure remotes with and without partial-clone filter support.
5. Use a hanging loopback server and injected short test timeout for timeout scenarios while production remains fixed at 60 seconds.
6. Spawn separate Node processes for inter-process lock tests. Add `tsx` as a development dependency for predictable TypeScript subprocess fixtures on supported Node versions.
7. Use Pi's SDK/runtime for extension loading, lifecycle, reload, commands, and tool hooks.
8. Test autocomplete through the real provider contract instead of terminal keystroke simulation.
9. Explicitly inject or control offline state so CI's `PI_OFFLINE=1` does not affect non-offline scenarios.
10. Clean up servers, subprocesses, repositories, locks, caches, and temporary directories in `finally` blocks.

### Required scenarios

- Initial materialization and ref selection.
- Default branch, moving branch, tag, and commit behavior.
- Partial-clone fallback.
- Stale-cache use during refresh.
- Refresh failure and timeout preserving the old checkout.
- Cached and uncached offline behavior.
- Concurrent materialization of the same cache entry in separate processes.
- Complete old-or-new publication semantics while readers run concurrently.
- `/references-refresh` for Local and Remote References.
- `/reload` lifecycle and autocomplete reconstruction.
- Security regressions for traversal, symlinks, and physical-path writes.
- Filesystem, JSON, metadata, and lock failure regressions.

### Exit criteria

- Integration tests require no public network.
- Concurrent readers never observe staging or an in-progress reset.
- Every required integration scenario in §15.2 is automated.

## Phase 10: Documentation and packaging

Expand `README.md` to document:

- Git-package installation and loading.
- Both configuration locations.
- The complete version 1 schema.
- Merge and all-or-nothing failure behavior.
- Supported remote forms and authentication.
- Local working-tree semantics.
- Ref and Refresh Policy behavior.
- The default seven-day TTL and failure cooldown.
- Offline and stale-cache behavior.
- Alias syntax and quoted paths containing spaces.
- Description-driven agent discoverability.
- TUI autocomplete.
- `/references` and `/references-refresh`.
- Cache location, disposability, and manual deletion.
- The project-trust limitation.
- Read-only workflow behavior and the Bash non-sandbox caveat.
- Unsupported recursive submodules, special LFS management, package-version resolution, pruning, and guaranteed Windows support.

Verify that:

- Runtime dependencies are in `dependencies`.
- Pi packages are represented correctly in `peerDependencies`.
- The `pi.extensions` manifest remains correct.
- Published package files include every production module and required document.

## Completion gate

Before finishing each meaningful phase, run the focused tests for that phase. Before declaring the implementation complete, run:

```bash
npm test
npm run typecheck
npm run lint
npm run test:integration
npm run format:check
```

The release is complete only when all acceptance criteria in §17 of [`SPEC.md`](./SPEC.md) are covered by implementation, automated verification, and user documentation.
