import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, test } from "vitest";

const PackageManifest = Type.Object(
  {
    files: Type.Optional(Type.Array(Type.String())),
    pi: Type.Optional(
      Type.Object({
        extensions: Type.Optional(Type.Array(Type.String())),
      })
    ),
    dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: true }
);
const PackResult = Type.Array(
  Type.Object(
    {
      files: Type.Array(Type.Object({ path: Type.String() }, { additionalProperties: true })),
    },
    { additionalProperties: true }
  ),
  { minItems: 1 }
);

const executeFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("declares the Repository References extension as a Pi package resource", async () => {
  const manifest = Value.Parse(
    PackageManifest,
    JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"))
  );

  expect(manifest.files).toEqual(["extensions", "CONTEXT.md", "README.md"]);
  expect(manifest.pi).toEqual({
    extensions: ["./extensions/repository-references.ts"],
  });
  expect(manifest.dependencies).toMatchObject({
    "better-result": expect.any(String),
    "proper-lockfile": expect.any(String),
  });
  expect(manifest.peerDependencies).toMatchObject({
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });
});

test("includes every production module and required document in the packed Git package", async () => {
  const packed = Value.Parse(
    PackResult,
    JSON.parse(
      (await executeFile("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: repositoryRoot })).stdout
    )
  );
  const packedPaths = new Set(packed[0]?.files.map((file) => file.path));
  const extensionPaths = (await readdir(join(repositoryRoot, "extensions"), { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .map((path) => `extensions/${path}`);

  expect([...packedPaths]).toEqual(expect.arrayContaining(["README.md", "CONTEXT.md", ...extensionPaths]));
});
