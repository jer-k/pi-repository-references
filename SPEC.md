# Pi Repository References Specification

Status: Decision-complete

## 1. Purpose

Pi Repository References is a Pi extension that lets an agent browse source code from Git repositories outside its active project. It replaces project-local temporary clones with named, reusable references backed either by an existing local Git working tree or by an extension-managed checkout of a Git remote.

A reference is informational and read-only. It is not part of the project being changed, and selecting one does not automatically inject repository contents into the model context.

## 2. Goals

- Configure named Git repository references globally and per project.
- Support existing local Git working trees and remote Git repositories.
- Let users mention references as `@alias` and `@alias/path`.
- Keep Pi's built-in file tools as the agent interface.
- Provide TUI autocomplete without making alias resolution TUI-dependent.
- Share disposable remote checkouts across projects.
- Support configurable automatic refresh and explicit refresh.
- Preserve usable stale source when Git operations fail or Pi is offline.
- Provide stable, documented behavior suitable for installation as a Pi Git package.

## 3. Non-goals

The first release does not:

- Inject referenced file contents automatically into prompts.
- Modify referenced repositories.
- Provide a security sandbox against arbitrary Bash commands.
- Resolve source revisions from installed npm package versions.
- Initialize Git submodules recursively.
- Add special Git LFS management.
- Automatically prune unused Managed Checkouts.
- Publish an npm package.
- Guarantee Windows support.
- Watch configuration files for changes.

## 4. Domain model

The canonical domain language is defined in [`CONTEXT.md`](./CONTEXT.md).

A **Repository Reference** has an **Alias** and is exactly one of:

- A **Local Reference**, backed directly by an existing non-bare Git working tree.
- A **Remote Reference**, backed by a shared, disposable **Managed Checkout**.

A reference may have a **Description**, which makes it proactively discoverable to the agent. A Remote Reference has a **Refresh Policy**.

## 5. Configuration

### 5.1 Locations

The extension reads two optional JSON files:

- Global: `$PI_CODING_AGENT_DIR/repository-references.json`
- Project: `<cwd>/.pi/repository-references.json`

When `PI_CODING_AGENT_DIR` is unset, Pi's resolved agent directory is used, normally `~/.pi/agent`.

The project file is read only when `ctx.isProjectTrusted()` is true. A custom `.pi/repository-references.json` file does not itself trigger Pi's project-trust prompt. Projects without another trust-requiring Pi resource may therefore be considered trusted by Pi without an explicit prompt. This limitation must be documented.

A normal Pi `/reload` re-reads both files, reconciles the reference set, and rebuilds autocomplete indexes. No file watcher is required.

### 5.2 Complete example

```json
{
  "version": 1,
  "refresh": {
    "policy": "ttl",
    "ttl": "7d"
  },
  "references": {
    "effect": {
      "repository": "Effect-TS/effect",
      "ref": "v3.14.21",
      "description": "Use for Effect implementation details when working with Effect APIs"
    },
    "sdk-next": {
      "repository": "git@github.com:example/company-sdk.git",
      "ref": "next",
      "description": "Use when validating behavior against the next SDK release",
      "refresh": {
        "policy": "session"
      }
    },
    "neighbor": {
      "path": "../../neighboring-repository",
      "description": "Use when changing integration behavior shared with the neighboring service"
    },
    "stable-api": {
      "repository": "https://git.example.com/platform/stable-api.git",
      "ref": "2d21d91",
      "refresh": {
        "policy": "manual"
      }
    }
  }
}
```

### 5.3 Document schema

```text
Configuration {
  version: 1
  refresh?: RefreshPolicy
  references: Record<Alias, LocalReference | RemoteReference>
}

LocalReference {
  path: string
  description?: string
}

RemoteReference {
  repository: string
  ref?: string
  description?: string
  refresh?: RefreshPolicy
}

RefreshPolicy =
  | { policy: "session" }
  | { policy: "manual" }
  | { policy: "ttl", ttl: Duration }
```

Requirements:

