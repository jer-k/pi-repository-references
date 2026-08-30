import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, test } from "vitest";

const PackageManifest = Type.Object(
  {
    pi: Type.Optional(
      Type.Object({
        extensions: Type.Optional(Type.Array(Type.String())),
      })
    ),
  },
  { additionalProperties: true }
);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("declares the Repository References extension as a Pi package resource", async () => {
  const manifest = Value.Parse(
    PackageManifest,
    JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"))
  );

  expect(manifest.pi).toEqual({
    extensions: ["./extensions/repository-references.ts"],
  });
});
