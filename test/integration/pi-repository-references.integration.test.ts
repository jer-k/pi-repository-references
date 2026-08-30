import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = join(repositoryRoot, "extensions", "repository-references.ts");

test("loads the checkout through Pi's package runtime", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-repository-references-package-integration-"));
  const agentDir = join(workspace, "agent");
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ packages: [repositoryRoot] });
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager });

  try {
    await resourceLoader.reload();
    const extensions = resourceLoader.getExtensions();

    expect(extensions.errors).toEqual([]);
    expect(extensions.extensions.map((extension) => extension.resolvedPath)).toContain(extensionPath);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