- `version` is required and must equal `1`.
- `references` is required, though it may be empty.
- Entries use explicit object form; string shorthand is not supported.
- A reference must contain exactly one of `path` or `repository`.
- `ref` and `refresh` are invalid on Local References.
- Unknown fields are errors.
- Empty descriptions are invalid.
- A TTL duration is a positive integer followed by `m`, `h`, or `d`, such as `30m`, `12h`, or `7d`.
- When no applicable refresh setting exists, the default is `{ "policy": "ttl", "ttl": "7d" }`.
- A per-reference refresh policy completely replaces the file-wide policy.

### 5.4 Alias syntax

A configured Alias is a bare lowercase name matching:

```regex
^[a-z0-9][a-z0-9._-]*$
```

The `@` is usage syntax and is not part of the configured Alias:

```text
effect                                  configured Alias
@effect                                 repository root reference
@effect/packages/effect/src/Effect.ts   path reference
```

Aliases are not silently normalized.

### 5.5 Merging

Global and project configurations merge as follows:

- Project aliases replace global aliases with the same name as complete entries; fields are not deep-merged.
- Otherwise, references from both scopes are available.
- A project file-wide refresh policy replaces the global file-wide policy when present.
- If neither file supplies a policy, the built-in seven-day TTL applies.

Configuration loading is all-or-nothing. A JSON parse error, unsupported version, invalid Alias, unknown field, or invalid reference in either loaded file disables the complete reference set, including otherwise valid references from the other scope. The extension reports the config path and validation error.

An absent file is not an error.

### 5.6 Relative paths

A Local Reference `path` may be absolute, home-relative, or relative. Relative paths resolve from the directory containing the configuration file.

A resolved Local Reference must be an existing non-bare Git working tree. It points directly at that working tree and reflects its current tracked, modified, and untracked state. The extension never fetches, checks out, resets, or otherwise mutates a Local Reference.

## 6. Remote repository sources and revisions

### 6.1 Accepted repository forms

A Remote Reference accepts:

- GitHub shorthand: `owner/repository`
- Host shorthand when the first segment is unambiguously a host: `git.example.com/owner/repository`
- HTTPS, HTTP, SSH, and Git protocol URLs
- SCP-style SSH addresses such as `git@github.com:owner/repository.git`

GitHub shorthand resolves to GitHub. Host shorthand resolves to HTTPS. Full URLs and SCP-style addresses retain their configured transport.

Repository normalization must produce a stable cache identity while preserving meaningful transport differences. At minimum it removes redundant trailing separators and `.git`, and normalizes host casing. HTTPS and SSH forms may use separate cache entries.

Authentication relies entirely on the user's existing Git credential helpers, SSH agent, keys, and SSH configuration. Background operations must not prompt interactively for credentials.

### 6.2 Ref behavior

A Remote Reference has one optional generic `ref` that may name a branch, tag, or commit.

- Without `ref`, the reference follows the remote's default branch.
- A branch ref follows the latest commit on that remote branch when refreshed.
- A tag or commit remains pinned unless configuration changes.
- Managed Checkouts are detached and disposable.
- The extension never preserves modifications made inside a Managed Checkout.

An invalid or unavailable ref is a structured materialization error. An existing usable checkout remains available after refresh failure.

## 7. Managed Checkout cache

### 7.1 Location and identity

Remote repositories are materialized under:

```text
$PI_CODING_AGENT_DIR/repository-references/
```

The precise internal layout is private, but a cache entry is keyed by normalized repository identity and configured ref, with an explicit sentinel identity for the remote default branch. Multiple aliases and projects may share one entry.

The cache is disposable. Users must not keep edits in it. Deleting the cache directory is a supported manual way to reclaim space; references are recreated when next needed.

### 7.2 Publication and concurrency

Clone, fetch, checkout, reset, and metadata mutation are serialized per cache entry with an inter-process lock.

