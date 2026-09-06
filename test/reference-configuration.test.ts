import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Result } from "better-result";
import { afterEach, describe, expect, test } from "vitest";

import { RepositoryFileSystemError } from "../extensions/repository-reference-errors.ts";
import { createNodeRepositoryFileSystem } from "../extensions/repository-references/node-file-system.ts";
import {
  CONFIG_FILE_NAME,
  loadRepositoryReferencesConfiguration,
  mergeConfigurationDocuments,
  parseConfigurationDocument,
} from "../extensions/repository-references/reference-configuration.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("strict version 1 configuration parsing", () => {
  test("parses complete Local and Remote entries and resolves every Local path form", () => {
    const result = parseConfigurationDocument(
      {
        version: 1,
        refresh: { policy: "ttl", ttl: "12h" },
        references: {
          relative: { path: "../neighbor", description: "Neighbor source" },
          absolute: { path: "/opt/source" },
          home: { path: "~/source" },
          remote: {
            repository: "Effect-TS/effect",
            ref: "v1",
            description: "Effect implementation",
            refresh: { policy: "manual" },
          },
        },
      },
      "/workspace/.pi/repository-references.json",
      "/home/person"
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.references.get("relative")).toMatchObject({
        _tag: "local",
        path: "/workspace/neighbor",
      });
      expect(result.value.references.get("absolute")).toMatchObject({
        path: resolve("/opt/source"),
      });
      expect(result.value.references.get("home")).toMatchObject({
        path: resolve("/home/person/source"),
      });
      expect(result.value.references.get("remote")).toMatchObject({
        _tag: "remote",
        configuredRef: "v1",
        configuredRefresh: { _tag: "manual" },
      });
    }
  });

  test.each([
    [{ references: {} }, "ConfigurationValidationError"],
    [{ version: 2, references: {} }, "UnsupportedConfigurationVersionError"],
    [{ version: 1 }, "ConfigurationValidationError"],
    [{ version: 1, references: [], extra: true }, "ConfigurationValidationError"],
    [{ version: 1, references: [] }, "ConfigurationValidationError"],
  ] as const)("rejects invalid document requirements", (input, tag) => {
    const result = parseConfigurationDocument(input, "/config.json", "/home/person");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe(tag);
    }
  });

  test.each([
    { version: 1, extra: true, references: {} },
    { version: 1, refresh: { policy: "manual", extra: true }, references: {} },
    { version: 1, references: { local: { path: ".", extra: true } } },
    { version: 1, references: { remote: { repository: "owner/repo", extra: true } } },
    {
      version: 1,
      references: {
        remote: {
          repository: "owner/repo",
          refresh: { policy: "ttl", ttl: "1d", extra: true },
        },
      },
    },
  ])("rejects unknown fields at every nesting level", (input) => {
    const result = parseConfigurationDocument(input, "/config.json", "/home/person");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ConfigurationValidationError");
    }
  });

  test.each([{ Effect: { path: "." } }, { "@effect": { path: "." } }, { "-effect": { path: "." } }])(
    "rejects invalid Alias keys",
    (references) => {
      const result = parseConfigurationDocument({ version: 1, references }, "/config.json", "/home/person");

      expect(result.status).toBe("error");
    }
  );

  test.each([
    { path: ".", repository: "owner/repo" },
    { description: "missing source" },
    { path: ".", ref: "main" },
    { path: ".", refresh: { policy: "manual" } },
    { repository: "owner/repo", description: "" },
    { repository: "owner/repo", description: "   " },
  ])("enforces Local/Remote exclusivity and non-empty descriptions", (entry) => {
    const result = parseConfigurationDocument(
      { version: 1, references: { source: entry } },
      "/config.json",
      "/home/person"
    );

    expect(result.status).toBe("error");
  });
});

