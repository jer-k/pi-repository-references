import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  createEditTool,
  createWriteTool,
  DefaultResourceLoader,
  SettingsManager,
  type EditToolInput,
  type ExtensionContext,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { testCast } from "../test-cast.ts";

const executeFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = join(repositoryRoot, "extensions", "repository-references.ts");
type SessionStartHandler = (event: SessionStartEvent, context: ExtensionContext) => Promise<void> | void;
type SessionShutdownHandler = (event: SessionShutdownEvent, context: ExtensionContext) => Promise<void> | void;
type ToolCallHandler = (
  event: ToolCallEvent,
  context: ExtensionContext
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;

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
    expect([...(extensions.extensions[0]?.commands.keys() ?? [])]).toEqual(["references", "references-refresh"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("blocks Pi edit and write tools through every normalized physical reference path", async () => {
  const workspace = await mkdtemp(join(homedir(), ".pi-repository-references-write-guard-"));
  const agentDir = join(workspace, "agent");
  const project = join(workspace, "project");
  const local = join(workspace, "protected root");
  const symlinkRoot = join(workspace, "protected-link");
  await mkdir(agentDir);
  await mkdir(project);
  await mkdir(local);
  await git(local, "init", "-b", "main");
  await git(local, "config", "user.email", "test@example.com");
  await git(local, "config", "user.name", "Test");
  const protectedFile = join(local, "protected.txt");
  await writeFile(protectedFile, "original\n");
  await git(local, "add", ".");
  await git(local, "commit", "-m", "initial");
  await symlink(local, symlinkRoot);
  await writeConfiguration(agentDir, local, ["local"]);

  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settingsManager = SettingsManager.inMemory({ packages: [repositoryRoot] });
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager });
  const context = lifecycleContext(project, [], []);

  try {
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions().extensions[0];
    if (loaded === undefined) throw new Error("Expected loaded extension");
    const startupHandler = loaded.handlers.get("session_start")?.[0];
    await sessionStart(
      testCast<typeof startupHandler, SessionStartHandler | undefined>(startupHandler),
      context,
      "startup"
    );
    const loadedToolCallHandler = loaded.handlers.get("tool_call")?.[0];
    const handler = testCast<typeof loadedToolCallHandler, ToolCallHandler | undefined>(loadedToolCallHandler);
    if (handler === undefined) throw new Error("Expected tool_call handler");

    const pathSpellings = [
      protectedFile,
      `~/${relative(homedir(), protectedFile)}`,
      pathToFileURL(protectedFile).href,
      `@${protectedFile}`,
      join(symlinkRoot, "protected.txt"),
      protectedFile.replace("protected root", "protected\u202Froot"),
      join(local, "missing", "new.txt"),
    ];
    for (const path of pathSpellings) {
      await expectGuardedToolBlocked(handler, context, project, "write", { path, content: "mutated\n" });
      await expectGuardedToolBlocked(handler, context, project, "edit", {
        path,
        edits: [{ oldText: "original", newText: "mutated" }],
      });
    }

    const projectFile = join(project, "project.txt");
    await expectGuardedToolAllowed(handler, context, project, "write", {
      path: projectFile,
      content: "project\n",
    });
    await expectGuardedToolAllowed(handler, context, project, "write", {
      path: "@ordinary.txt",
      content: "ordinary\n",
    });
    expect(await readFile(protectedFile, "utf8")).toBe("original\n");
    expect(await readFile(projectFile, "utf8")).toBe("project\n");
    expect(await readFile(join(project, "ordinary.txt"), "utf8")).toBe("ordinary\n");
  } finally {
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runs Local Reference commands and reconstructs autocomplete through Pi reload", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-repository-references-lifecycle-integration-"));
  const agentDir = join(workspace, "agent");
  const local = join(workspace, "local");
  await mkdir(agentDir);
  await mkdir(local);
  await git(local, "init", "-b", "main");
  await git(local, "config", "user.email", "test@example.com");
  await git(local, "config", "user.name", "Test");
  await writeFile(join(local, "tracked.ts"), "tracked\n");
  await git(local, "add", ".");
  await git(local, "commit", "-m", "initial");
  await writeConfiguration(agentDir, local, ["local"]);

  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settingsManager = SettingsManager.inMemory({ packages: [repositoryRoot] });
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager });
  const notifications: Array<string> = [];
  const autocompleteFactories: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
  const context = lifecycleContext(workspace, notifications, autocompleteFactories);

  try {
    await resourceLoader.reload();
    let loaded = resourceLoader.getExtensions().extensions[0];
    if (loaded === undefined) throw new Error("Expected loaded extension");
    const startupHandler = loaded.handlers.get("session_start")?.[0];
    await sessionStart(
      testCast<typeof startupHandler, SessionStartHandler | undefined>(startupHandler),
      context,
      "startup"
    );

    const status = loaded.commands.get("references");
    await status?.handler("", testCast<ExtensionContext, Parameters<typeof status.handler>[1]>(context));
    expect(notifications.at(-1)).toContain("@local — local");

    const refresh = loaded.commands.get("references-refresh");
    expect(await refresh?.getArgumentCompletions?.("loc")).toEqual([
      { value: "local", label: "local", description: "Local test source" },
    ]);
    await writeFile(join(local, "new-untracked.ts"), "new\n");
    const providerBefore = autocompleteFactories.at(-1)?.(emptyAutocompleteProvider());
    const suggestionsBefore = await providerBefore?.getSuggestions(["@local/new"], 0, 10, completionOptions());
    expect(suggestionsBefore).toBeNull();

    await refresh?.handler("local", testCast<ExtensionContext, Parameters<typeof refresh.handler>[1]>(context));
    const providerAfter = autocompleteFactories.at(-1)?.(emptyAutocompleteProvider());
    const suggestionsAfter = await providerAfter?.getSuggestions(["@local/new"], 0, 10, completionOptions());
    expect(suggestionsAfter?.items[0]?.value).toBe("@local/new-untracked.ts");

    await writeConfiguration(agentDir, local, ["local", "other"]);
    const shutdownHandler = loaded.handlers.get("session_shutdown")?.[0];
    await sessionShutdown(
      testCast<typeof shutdownHandler, SessionShutdownHandler | undefined>(shutdownHandler),
      context,
      "reload"
    );
    await resourceLoader.reload();
    loaded = resourceLoader.getExtensions().extensions[0];
    if (loaded === undefined) throw new Error("Expected reloaded extension");
    const reloadHandler = loaded.handlers.get("session_start")?.[0];
    await sessionStart(
      testCast<typeof reloadHandler, SessionStartHandler | undefined>(reloadHandler),
      context,
      "reload"
    );

    const reloadedRefresh = loaded.commands.get("references-refresh");
    expect(await reloadedRefresh?.getArgumentCompletions?.("oth")).toEqual([
      { value: "other", label: "other", description: "Local test source" },
    ]);
    const reloadedProvider = autocompleteFactories.at(-1)?.(emptyAutocompleteProvider());
    const reloadedSuggestions = await reloadedProvider?.getSuggestions(["@oth"], 0, 4, completionOptions());
    expect(reloadedSuggestions?.items[0]?.value).toBe("@other/");
  } finally {
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    await rm(workspace, { recursive: true, force: true });
  }
});

