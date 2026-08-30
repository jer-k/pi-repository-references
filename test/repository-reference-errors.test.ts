import { join } from "node:path";

import { Result } from "better-result";
import { describe, expect, test } from "vitest";

import {
  ConfigurationJsonParseError,
  GitProcessExecutionError,
  throwRepositoryReferenceError,
} from "../extensions/repository-reference-errors.ts";
import { createNodeRepositoryFileSystem } from "../extensions/repository-references/node-file-system.ts";

describe("repository-reference error contracts", () => {
  test("exposes stable tags through Result errors and preserves JSON causes", () => {
    const cause = new SyntaxError("unexpected token");
    const error = new ConfigurationJsonParseError({
      path: "/safe/config.json",
      cause,
      message: "Could not parse repository-reference configuration",
    });
    const result = Result.err(error);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ConfigurationJsonParseError");
      expect(result.error.cause).toBe(cause);
    }
  });

  test("preserves process launch causes without retaining process arguments", () => {
    const cause = new Error("spawn failed");
    const error = new GitProcessExecutionError({
      operation: "clone",
      cause,
      message: "Git could not be started",
    });

    expect(error._tag).toBe("GitProcessExecutionError");
    expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty("arguments");
  });

  test("throws the unchanged structured error at the Pi boundary", () => {
    const error = new GitProcessExecutionError({
      operation: "fetch",
      cause: new Error("spawn failed"),
      message: "Git could not be started",
    });

    let caught: unknown;
    try {
      throwRepositoryReferenceError(error);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(error);
  });
});

test("the Node filesystem port returns failures with their original causes", async () => {
  const fileSystem = createNodeRepositoryFileSystem();
  const missingPath = join(process.cwd(), "does-not-exist", "repository-references.json");
  const result = await fileSystem.readTextFile(missingPath);

  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error._tag).toBe("RepositoryFileSystemError");
    expect(result.error.operation).toBe("read-file");
    expect(result.error.path).toBe(missingPath);
    expect(result.error.cause).toBeInstanceOf(Error);
  }
});
