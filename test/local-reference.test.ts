import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { parseAlias } from "../extensions/repository-references/alias.ts";
import { createNodeGitProcess } from "../extensions/repository-references/git-process.ts";
import { openLocalReference } from "../extensions/repository-references/local-reference.ts";
import { createNodeRepositoryFileSystem } from "../extensions/repository-references/node-file-system.ts";
import {
  isProtectedPhysicalPath,
  parseAliasPath,
  resolveAliasPath,
} from "../extensions/repository-references/reference-path.ts";

const executeFile = promisify(execFile);
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Local Reference validation and indexing", () => {
  test("indexes tracked, modified, and untracked non-ignored files plus directories", async () => {
    const root = await createWorkingTree();
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "src", "tracked.ts"), "tracked\n");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await writeFile(join(root, "src", "tracked.ts"), "modified\n");
    await writeFile(join(root, "src", "nested", "untracked.ts"), "untracked\n");
    await writeFile(join(root, "ignored.txt"), "ignored\n");

    const result = await open(root);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect([...result.value.index.files].sort()).toEqual([".gitignore", "src/nested/untracked.ts", "src/tracked.ts"]);
      expect([...result.value.index.directories].sort()).toEqual(["src", "src/nested"]);
    }
  });

  test("rejects a descendant directory instead of silently accepting the enclosing repository", async () => {
    const root = await createWorkingTree();
    const nested = join(root, "nested");
    await mkdir(nested);

    const result = await open(nested);

    expect(result.status).toBe("error");
    if (result.status === "error" && result.error._tag === "InvalidLocalReferenceError") {
      expect(result.error.reason).toBe("not-working-tree-root");
    }
  });

  test("returns structured missing and bare repository failures", async () => {
    const root = await makeTemporaryDirectory();
    const missing = await open(join(root, "missing"));
    const barePath = join(root, "bare.git");
    await git(root, "init", "--bare", barePath);
    const bare = await open(barePath);

    expect(missing.status).toBe("error");
    if (missing.status === "error" && missing.error._tag === "InvalidLocalReferenceError") {
      expect(missing.error.reason).toBe("missing");
    }
    expect(bare.status).toBe("error");
    if (bare.status === "error" && bare.error._tag === "InvalidLocalReferenceError") {
      expect(["not-git-working-tree", "bare-repository"]).toContain(bare.error.reason);
    }
  });
});

describe("Alias path parsing and containment", () => {
  test("parses roots, descendants, and Pi-style quoted paths", () => {
    expect(parseAliasPath("@source")).toMatchObject({
      status: "ok",
      value: { _tag: "alias-path", alias: "source", subpath: "" },
    });
    expect(parseAliasPath("@source/src/file.ts")).toMatchObject({
      status: "ok",
      value: { _tag: "alias-path", alias: "source", subpath: "src/file.ts" },
    });
    expect(parseAliasPath('@"source/examples/path with spaces/file.ts"')).toMatchObject({
      status: "ok",
      value: {
        _tag: "alias-path",
        alias: "source",
        subpath: "examples/path with spaces/file.ts",
      },
    });
  });

  test.each(["@source/../secret", "@source/a/../../secret", "@source\\..\\secret"])(
    "rejects lexical traversal in %s",
    (input) => {
      const result = parseAliasPath(input);

      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error._tag).toBe("InvalidReferencePathError");
    }
  );

  test("leaves ordinary paths and syntactically unknown Alias forms untouched", () => {
    expect(parseAliasPath("src/file.ts")).toEqual({ status: "ok", value: { _tag: "not-alias-path" } });
    expect(parseAliasPath("@Unknown/file.ts")).toEqual({
      status: "ok",
      value: { _tag: "not-alias-path" },
    });
  });

  test("resolves missing descendants through the nearest existing in-root parent", async () => {
    const root = await makeTemporaryDirectory();
    const existing = join(root, "existing");
    await mkdir(existing);
    const parsed = parseAliasPath("@source/existing/missing/file.ts");
    const fileSystem = createNodeRepositoryFileSystem();
    const canonicalRoot = await fileSystem.realPath(root);

    expect(parsed.status).toBe("ok");
    expect(canonicalRoot.status).toBe("ok");
    if (parsed.status === "ok" && parsed.value._tag === "alias-path" && canonicalRoot.status === "ok") {
      const result = await resolveAliasPath(parsed.value, canonicalRoot.value, fileSystem);
      expect(result).toMatchObject({
        status: "ok",
        value: join(canonicalRoot.value, "existing", "missing", "file.ts"),
      });
    }
  });

  test("rejects an escaping symlink for existing and missing descendants", async () => {
    const workspace = await makeTemporaryDirectory();
    const root = join(workspace, "root");
    const outside = join(workspace, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret.ts"), "secret");
    await symlink(outside, join(root, "escape"));

    for (const input of ["@source/escape/secret.ts", "@source/escape/missing.ts"]) {
      const parsed = parseAliasPath(input);
      expect(parsed.status).toBe("ok");
      if (parsed.status === "ok" && parsed.value._tag === "alias-path") {
        const result = await resolveAliasPath(parsed.value, root, createNodeRepositoryFileSystem());
        expect(result.status).toBe("error");
        if (result.status === "error") expect(result.error._tag).toBe("ReferencePathEscapeError");
      }
    }
  });

  test("recognizes lexical roots and symlink aliases into protected physical roots", async () => {
    const workspace = await makeTemporaryDirectory();
    const root = join(workspace, "root");
    await mkdir(root);
    await writeFile(join(root, "file.ts"), "source");
    const alias = join(workspace, "root-link");
    await symlink(root, alias);
    const fileSystem = createNodeRepositoryFileSystem();
    const canonicalRoot = await fileSystem.realPath(root);
    if (canonicalRoot.status === "error") throw canonicalRoot.error;
    const roots = new Set([canonicalRoot.value]);

    expect(await isProtectedPhysicalPath(join(root, "new.ts"), workspace, roots, fileSystem)).toBe(true);
    expect(await isProtectedPhysicalPath(join(alias, "file.ts"), workspace, roots, fileSystem)).toBe(true);
    expect(await isProtectedPhysicalPath(join(workspace, "project.ts"), workspace, roots, fileSystem)).toBe(false);
  });
});

async function open(path: string) {
  const alias = parseAlias("source");
  if (alias.status === "error") throw alias.error;
  return openLocalReference({
    alias: alias.value,
    configuredPath: path,
    fileSystem: createNodeRepositoryFileSystem(),
    git: createNodeGitProcess(),
  });
}

async function createWorkingTree(): Promise<string> {
  const root = await makeTemporaryDirectory();
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  return root;
}

async function git(cwd: string, ...arguments_: ReadonlyArray<string>): Promise<void> {
  await executeFile("git", arguments_, { cwd });
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "local-reference-"));
  temporaryDirectories.push(path);
  return path;
}