Readers must observe either the complete previously published checkout or the complete newly published checkout, never an in-progress reset. A failed, timed-out, or interrupted operation must not damage or replace an existing usable checkout. Incomplete initial clones must not become visible as ready references.

The implementation may use commit-addressed checkout directories and atomically published metadata or another mechanism that provides the same observable guarantee.

Old checkout cleanup is not required in the first release. Automatic cross-project cache pruning is out of scope.

### 7.3 Clone strategy

Initial remote materialization attempts a partial clone using `--filter=blob:none`. If the remote does not support filtering, the extension transparently falls back to a normal clone strategy capable of resolving arbitrary configured refs.

Submodules are not recursively initialized. The extension adds no Git LFS-specific behavior; normal installed Git/LFS behavior may apply.

### 7.4 Git timeout

Each clone or fetch operation has a fixed 60-second timeout. There is no cancellation UI in the first release.

Agent-turn work should still stop waiting when Pi aborts the turn where practical, but the specification does not require an interactive cancellation workflow for `/references-refresh`.

## 8. Refresh behavior

### 8.1 Policies

Remote References support three policies:

- `session`: attempt one background refresh per Pi session.
- `ttl`: attempt a background refresh when the last successful refresh is older than the configured TTL.
- `manual`: perform no automatic network refresh.

`/reload` does not cause a second `session` refresh when that reference was already refreshed in the same Pi session.

A cached checkout is usable immediately while a background refresh runs. A prompt mentioning that reference does not wait for refresh. Waiting occurs only when no usable Managed Checkout exists.

### 8.2 Hybrid startup behavior

At `session_start`, the extension:

1. Loads and validates configuration.
2. Resolves and validates Local References.
3. Opens usable Managed Checkouts immediately.
4. Starts missing clones and policy-due refreshes in the background.
5. Builds or rebuilds autocomplete indexes as roots become available.

An unmentioned background operation never delays an agent turn. If a prompt explicitly mentions an uncached Remote Reference, the turn waits for that reference's current materialization attempt, subject to the Git timeout.

### 8.3 Failure cooldown

The cache records both the last successful refresh and the last automatic attempt. After a failed automatic refresh, further automatic attempts are suppressed for 15 minutes even when the TTL remains expired.

An explicit `/references-refresh` bypasses TTL checks and the failure cooldown.

### 8.4 Offline behavior

When Pi is offline through `--offline` or `PI_OFFLINE`, the extension performs no automatic network Git operations.

- Existing Managed Checkouts remain available and are marked stale when applicable.
- Uncached Remote References are unavailable.
- Explicit refresh reports that Pi is offline rather than attempting network access.
- Offline state never deletes or invalidates usable cached source.

## 9. Agent interaction

### 9.1 Reference syntax

Users and the agent refer to a root or descendant path with:

```text
@alias
@alias/path/to/file.ts
```

Paths containing spaces use Pi-style quoting around the complete alias path:

```text
@"alias/examples/path with spaces/file.ts"
```

Alias subpaths must remain inside the Repository Reference root. Resolution rejects lexical `..` traversal and symlinks whose real target escapes the root.

Unknown aliases are left to Pi's normal prompt and path behavior.

### 9.2 Ambient discoverability

Before an agent turn, the extension adds a compact repository-reference catalogue to the system prompt.

- Every available reference with a Description is advertised proactively.
- An explicitly mentioned reference is included for that turn even without a Description.
- Undescribed and unmentioned references consume no ambient context.
- The catalogue includes Alias, resolved root, Description when present, source kind, and availability state as needed.
- Guidance tells the agent that references are read-only and should be inspected with Pi's built-in read-oriented tools.

A Description should state both what the repository contains and when it should be consulted. This discoverability behavior must be prominent in user documentation.

If an explicitly mentioned uncached reference cannot materialize, the Alias remains in the user's prompt and the agent receives a concise availability error with the cause.

### 9.3 Built-in tool resolution

The extension does not register a parallel repository toolset. It makes path parameters on Pi's built-in tools Alias-aware through `tool_call` hooks.

