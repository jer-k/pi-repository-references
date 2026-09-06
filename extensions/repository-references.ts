import { homedir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { createProperCacheLocks } from "./repository-references/cache-locks.ts";
import { createNodeGitProcess } from "./repository-references/git-process.ts";
import { createManagedCheckoutStore } from "./repository-references/managed-checkout-storage.ts";
import { createManagedGit } from "./repository-references/managed-git.ts";
import { createNodeRepositoryFileSystem } from "./repository-references/node-file-system.ts";
import { createReferenceAutocompleteProvider } from "./repository-references/reference-autocomplete.ts";
import {
  appendReferenceCatalogue,
  catalogueExposedRoots,
  renderReferenceCatalogue,
} from "./repository-references/reference-catalogue.ts";
import { registerReferenceCommands } from "./repository-references/reference-commands.ts";
import { isProtectedPhysicalPath } from "./repository-references/reference-path.ts";
import { createReferenceWorkUx } from "./repository-references/reference-work-ux.ts";
import {
  closeRepositoryReferencesSession,
  findMentionedAliases,
  finishRepositoryReferencesSessionWork,
  resolveSessionReadPath,
  shouldBlockSessionWrite,
  startRepositoryReferencesSession,
  waitForRequestedReferences,
  type RefreshRepositoryReferenceOptions,
  type RepositoryReferencesSession,
} from "./repository-references/repository-references-service.ts";

const AUTOMATIC_ATTEMPT_ENTRY = "repository-references-automatic-attempt";
const EXPOSED_ROOT_ENTRY = "repository-references-exposed-root";
const AutomaticAttemptSchema = Type.Object(
  {
    version: Type.Literal(1),
    runtimeToken: Type.String({ minLength: 1 }),
    cacheKey: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    attemptedAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
  },
  { additionalProperties: false }
);
const ExposedRootSchema = Type.Object(
  { version: Type.Literal(1), root: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

/** Register Repository References lifecycle, ambient context, and built-in tool guardrails with Pi. */
export default function repositoryReferences(pi: ExtensionAPI): void {
  const fileSystem = createNodeRepositoryFileSystem();
  const gitProcess = createNodeGitProcess();
  let session: RepositoryReferencesSession | undefined;
  let refreshOptions: RefreshRepositoryReferenceOptions | undefined;
  let stopCurrentUx: (() => void) | undefined;
  const exposedRoots = new Set<string>();

  registerReferenceCommands(pi, {
    getSession: () => session,
    getRefreshOptions: () => refreshOptions,
  });

  pi.on("session_start", async (_event, ctx) => {
    stopCurrentUx?.();
    stopCurrentUx = undefined;
    if (session !== undefined) closeRepositoryReferencesSession(session);
    session = undefined;
    refreshOptions = undefined;
    exposedRoots.clear();
    const runtimeToken = makeRuntimeToken(ctx.sessionManager.getSessionId());

    const automaticAttempts = new Set<string>();
    const recentAttempts = new Map<string, Date>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === AUTOMATIC_ATTEMPT_ENTRY && Value.Check(AutomaticAttemptSchema, entry.data)) {
        if (entry.data.runtimeToken !== runtimeToken) continue;
        automaticAttempts.add(entry.data.cacheKey);
        recentAttempts.set(entry.data.cacheKey, new Date(entry.data.attemptedAt));
      }
      if (entry.customType === EXPOSED_ROOT_ENTRY && Value.Check(ExposedRootSchema, entry.data)) {
        exposedRoots.add(entry.data.root);
      }
    }

    const agentDirectory = getAgentDir();
    const cacheRoot = join(agentDirectory, "repository-references");
    const clock = { now: () => new Date() };
    const managedCheckouts = createManagedCheckoutStore({
      cacheRoot,
      fileSystem,
      locks: createProperCacheLocks(join(cacheRoot, "locks")),
      git: createManagedGit(gitProcess, fileSystem),
      clock,
    });
    const workUx = createReferenceWorkUx(ctx);
    const onReferenceWork = workUx.onReferenceWork;
    stopCurrentUx = workUx.stop;
    const offline = isPiOffline(process.env.PI_OFFLINE);
    refreshOptions = {
      git: gitProcess,
      fullFileSystem: fileSystem,
      clock,
      managedCheckouts,
      offline,
      onReferenceWork,
    };
    const started = await startRepositoryReferencesSession({
      agentDirectory,
      cwd: ctx.cwd,
      homeDirectory: homedir(),
      projectTrusted: ctx.isProjectTrusted(),
      configDirectoryName: CONFIG_DIR_NAME,
      fileSystem,
      fullFileSystem: fileSystem,
      git: gitProcess,
      clock,
      managedCheckouts,
      offline,
      sessionAutomaticAttempts: automaticAttempts,
      recentAutomaticAttempts: recentAttempts,
      onAutomaticAttempt: (cacheKey, attemptedAt) => {
        automaticAttempts.add(cacheKey);
        recentAttempts.set(cacheKey, attemptedAt);
        pi.appendEntry(AUTOMATIC_ATTEMPT_ENTRY, {
          version: 1,
          runtimeToken,
          cacheKey,
          attemptedAt: attemptedAt.toISOString(),
        });
      },
      onReferenceWork,
    });
    if (started.status === "error") {
      if (ctx.hasUI) ctx.ui.notify(started.error.message, "error");
      return;
    }
    for (const root of exposedRoots) started.value.protectedRoots.add(root);
    session = started.value;
    if (ctx.mode === "tui") {
      ctx.ui.addAutocompleteProvider((current) => createReferenceAutocompleteProvider(current, () => session));
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const currentSession = session;
    if (currentSession === undefined) return;
    const mentionedAliases = findMentionedAliases(event.prompt, currentSession.references);
    const failures = await waitForRequestedReferences(currentSession, mentionedAliases, ctx.signal);
    if (currentSession.closed) return;
    const catalogue = renderReferenceCatalogue({
      session: currentSession,
      mentionedAliases,
      materializationFailures: failures,
    });
    if (catalogue === undefined) return;

    for (const root of catalogueExposedRoots(currentSession, mentionedAliases)) {
      if (exposedRoots.has(root)) continue;
      exposedRoots.add(root);
      currentSession.protectedRoots.add(root);
      pi.appendEntry(EXPOSED_ROOT_ENTRY, { version: 1, root });
    }
    return { systemPrompt: appendReferenceCatalogue(event.systemPrompt, catalogue) };
  });

  pi.on("tool_call", async (event, ctx) => {
    const currentSession = session;

    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const blocked =
        currentSession === undefined
          ? await isProtectedPhysicalPath(event.input.path, ctx.cwd, exposedRoots, fileSystem)
          : await shouldBlockSessionWrite(currentSession, event.input.path, ctx.cwd, fileSystem);
      if (blocked.status === "error") return { block: true, reason: blocked.error.message };
      if (blocked.value) {
        return {
          block: true,
          reason: "Repository References are read-only; edit the active project instead",
        };
      }
      return;
    }

    if (currentSession === undefined) return;

    if (isToolCallEventType("read", event)) {
      const rewritten = await resolveSessionReadPath(currentSession, event.input.path, fileSystem);
      if (rewritten.status === "error") return { block: true, reason: rewritten.error.message };
      if (rewritten.value._tag === "resolved") event.input.path = rewritten.value.path;
      return;
    }

    if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
      if (event.input.path === undefined) return;
      const rewritten = await resolveSessionReadPath(currentSession, event.input.path, fileSystem);
      if (rewritten.status === "error") return { block: true, reason: rewritten.error.message };
      if (rewritten.value._tag === "resolved") event.input.path = rewritten.value.path;
    }
  });

  pi.on("session_shutdown", async (event) => {
    stopCurrentUx?.();
    stopCurrentUx = undefined;
    const currentSession = session;
    session = undefined;
    refreshOptions = undefined;
    if (currentSession === undefined) return;
    if (event.reason === "reload") await finishRepositoryReferencesSessionWork(currentSession);
    closeRepositoryReferencesSession(currentSession);
  });
}

/** Build a reload-stable but process- and session-specific automatic-refresh identity. */
function makeRuntimeToken(sessionId: string): string {
  return `${process.pid}:${performance.timeOrigin}:${sessionId}`;
}

/** Parse Pi's conventional offline environment flag without treating `0` as active. */
function isPiOffline(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
