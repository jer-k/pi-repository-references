import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { createNodeGitProcess } from "../extensions/repository-references/git-process.ts";
import { createNodeRepositoryFileSystem } from "../extensions/repository-references/node-file-system.ts";
import {
  appendReferenceCatalogue,
  catalogueExposedRoots,
  renderReferenceCatalogue,
} from "../extensions/repository-references/reference-catalogue.ts";
import {
  resolveSessionReadPath,
  shouldBlockSessionWrite,
  startRepositoryReferencesSession,
} from "../extensions/repository-references/repository-references-service.ts";

const executeFile = promisify(execFile);
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Local Reference tool-path service", () => {
  test("rewrites known roots and descendants while leaving unknown Aliases untouched", async () => {
    const fixture = await createSessionFixture();

    const root = await resolveSessionReadPath(fixture.session, "@source", fixture.fileSystem);
    const descendant = await resolveSessionReadPath(
      fixture.session,
      '@"source/path with spaces/file.ts"',
      fixture.fileSystem
    );
    const unknown = await resolveSessionReadPath(fixture.session, "@unknown/file.ts", fixture.fileSystem);

    expect(root).toMatchObject({ status: "ok", value: { _tag: "resolved", path: fixture.repository } });
    expect(descendant).toMatchObject({
      status: "ok",
      value: { _tag: "resolved", path: join(fixture.repository, "path with spaces", "file.ts") },
    });
    expect(unknown).toEqual({ status: "ok", value: { _tag: "unchanged" } });
  });

  test("blocks known Alias and physical Local Reference writes but not project writes", async () => {
    const fixture = await createSessionFixture();

    expect(
      await shouldBlockSessionWrite(fixture.session, "@source/new.ts", fixture.workspace, fixture.fileSystem)
    ).toEqual({ status: "ok", value: true });
    expect(
      await shouldBlockSessionWrite(
        fixture.session,
        join(fixture.repository, "new.ts"),
        fixture.workspace,
        fixture.fileSystem
      )
    ).toEqual({ status: "ok", value: true });
    expect(
      await shouldBlockSessionWrite(
        fixture.session,
        join(fixture.workspace, "project.ts"),
        fixture.workspace,
        fixture.fileSystem
      )
    ).toEqual({ status: "ok", value: false });
  });

  test("advertises described ready references and explicitly mentioned undescribed or unavailable references", async () => {
    const fixture = await createSessionFixture();

    const ambient = renderReferenceCatalogue({
      session: fixture.session,
      mentionedAliases: new Set(),
      materializationFailures: new Map(),
    });
    const explicit = renderReferenceCatalogue({
      session: fixture.session,
      mentionedAliases: new Set(["hidden", "remote"]),
      materializationFailures: new Map([["remote", "clone unavailable"]]),
    });

    expect(ambient).toContain("@source");
    expect(ambient).toContain("Source implementation details");
    expect(ambient).not.toContain("@hidden");
    expect(ambient).not.toContain("@remote");
    expect(explicit).toContain("@hidden");
    expect(explicit).toContain("@remote");
    expect(explicit).toContain("clone unavailable");
    expect(explicit).toContain("read-only");
    expect(catalogueExposedRoots(fixture.session, new Set(["hidden"]))).toEqual(new Set([fixture.repository]));
  });

  test("appends catalogue text without changing the existing prompt", () => {
    const original = "base system prompt";
    const catalogue = "Repository References (read-only):\n- @source";

    expect(appendReferenceCatalogue(original, catalogue)).toBe(`${original}\n\n${catalogue}`);
    expect(original).toBe("base system prompt");
  });

  test("blocks reads through known unavailable remote Aliases with a concise tagged error", async () => {
    const fixture = await createSessionFixture();
    const result = await resolveSessionReadPath(fixture.session, "@remote/src/file.ts", fixture.fileSystem);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ReferenceUnavailableError");
    }
  });
});

async function createSessionFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "repository-reference-service-"));
  temporaryDirectories.push(workspace);
  const repository = join(workspace, "source");
  const agentDirectory = join(workspace, "agent");
  await mkdir(repository);
  await mkdir(agentDirectory);
  await executeFile("git", ["init"], { cwd: repository });
  await executeFile("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await executeFile("git", ["config", "user.name", "Test"], { cwd: repository });
  await writeFile(join(repository, "tracked.ts"), "source\n");
  await executeFile("git", ["add", "."], { cwd: repository });
  await executeFile("git", ["commit", "-m", "initial"], { cwd: repository });
  await writeFile(
    join(agentDirectory, "repository-references.json"),
    JSON.stringify({
      version: 1,
      references: {
        source: { path: repository, description: "Source implementation details" },
        hidden: { path: repository },
        remote: { repository: "owner/repo" },
      },
    })
  );

  const fileSystem = createNodeRepositoryFileSystem();
  const started = await startRepositoryReferencesSession({
    agentDirectory,
    cwd: workspace,
    homeDirectory: workspace,
    projectTrusted: false,
    fileSystem,
    fullFileSystem: fileSystem,
    git: createNodeGitProcess(),
  });
  if (started.status === "error") {
    throw started.error;
  }
  const source = started.value.references.get("source");
  if (source === undefined || source._tag !== "ready-local") {
    throw new Error("Expected ready Local Reference");
  }
  return { workspace, repository: source.local.root, fileSystem, session: started.value };
}
