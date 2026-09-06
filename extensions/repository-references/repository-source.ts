import { Result, type Result as ResultType } from "better-result";

import { RepositorySourceParseError } from "../repository-reference-errors.ts";

declare const cloneSourceBrand: unique symbol;

/** A Git clone source that may contain credentials and must not be logged or diagnosed. */
export type RepositoryCloneSource = string & { readonly [cloneSourceBrand]: true };

/** A parsed Git repository source and its credential-free stable cache identity. */
export type RepositorySource = {
  /** Configured or inferred transport. */
  readonly transport: "http" | "https" | "ssh" | "git";
  /** Clone input retained for the Git adapter and excluded from errors and metadata. */
  readonly cloneSource: RepositoryCloneSource;
  /** Normalized, credential-free identity suitable for cache keys and diagnostics. */
  readonly identity: string;
};

const URL_PROTOCOLS: ReadonlyMap<string, RepositorySource["transport"]> = new Map([
  ["http:", "http"],
  ["https:", "https"],
  ["ssh:", "ssh"],
  ["git:", "git"],
] as const);

/**
 * Parse supported GitHub shorthand, host shorthand, URL, or SCP-style repository input.
 *
 * @param input - Untrusted configured repository source.
 * @returns A source preserving transport and a normalized safe identity, or a parse error.
 */
export function parseRepositorySource(input: string): ResultType<RepositorySource, RepositorySourceParseError> {
  const source = input.trim();
  if (source.length === 0 || source !== input) {
    return invalidSource("repository source must be non-empty and have no surrounding whitespace");
  }

  if (looksLikeUrl(source)) {
    return parseUrlSource(source);
  }

  const scpSource = parseScpSource(source);
  if (scpSource !== undefined) {
    return Result.ok(scpSource);
  }

  const shorthand = source.replace(/\/+$/u, "");
  const segments = shorthand.split("/");
  if (segments.length === 2 && segments.every(isRepositorySegment)) {
    return Result.ok(
      makeSource("https", `https://github.com/${shorthand}`, `https://github.com/${normalizePath(shorthand)}`)
    );
  }

  const host = segments[0];
  const repositoryPath = segments.slice(1);
  if (
    host !== undefined &&
    isUnambiguousHost(host) &&
    repositoryPath.length >= 2 &&
    repositoryPath.every(isRepositorySegment)
  ) {
    const normalizedHost = host.toLowerCase();
    const normalizedPath = normalizePath(repositoryPath.join("/"));
    return Result.ok(
      makeSource(
        "https",
        `https://${normalizedHost}/${repositoryPath.join("/")}`,
        `https://${normalizedHost}/${normalizedPath}`
      )
    );
  }

  return invalidSource("unsupported or ambiguous repository source");
}

/** Reveal a configured clone source only at the Git process adapter boundary. */
export function revealRepositoryCloneSource(source: RepositoryCloneSource): string {
  return source;
}

/** Parse one supported absolute URL source. */
function parseUrlSource(input: string): ResultType<RepositorySource, RepositorySourceParseError> {
  if (!URL.canParse(input)) {
    return invalidSource("invalid repository URL");
  }
  const parsed = new URL(input);

  const transport = URL_PROTOCOLS.get(parsed.protocol);
  if (transport === undefined || parsed.hostname.length === 0) {
    return invalidSource("repository URL must use http, https, ssh, or git");
  }

  const repositoryPath = normalizePath(parsed.pathname);
  if (repositoryPath.length === 0) {
    return invalidSource("repository URL must include a repository path");
  }

  const username = transport === "ssh" && parsed.username.length > 0 ? `${parsed.username}@` : "";
  const identity = `${transport}://${username}${parsed.host.toLowerCase()}/${repositoryPath}`;
  return Result.ok(makeSource(transport, input, identity));
}

/** Parse SCP-style SSH syntax when the input is unambiguous. */
function parseScpSource(input: string): RepositorySource | undefined {
  const separator = input.indexOf(":");
  if (separator <= 0 || input.includes("://")) {
    return undefined;
  }

  const authority = input.slice(0, separator);
  const repositoryPath = input.slice(separator + 1);
  const at = authority.lastIndexOf("@");
  const username = at >= 0 ? authority.slice(0, at) : "";
  const host = at >= 0 ? authority.slice(at + 1) : authority;
  if (
    host.length === 0 ||
    repositoryPath.length === 0 ||
    repositoryPath.includes("\\") ||
    host.includes("/") ||
    host.includes(" ") ||
    (username.length === 0 && !isUnambiguousHost(host))
  ) {
    return undefined;
  }

  const normalizedPath = normalizePath(repositoryPath);
  if (normalizedPath.length === 0) {
    return undefined;
  }
  const normalizedAuthority = `${username.length > 0 ? `${username}@` : ""}${host.toLowerCase()}`;
  return makeSource("ssh", input, `ssh://${normalizedAuthority}/${normalizedPath}`);
}

/** Create a source after its transport and identity invariants have been established. */
function makeSource(transport: RepositorySource["transport"], cloneSource: string, identity: string): RepositorySource {
  // SAFETY: Clone sources are branded only after parsing; revealing is restricted to the Git adapter boundary.
  const protectedCloneSource = cloneSource as RepositoryCloneSource;
  return { transport, cloneSource: protectedCloneSource, identity };
}

/** Normalize repository path separators and a terminal `.git` suffix. */
function normalizePath(path: string): string {
  const withoutSeparators = path.replace(/^\/+|\/+$/g, "");
  return withoutSeparators.endsWith(".git") ? withoutSeparators.slice(0, -".git".length) : withoutSeparators;
}

/** Return whether a shorthand segment is non-empty and unambiguous. */
function isRepositorySegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && !/[\\\s:@]/u.test(segment);
}

/** Return whether a shorthand's first segment clearly denotes a host. */
function isUnambiguousHost(segment: string): boolean {
  return segment === "localhost" || segment.includes(".");
}

/** Return whether input begins with a URI scheme delimiter. */
function looksLikeUrl(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(input);
}

/** Create a credential-free repository-source parse failure. */
function invalidSource(reason: string): ResultType<never, RepositorySourceParseError> {
  return Result.err(
    new RepositorySourceParseError({
      reason,
      message: `Invalid repository source: ${reason}`,
    })
  );
}
