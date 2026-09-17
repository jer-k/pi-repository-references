# Pi Repository References

A TypeScript [Pi](https://github.com/earendil-works/pi) extension for consulting source code from Git repositories outside the active project.

## Development

Requirements:

- Node.js 22.19 or newer
- npm
- Pi

Install dependencies and run the development checks:

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run test:integration
```

Formatting is managed with Oxfmt:

```bash
npm run format
npm run format:check
```

Load the extension directly from this checkout while developing:

```bash
pi -e .
```

Pi executes extension TypeScript directly, so no build step is required. The extension entry point is [`extensions/repository-references.ts`](./extensions/repository-references.ts).

## Installation and loading

Install directly from Git as a user package:

```bash
pi install git:github.com/jer-k/pi-repository-references
```

Use `-l` for a project-local package entry, or load a checkout without installing it:

```bash
pi install -l git:github.com/jer-k/pi-repository-references
pi -e /absolute/path/to/pi-repository-references
```

Pi installs this package's runtime dependencies and loads [`extensions/repository-references.ts`](./extensions/repository-references.ts) through the `pi.extensions` manifest. Review package source before installation because Pi extensions execute with the user's full system permissions.

## Configuration

Repository References reads two optional files:

- Global: `$PI_CODING_AGENT_DIR/repository-references.json` (or Pi's resolved agent directory)
- Project: `<cwd>/.pi/repository-references.json`, only when Pi trusts the project

The project file replaces same-named global entries as complete entries. Its file-wide refresh policy and error-log setting each replace the corresponding global setting when present. Any read, JSON, version, or schema error in either loaded file disables the complete configured set. Physical roots already exposed in the current session remain write-protected while configuration is unavailable, but Alias resolution is disabled with the configured set. Missing files are valid empty inputs.

Configuration uses the strict version 1 schema:

```json
{
  "version": 1,
  "refresh": { "policy": "ttl", "ttl": "7d" },
  "errorLog": { "enabled": true, "ttl": "7d" },
  "references": {
    "effect": {
      "repository": "Effect-TS/effect",
      "ref": "v3.14.21",
      "description": "Effect implementation details to consult when validating Effect APIs",
      "refresh": { "policy": "session" }
    },
    "neighbor": {
      "path": "../../neighboring-repository",
      "description": "Neighboring source used by this project's integration"
    },
    "stable-api": {
      "repository": "git@github.com:example/stable-api.git",
      "refresh": { "policy": "manual" }
    }
  }
}
```

The complete document shape is:

```text
Configuration { version: 1, refresh?: RefreshPolicy, errorLog?: ErrorLog, references: Record<Alias, LocalReference | RemoteReference> }
LocalReference { path: string, description?: string }
RemoteReference { repository: string, ref?: string, description?: string, refresh?: RefreshPolicy }
RefreshPolicy = { policy: "session" } | { policy: "manual" } | { policy: "ttl", ttl: Duration }
ErrorLog = { enabled: false } | { enabled: true, ttl: Duration }
```

Aliases match `^[a-z0-9][a-z0-9._-]*$`. `version` and `references` are required; `references` may be empty. String shorthand is unsupported. Every entry contains exactly one of `path` or `repository`; `ref` and `refresh` are invalid on Local References. Unknown fields and empty Descriptions are errors. TTL values are positive integers ending in `m`, `h`, or `d`. A per-reference policy replaces the file-wide policy, and the default is a seven-day TTL. Error logging is disabled by default; an enabled log requires an explicit TTL, while a disabled log accepts no TTL.

### Local and Remote References

Local paths may be absolute, home-relative, or relative to the containing configuration file. A Local Reference must be the exact root of an existing non-bare Git working tree. It reflects tracked, modified, and untracked non-ignored files; the extension never changes its Git state.

Remote sources accept GitHub shorthand, unambiguous host shorthand, HTTP/HTTPS/SSH/Git URLs, and SCP-style SSH addresses. Authentication uses the user's existing Git credential helpers, SSH agent, keys, and SSH configuration without terminal prompts. An omitted `ref` follows the remote default branch; branches move on refresh, while tags and commits remain pinned.

Managed Checkouts are detached, disposable, and stored under `$PI_CODING_AGENT_DIR/repository-references/`. Complete commit-addressed checkouts are atomically published, shared across projects, and recreated after complete or partial manual cache deletion. Repair retains tag and commit pins rather than moving them. Existing cached source remains usable during refresh and after failures. Offline sessions never attempt repair over the network and report a missing checkout as unavailable. Clone and fetch operations time out after 60 seconds. To reclaim space, exit Pi and delete that cache directory; there is no automatic pruning in the first release.

Refresh policies are:

- `session`: once per Pi session; `/reload` does not repeat the attempt.
- `ttl`: when the last successful refresh is older than the configured TTL.
- `manual`: no automatic refresh after initial materialization.

Missing Managed Checkouts are initially materialized regardless of refresh policy. Failed automatic work has a 15-minute retry cooldown. With `--offline` or `PI_OFFLINE=1`, no network Git operation runs; cached source remains available and uncached remotes are unavailable.

### Alias use and discovery

Use `@neighbor` for the root, `@neighbor/src/file.ts` for descendants, and Pi-style quoting for spaces: `@"neighbor/path with spaces/file.ts"`. The built-in `read`, `grep`, `find`, and `ls` tools resolve known Alias paths in TUI, print, JSON, and RPC modes. Unknown Aliases retain Pi's normal behavior. An explicit mention of an uncached Remote Reference waits for its current initial materialization attempt, but unrelated background work never delays a turn.

A Description makes an available reference proactively visible in the agent's per-turn system prompt. Undescribed references appear there only when explicitly mentioned. The catalogue exposes the physical root, source kind, availability, and read-only guidance without replacing Alias text in the user's prompt.

In TUI mode, `@` autocomplete prepends fuzzy Alias suggestions to Pi's normal project-file results. Typing an exact `@alias/` searches only that reference's current indexed files and derived directories. Local indexes include untracked non-ignored files; remote indexes include tracked files. Completed paths containing spaces are quoted automatically, and unavailable references have root suggestions but no child results.

Repository References are read-only workflow resources. Built-in `edit` and `write` calls are blocked through Alias paths and every current or previously exposed physical reference root, including Pi-normalized `~`, `file://`, leading-`@`, Unicode-space, symlink, and missing-descendant spellings. This is not a filesystem sandbox: arbitrary Bash commands can still mutate writable referenced paths, and the extension does not inspect shell command strings.

### Commands and status

`/references` displays every configured Alias with its credential-safe local or remote source, configured ref or default branch, resolved root, effective Refresh Policy, lifecycle state, last successful remote refresh, and concise current error.

`/references-refresh [alias]` revalidates and reindexes one Local Reference or force-fetches/materializes one Remote Reference. Omit the Alias to process all references; failures are isolated and summarized without stopping unrelated work. Alias argument completion uses bare names without `@`. Explicit remote refresh bypasses TTL and cooldown, but reports offline state without invoking Git. There is no cancellation UI in the first release.

`/references-logs` displays the newest retained Remote Reference clone and refresh errors, including sanitized Git stderr diagnostics and safe process-cause fields. `/references-logs review` submits a user message asking the current Pi agent to read and diagnose the complete log. When enabled, the JSONL file is stored at `$PI_CODING_AGENT_DIR/repository-references/errors.jsonl`. Expired and malformed records are removed atomically at extension startup and before each append; concurrent Pi processes serialize updates. Suspicious credential fields and URL userinfo are redacted, but the log can contain repository identities, local paths, refs, and command diagnostics, so enable it only where that diagnostic data is acceptable.

In TUI mode, active clone and refresh work appears as a compact footer status. Background initial-materialization success and background failures produce notifications; routine successful TTL refreshes do not. Commands and notifications also use Pi's general UI protocol where available, including RPC mode.

> Project-trust limitation: this custom configuration file does not itself trigger Pi's trust prompt. A project without another trust-requiring Pi resource may be treated as trusted according to Pi's normal trust settings.

### Limitations and platform support

The first release does not recursively initialize Git submodules, add special Git LFS management, infer source revisions from installed npm package versions, prune old Managed Checkouts automatically, or watch configuration files. Reload configuration explicitly with Pi's `/reload`. Managed Checkouts must not contain user edits.

macOS and Linux are supported. The implementation uses cross-platform Node filesystem and path APIs, but Windows behavior is not verified or guaranteed.

## Local installation

Install this checkout as a Pi package:

```bash
pi install /absolute/path/to/pi-repository-references
```

For project-local installation, add `-l`:

```bash
pi install -l /absolute/path/to/pi-repository-references
```