Alias rewriting applies to the path-bearing inputs of:

- `read`
- `grep`
- `find`
- `ls`

For example:

```text
read({ path: "@effect/src/Effect.ts" })
```

is rewritten to the corresponding absolute Local Reference or Managed Checkout path before execution.

The hook resolves only explicit known Alias syntax. It does not reinterpret ordinary relative project paths.

The extension does not rewrite paths embedded in arbitrary Bash command strings. Ambient context exposes the resolved physical root when Bash is genuinely required.

### 9.4 Read-only guardrail

Repository References are read-only workflow resources.

- The extension never mutates Local References.
- Git cache maintenance is extension-owned and is not an agent edit.
- `edit` and `write` calls resolving beneath any reference root are blocked.
- Guidance tells the agent not to modify references.
- The guard also recognizes physical Managed Checkout paths exposed through ambient context.

This is not a security sandbox. An arbitrary Bash command can still mutate a writable filesystem location, including a Local Reference. The extension does not attempt unreliable shell-command classification and must document this limitation.

## 10. TUI autocomplete

Autocomplete is a TUI enhancement implemented with `ctx.ui.addAutocompleteProvider()`. Alias resolution itself works in interactive, print, JSON, and RPC modes.

### 10.1 Root completion

Typing `@` or an Alias prefix merges reference suggestions with Pi's normal project-file suggestions:

```text
@eff
  @effect/       Effect source matching our installed version
  effect-test.ts project file
```

Reference aliases appear before delegated project-file results. Descriptions appear beside aliases when configured.

The first release has no `hidden` concept: every configured Alias is eligible for root autocomplete.

### 10.2 Reference completion

Once the input contains an exact Alias followed by `/`, completion searches only inside that reference:

```text
@effect/packages/effect/src/eff
  @effect/packages/effect/src/Effect.ts
```

Completion preserves the Alias in the editor and session; it never exposes the cache path as the inserted value. Pi-style quoting is applied for paths containing spaces.

Indexes are built as follows:

- Remote Reference: tracked files from `git ls-files` plus derived directory entries.
- Local Reference: tracked files and untracked non-ignored files, equivalent to `git ls-files --cached --others --exclude-standard`, plus derived directory entries.

Results are fuzzy-ranked and bounded consistently with Pi's autocomplete UI. An unavailable reference may appear at the root with its current state, but has no child results until materialized.

## 11. Commands and status

### 11.1 `/references`

Displays every configured Alias and enough status to diagnose it:

- Local or remote source
- Configured ref or default branch
- Resolved root when available
- Effective Refresh Policy
- Ready, cloning, refreshing, stale, offline, or error state
- Last successful refresh for remote references
- Concise current error when present

### 11.2 `/references-refresh [alias]`

- With an Alias, refreshes or revalidates only that reference.
- Without an Alias, processes all configured references.
- Argument autocomplete suggests Aliases.
- For a Remote Reference, it bypasses TTL and failure cooldown and performs a fetch/materialization unless Pi is offline.
- For a Local Reference, it revalidates the Git working tree and rebuilds the autocomplete index without fetching or changing Git state.
- There is no cancellation UI in the first release.

### 11.3 Background UX

- A compact footer status is shown while clone or refresh work is active.
- The extension notifies when a previously missing repository becomes ready.
- Failures produce notifications.
- Successful routine TTL refreshes do not produce notifications.
- Full details remain available through `/references`.

## 12. Error behavior

Expected operational failures are structured errors, including at least:

- Configuration read, parse, version, and validation errors
- Invalid or unavailable local repositories
- Invalid aliases and path escapes
- Repository-source parsing errors
- Clone, fetch, ref-resolution, authentication, timeout, lock, and publication errors
- Offline materialization errors
- Indexing errors

Configuration errors disable the complete reference set. Runtime failures are isolated to the affected reference and preserve any previously usable Managed Checkout.

Authentication errors should suggest reproducing the operation with normal `git clone` or `git fetch` so the user can diagnose their Git/SSH setup.