async function expectGuardedToolBlocked(
  handler: ToolCallHandler,
  context: ExtensionContext,
  cwd: string,
  toolName: "edit" | "write",
  input: EditToolInput | WriteToolInput
): Promise<void> {
  const event = { type: "tool_call" as const, toolName, toolCallId: `${toolName}-blocked`, input };
  const result = await handler(testCast<typeof event, ToolCallEvent>(event), context);
  if (result?.block !== true) {
    if (toolName === "write") {
      await createWriteTool(cwd).execute("write-bypassed", testCast<typeof input, WriteToolInput>(input));
    } else {
      await createEditTool(cwd).execute("edit-bypassed", testCast<typeof input, EditToolInput>(input));
    }
  }
  expect(result).toMatchObject({ block: true });
}

async function expectGuardedToolAllowed(
  handler: ToolCallHandler,
  context: ExtensionContext,
  cwd: string,
  toolName: "write",
  input: WriteToolInput
): Promise<void> {
  const event = { type: "tool_call" as const, toolName, toolCallId: "write-allowed", input };
  const result = await handler(testCast<typeof event, ToolCallEvent>(event), context);
  expect(result).toBeUndefined();
  await createWriteTool(cwd).execute("write-allowed", input);
}

function lifecycleContext(
  cwd: string,
  notifications: Array<string>,
  autocompleteFactories: Array<(current: AutocompleteProvider) => AutocompleteProvider>
): ExtensionContext {
  return testCast<
    {
      cwd: string;
      mode: "tui";
      hasUI: true;
      signal: undefined;
      sessionManager: { getSessionId: () => string; getBranch: () => [] };
      isProjectTrusted: () => true;
      ui: {
        notify: (message: string) => void;
        setStatus: () => void;
        addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void;
      };
    },
    ExtensionContext
  >({
    cwd,
    mode: "tui",
    hasUI: true,
    signal: undefined,
    sessionManager: { getSessionId: () => "integration-session", getBranch: () => [] },
    isProjectTrusted: () => true,
    ui: {
      notify: (message) => notifications.push(message),
      setStatus: () => undefined,
      addAutocompleteProvider: (factory) => autocompleteFactories.push(factory),
    },
  });
}

async function sessionStart(
  handler: SessionStartHandler | undefined,
  context: ExtensionContext,
  reason: SessionStartEvent["reason"]
): Promise<void> {
  if (handler === undefined) throw new Error("Expected session_start handler");
  await handler({ type: "session_start", reason }, context);
}

async function sessionShutdown(
  handler: SessionShutdownHandler | undefined,
  context: ExtensionContext,
  reason: SessionShutdownEvent["reason"]
): Promise<void> {
  if (handler === undefined) throw new Error("Expected session_shutdown handler");
  await handler({ type: "session_shutdown", reason }, context);
}

function emptyAutocompleteProvider(): AutocompleteProvider {
  return {
    getSuggestions: async () => null,
    applyCompletion: (lines, line, col) => ({ lines, cursorLine: line, cursorCol: col }),
  };
}

function completionOptions() {
  return { signal: new AbortController().signal };
}

async function writeConfiguration(agentDir: string, path: string, aliases: ReadonlyArray<string>): Promise<void> {
  await writeFile(
    join(agentDir, "repository-references.json"),
    JSON.stringify({
      version: 1,
      references: Object.fromEntries(aliases.map((alias) => [alias, { path, description: "Local test source" }])),
    })
  );
}

async function git(cwd: string, ...arguments_: ReadonlyArray<string>): Promise<void> {
  await executeFile("git", arguments_, { cwd });
}
