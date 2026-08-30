import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Result, type Result as ResultType } from "better-result";

import {
  InvalidReferencePathError,
  ReferencePathEscapeError,
  ReferencePathResolutionError,
  type RepositoryFileSystemError,
} from "../repository-reference-errors.ts";
import { parseAlias, type Alias } from "./alias.ts";
import type { RepositoryFileSystem } from "./ports.ts";

/** A parsed explicit Repository Reference root or descendant path. */
export type AliasPath = {
  readonly _tag: "alias-path";
  readonly alias: Alias;
  readonly subpath: string;
  readonly original: string;
};

/** Result for input that does not use valid explicit Alias syntax. */
export type NotAliasPath = { readonly _tag: "not-alias-path" };

/**
 * Parse explicit `@alias`, `@alias/path`, and Pi-style `@"alias/path with spaces"` syntax.
 *
 * Non-Alias input is returned as `not-alias-path` so unknown paths remain available to Pi.
 */
export function parseAliasPath(input: string): ResultType<AliasPath | NotAliasPath, InvalidReferencePathError> {
  if (!input.startsWith("@")) return Result.ok({ _tag: "not-alias-path" });

  let body: string;
  if (input.startsWith('@"')) {
    if (input.length < 4 || !input.endsWith('"')) {
      return invalidPath(input, "invalid-quoting");
    }
    body = input.slice(2, -1);
  } else {
    body = input.slice(1);
  }

  const slash = body.search(/[\\/]/u);
  const aliasInput = slash < 0 ? body : body.slice(0, slash);
  const alias = parseAlias(aliasInput);
  if (alias.status === "error") return Result.ok({ _tag: "not-alias-path" });

  const subpath = slash < 0 ? "" : body.slice(slash + 1);
  if (subpath.split(/[\\/]/u).includes("..")) {
    return invalidPath(input, "lexical-traversal");
  }

  return Result.ok({ _tag: "alias-path", alias: alias.value, subpath, original: input });
}

/**
 * Resolve a parsed known Alias path through symbolic links while enforcing root containment.
 *
 * Missing descendants are resolved through their nearest existing parent so an escaping parent
 * symlink is rejected before a built-in tool receives the path.
 */
export async function resolveAliasPath(
  aliasPath: AliasPath,
  canonicalRoot: string,
  fileSystem: Pick<RepositoryFileSystem, "realPath">
): Promise<ResultType<string, ReferencePathEscapeError | ReferencePathResolutionError>> {
  const lexicalTarget = resolve(canonicalRoot, aliasPath.subpath);
  if (!isContained(canonicalRoot, lexicalTarget)) {
    return escaped(aliasPath, canonicalRoot);
  }

  const canonicalTarget = await canonicalizeThroughNearestParent(lexicalTarget, fileSystem);
  if (canonicalTarget.status === "error") {
    return Result.err(
      new ReferencePathResolutionError({
        alias: aliasPath.alias,
        requestedPath: aliasPath.original,
        cause: canonicalTarget.error,
        message: `Could not resolve Repository Reference path ${aliasPath.original}`,
      })
    );
  }
  if (!isContained(canonicalRoot, canonicalTarget.value)) {
    return escaped(aliasPath, canonicalRoot);
  }
  return Result.ok(canonicalTarget.value);
}

/**
 * Return whether a physical path is beneath any protected canonical reference root.
 *
 * Lexical containment is checked first. Existing paths and nearest existing parents are then
 * canonicalized so alternate symlink paths into a protected root are also recognized.
 */
export async function isProtectedPhysicalPath(
  input: string,
  cwd: string,
  canonicalRoots: ReadonlySet<string>,
  fileSystem: Pick<RepositoryFileSystem, "realPath">
): Promise<boolean> {
  const absolutePath = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  if ([...canonicalRoots].some((root) => isContained(root, absolutePath))) return true;

  const canonical = await canonicalizeThroughNearestParent(absolutePath, fileSystem);
  return canonical.status === "ok" && [...canonicalRoots].some((root) => isContained(root, canonical.value));
}

/** Canonicalize an existing target or its nearest existing parent plus missing suffix. */
async function canonicalizeThroughNearestParent(
  target: string,
  fileSystem: Pick<RepositoryFileSystem, "realPath">
): Promise<ResultType<string, RepositoryFileSystemError>> {
  let existingCandidate = target;
  const missingSegments: Array<string> = [];
  while (true) {
    const canonical = await fileSystem.realPath(existingCandidate);
    if (canonical.status === "ok") {
      return Result.ok(join(canonical.value, ...missingSegments.reverse()));
    }
    if (!isMissingCause(canonical.error.cause)) return Result.err(canonical.error);

    const parent = dirname(existingCandidate);
    if (parent === existingCandidate) return Result.err(canonical.error);
    missingSegments.push(basename(existingCandidate));
    existingCandidate = parent;
  }
}

/** Test canonical or lexical containment without vulnerable string-prefix comparisons. */
function isContained(root: string, target: string): boolean {
  const descendant = relative(root, target);
  return descendant === "" || (!descendant.startsWith("..") && !isAbsolute(descendant));
}

/** Construct a path escape failure. */
function escaped(aliasPath: AliasPath, root: string): ResultType<never, ReferencePathEscapeError> {
  return Result.err(
    new ReferencePathEscapeError({
      alias: aliasPath.alias,
      requestedPath: aliasPath.original,
      root,
      message: `Repository Reference path escapes @${aliasPath.alias}`,
    })
  );
}

/** Construct an Alias syntax failure. */
function invalidPath(
  input: string,
  reason: InvalidReferencePathError["reason"]
): ResultType<never, InvalidReferencePathError> {
  return Result.err(
    new InvalidReferencePathError({
      input,
      reason,
      message: `Invalid Repository Reference path ${JSON.stringify(input)}: ${reason}`,
    })
  );
}

/** Return whether a filesystem cause denotes a missing descendant. */
function isMissingCause(cause: RepositoryFileSystemError["cause"]): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