Implementation must follow the repository's structured `Result<T, E>` error-handling conventions and retain underlying causes.

## 13. Modes and lifecycle

- Interactive TUI: full functionality, commands, notifications, footer status, and autocomplete.
- Print and JSON modes: configuration, ambient guidance, materialization, and tool Alias rewriting work; TUI-only methods are not required.
- RPC mode: core behavior works; autocomplete and terminal-only UI are absent.
- `/reload`: rereads config, reconstructs state, reconciles references, restores status, and rebuilds autocomplete without leaking old session resources.
- Session shutdown: waits only for required cleanup and releases session-owned resources; disposable background processes must not be started from the extension factory.

## 14. Packaging and platform support

The project is structured as a Pi package installable from Git, with its extension declared in the `pi.extensions` package manifest. Runtime dependencies belong in `dependencies`; Pi packages belong in `peerDependencies` as required by Pi's package conventions.

The first release officially supports macOS and Linux. Implementations should use cross-platform Node path and filesystem APIs and avoid unnecessary shell parsing so future Windows support does not require redesign. Windows behavior is unverified and not guaranteed.

## 15. Verification requirements

The implementation requires automated coverage for success and structured failure behavior.

### 15.1 Unit coverage

- Global/project parsing and all-or-nothing validation
- Strict unknown-field rejection
- Alias validation and quoted syntax
- Whole-entry project override behavior
- Relative, absolute, and home-relative local paths
- Refresh-policy inheritance and duration parsing
- TTL expiry, session refresh, manual policy, and failure cooldown
- Repository source normalization and cache identity
- Path traversal and escaping-symlink rejection
- Ambient discoverability rules
- Tool-call rewriting and read-only blocking
- Autocomplete composition, fuzzy matching, directories, spaces, and local untracked files

### 15.2 Integration coverage

Integration tests use temporary local Git repositories and remotes without depending on the public network. They cover:

- Initial materialization and ref selection
- Default branch, moving branch, tag, and commit behavior
- Partial-clone fallback
- Stale-cache use during refresh
- Refresh failure and timeout preserving the old checkout
- Offline cached and uncached behavior
- Concurrent materialization of the same cache entry
- Complete old-or-new publication semantics
- `/references-refresh` behavior for local and remote references
- `/reload` lifecycle and autocomplete reconstruction

Security-sensitive path behavior, filesystem failures, JSON failures, and concurrent mutations require regression tests.

## 16. Documentation requirements

`README.md` must document:

- Git-package installation and loading
- Both configuration locations
- Complete version 1 schema
- Global/project merge and all-or-nothing failure behavior
- Remote source formats and authentication expectations
- Local working-tree semantics
- Ref and Refresh Policy behavior, including the seven-day default
- Offline and stale-cache behavior
- Alias syntax and paths containing spaces
- Description-driven agent discoverability
- TUI autocomplete behavior
- `/references` and `/references-refresh`
- Cache location, disposability, and manual deletion
- Project-trust limitation for the custom project config file
- Read-only workflow guarantee and Bash non-sandbox caveat
- Unsupported submodule, LFS-management, package-version resolution, pruning, and Windows behavior

## 17. Acceptance criteria

The first release satisfies this specification when:

1. A user can configure global and project Local and Remote References using the version 1 JSON schema.
2. A prompt can use `@alias` or `@alias/path` in every Pi mode, and active built-in read-oriented tools resolve it correctly.
3. The TUI merges Alias completion with normal project-file completion and searches within ready references.
4. Described references are advertised proactively; undescribed references are advertised only when explicitly mentioned.
5. Cached remote source remains usable during background refresh, offline operation, and refresh failure.
6. Concurrent refreshes never expose an in-progress checkout.
7. `edit` and `write` are blocked beneath reference roots, with the Bash limitation documented.
8. Refresh policies, explicit commands, reload, timeout, cooldown, and status behavior match this specification.
9. Required automated tests pass without public-network access.
10. README documentation covers the complete user-visible contract and limitations.