describe("global and project configuration merge", () => {
  test("replaces project entries whole and applies project file-wide policy globally", () => {
    const global = parseConfigurationDocument(
      {
        version: 1,
        refresh: { policy: "ttl", ttl: "1d" },
        references: {
          shared: {
            repository: "owner/global",
            ref: "global-ref",
            description: "Global description",
          },
          inherited: { repository: "owner/inherited" },
          pinned: { repository: "owner/pinned", refresh: { policy: "manual" } },
        },
      },
      "/agent/repository-references.json",
      "/home/person"
    );
    const project = parseConfigurationDocument(
      {
        version: 1,
        refresh: { policy: "session" },
        references: { shared: { path: "../local" } },
      },
      "/workspace/.pi/repository-references.json",
      "/home/person"
    );

    expect(global.status).toBe("ok");
    expect(project.status).toBe("ok");
    if (global.status === "ok" && project.status === "ok") {
      const merged = mergeConfigurationDocuments(global.value, project.value);
      expect(merged.references.get("shared")).toEqual({
        _tag: "local",
        alias: "shared",
        path: "/workspace/local",
        description: undefined,
      });
      expect(merged.references.get("inherited")).toMatchObject({ refresh: { _tag: "session" } });
      expect(merged.references.get("pinned")).toMatchObject({ refresh: { _tag: "manual" } });
    }
  });

  test("uses the built-in seven-day TTL only when neither file supplies a policy", () => {
    const parsed = parseConfigurationDocument(
      { version: 1, references: { source: { repository: "owner/repo" } } },
      "/config.json",
      "/home/person"
    );

    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") {
      const merged = mergeConfigurationDocuments(parsed.value, undefined);
      expect(merged.fileWideRefresh).toMatchObject({
        _tag: "ttl",
        ttl: { literal: "7d", milliseconds: 604_800_000 },
      });
      expect(merged.references.get("source")).toMatchObject({ refresh: { _tag: "ttl" } });
    }
  });
});

describe("trust-aware configuration loading", () => {
  test("loads optional files and ignores an untrusted malformed project file", async () => {
    const root = await makeTemporaryDirectory();
    const agentDirectory = join(root, "agent");
    const projectDirectory = join(root, "project");
    await mkdir(join(projectDirectory, ".pi"), { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      join(agentDirectory, CONFIG_FILE_NAME),
      JSON.stringify({ version: 1, references: { global: { repository: "owner/repo" } } })
    );
    await writeFile(join(projectDirectory, ".pi", CONFIG_FILE_NAME), "not json");

    const result = await loadRepositoryReferencesConfiguration({
      agentDirectory,
      cwd: projectDirectory,
      homeDirectory: join(root, "home"),
      projectTrusted: false,
      fileSystem: createNodeRepositoryFileSystem(),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect([...result.value.references.keys()]).toEqual(["global"]);
    }
  });

  test("a malformed loaded project document disables the complete set with path and cause", async () => {
    const root = await makeTemporaryDirectory();
    const agentDirectory = join(root, "agent");
    const projectDirectory = join(root, "project");
    await mkdir(join(projectDirectory, ".pi"), { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      join(agentDirectory, CONFIG_FILE_NAME),
      JSON.stringify({ version: 1, references: { global: { repository: "owner/repo" } } })
    );
    const projectPath = join(projectDirectory, ".pi", CONFIG_FILE_NAME);
    await writeFile(projectPath, "{");

    const result = await loadRepositoryReferencesConfiguration({
      agentDirectory,
      cwd: projectDirectory,
      homeDirectory: join(root, "home"),
      projectTrusted: true,
      fileSystem: createNodeRepositoryFileSystem(),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ConfigurationJsonParseError");
      expect(result.error.path).toBe(projectPath);
      expect(result.error.cause).toBeInstanceOf(SyntaxError);
    }
  });

  test("treats two absent files as a successful empty configuration", async () => {
    const root = await makeTemporaryDirectory();
    const result = await loadRepositoryReferencesConfiguration({
      agentDirectory: join(root, "agent"),
      cwd: join(root, "project"),
      homeDirectory: join(root, "home"),
      projectTrusted: true,
      fileSystem: createNodeRepositoryFileSystem(),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.references.size).toBe(0);
      expect(result.value.fileWideRefresh).toMatchObject({ _tag: "ttl", ttl: { literal: "7d" } });
    }
  });

  test("returns filesystem read failures with the configuration path and original cause", async () => {
    const cause = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const result = await loadRepositoryReferencesConfiguration({
      agentDirectory: "/agent",
      cwd: "/project",
      homeDirectory: "/home/person",
      projectTrusted: false,
      fileSystem: {
        readTextFile: (path) =>
          Promise.resolve(
            Result.err(
              new RepositoryFileSystemError({
                operation: "read-file",
                path,
                cause,
                message: "read failed",
              })
            )
          ),
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ConfigurationReadError");
      expect(result.error.path).toBe("/agent/repository-references.json");
      expect(result.error.cause).toBe(cause);
    }
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "repository-reference-config-"));
  temporaryDirectories.push(path);
  return path;
}
