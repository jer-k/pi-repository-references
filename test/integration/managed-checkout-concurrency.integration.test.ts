import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";

import { createProperCacheLocks } from "../../extensions/repository-references/cache-locks.ts";
import { createNodeGitProcess } from "../../extensions/repository-references/git-process.ts";
import {
  createManagedCheckoutStore,
  type ManagedCheckoutStore,
} from "../../extensions/repository-references/managed-checkout-storage.ts";
import { createManagedGit } from "../../extensions/repository-references/managed-git.ts";
import { createNodeRepositoryFileSystem } from "../../extensions/repository-references/node-file-system.ts";
import type {
  RepositoryCloneSource,
  RepositorySource,
} from "../../extensions/repository-references/repository-source.ts";
import { parseRepositorySource } from "../../extensions/repository-references/repository-source.ts";
import { testCast } from "../test-cast.ts";

const executeFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const subprocessFixture = join(repositoryRoot, "test", "fixtures", "publish-managed-checkout.ts");
const temporaryDirectories: Array<string> = [];
const childProcesses: Array<ChildProcess> = [];
const servers: Array<Server> = [];
const serverSockets = new Map<Server, Set<Socket>>();
const TcpAddressSchema = Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65_535 }) });
const SubprocessResultSchema = Type.Object({
  cacheKey: Type.String({ minLength: 1 }),
  root: Type.String({ minLength: 1 }),
  commit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  sequence: Type.Integer({ minimum: 1 }),
});
type SubprocessResult = Static<typeof SubprocessResultSchema>;

afterEach(async () => {
  for (const child of childProcesses.splice(0)) await stopChild(child);
  for (const server of servers.splice(0)) await closeServer(server);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Managed Checkout process and network integration", () => {
  test("materializes accepted git URLs and preserves old-or-new publication during branch refresh", async () => {
    const fixture = await createGitFixture();
    const daemon = await startGitDaemon(fixture.remotes);
    const repository = parsedSource(`git://127.0.0.1:${String(daemon.port)}/repository.git`);
    const store = createStore(join(fixture.workspace, "cache"));
    const request = { repository, configuredRef: undefined };

    const initial = await store.publish(request, "ensure");
    if (initial.status === "error") throw initial.error;
    expect(await readFile(join(initial.value.root, "main.txt"), "utf8")).toBe("one\n");

    await writeFile(join(fixture.work, "main.txt"), "two\n");
    await git(fixture.work, "add", "main.txt");
    await git(fixture.work, "commit", "-m", "main two");
    await git(fixture.work, "push", "origin", "main");

    let settled = false;
    const refresh = store.publish(request, "refresh").finally(() => {
      settled = true;
    });
    const observedRoots = new Set([initial.value.root]);
    while (!settled) {
      const opened = await store.open(request);
      if (opened.status === "error") throw opened.error;
      if (opened.value !== undefined) observedRoots.add(opened.value.root);
      await new Promise<void>((resolve_) => setImmediate(resolve_));
    }
    const refreshed = await refresh;
    if (refreshed.status === "error") throw refreshed.error;
    const final = await store.open(request);
    if (final.status === "error" || final.value === undefined) throw new Error("Expected final checkout");
    observedRoots.add(final.value.root);

    expect(await readFile(join(final.value.root, "main.txt"), "utf8")).toBe("two\n");
    expect(observedRoots).toEqual(new Set([initial.value.root, refreshed.value.root]));
    expect([...observedRoots].every((root) => root.includes("/checkouts/"))).toBe(true);
  });

  test("coalesces initial publication through an inter-process lock", async () => {
    const fixture = await createGitFixture();
    const cacheRoot = join(fixture.workspace, "concurrent-cache");
    const arguments_ = ["--import", "tsx", subprocessFixture, cacheRoot, fixture.bare];

    const [left, right] = await Promise.all([
      executeFile(process.execPath, arguments_, { cwd: repositoryRoot }),
      executeFile(process.execPath, arguments_, { cwd: repositoryRoot }),
    ]);
    const leftResult = parseSubprocessResult(left.stdout);
    const rightResult = parseSubprocessResult(right.stdout);

    expect(leftResult).toEqual(rightResult);
    expect(leftResult.sequence).toBe(1);
    expect(await readFile(join(leftResult.root, "main.txt"), "utf8")).toBe("one\n");
  });

  test("classifies a hanging loopback clone timeout without replacing a usable checkout", async () => {
    const fixture = await createGitFixture();
    const cacheRoot = join(fixture.workspace, "timeout-cache");
    const store = createStore(cacheRoot);
    const repository = sourceWithClonePath(fixture.bare);
    const request = { repository, configuredRef: undefined };
    const initial = await store.publish(request, "ensure");
    if (initial.status === "error") throw initial.error;

    const hanging = await startHangingServer();
    const hangingSource: RepositorySource = {
      ...repository,
      cloneSource: testCast<string, RepositoryCloneSource>(`git://127.0.0.1:${String(hanging.port)}/repository.git`),
    };
    const timeoutStore = createStore(cacheRoot, 250);
    const timedOut = await timeoutStore.publish({ repository: hangingSource, configuredRef: undefined }, "refresh");
    const reopened = await store.open(request);

    expect(timedOut.status).toBe("error");
    if (timedOut.status === "error") expect(timedOut.error._tag).toBe("GitTimeoutError");
    expect(reopened).toMatchObject({ status: "ok", value: { root: initial.value.root } });
  });
});

function createStore(cacheRoot: string, networkTimeoutMilliseconds?: number): ManagedCheckoutStore {
  const fileSystem = createNodeRepositoryFileSystem();
  return createManagedCheckoutStore({
    cacheRoot,
    fileSystem,
    locks: createProperCacheLocks(join(cacheRoot, "locks")),
    git: createManagedGit(
      createNodeGitProcess(),
      fileSystem,
      networkTimeoutMilliseconds === undefined ? {} : { networkTimeoutMilliseconds }
    ),
    clock: { now: () => new Date() },
  });
}

async function createGitFixture(): Promise<{
  readonly workspace: string;
  readonly work: string;
  readonly remotes: string;
  readonly bare: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "repository-reference-integration-"));
  temporaryDirectories.push(workspace);
  const work = join(workspace, "work");
  const remotes = join(workspace, "remotes");
  const bare = join(remotes, "repository.git");
  await mkdir(work);
  await mkdir(remotes);
  await git(work, "init", "-b", "main");
  await git(work, "config", "user.email", "test@example.com");
  await git(work, "config", "user.name", "Test");
  await writeFile(join(work, "main.txt"), "one\n");
  await git(work, "add", ".");
  await git(work, "commit", "-m", "main one");
  await git(remotes, "init", "--bare", bare);
  await git(work, "remote", "add", "origin", bare);
  await git(work, "push", "-u", "origin", "main");
  await git(remotes, `--git-dir=${bare}`, "symbolic-ref", "HEAD", "refs/heads/main");
  return { workspace, work, remotes, bare };
}

async function startGitDaemon(basePath: string): Promise<{ readonly child: ChildProcess; readonly port: number }> {
  const port = await reservePort();
  const child = spawn(
    "git",
    [
      "daemon",
      "--reuseaddr",
      "--export-all",
      `--base-path=${basePath}`,
      "--listen=127.0.0.1",
      `--port=${String(port)}`,
      basePath,
    ],
    { stdio: "ignore" }
  );
  childProcesses.push(child);
  await waitForPort(port, child);
  return { child, port };
}

async function startHangingServer(): Promise<{ readonly server: Server; readonly port: number }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  serverSockets.set(server, sockets);
  server.on("close", () => serverSockets.delete(server));
  await listen(server, 0);
  servers.push(server);
  const address = server.address();
  if (!Value.Check(TcpAddressSchema, address)) throw new Error("Expected TCP address");
  return { server, port: address.port };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  if (!Value.Check(TcpAddressSchema, address)) throw new Error("Expected TCP address");
  await closeServer(server);
  return address.port;
}

async function waitForPort(port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`git daemon exited with ${String(child.exitCode)}`);
    const connected = await new Promise<boolean>((resolve_) => {
      const socket = new Socket();
      socket.once("connect", () => {
        socket.destroy();
        resolve_(true);
      });
      socket.once("error", () => resolve_(false));
      socket.connect(port, "127.0.0.1");
    });
    if (connected) return;
    await new Promise((resolve_) => setTimeout(resolve_, 20));
  }
  throw new Error("git daemon did not start");
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve_, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve_();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve_) => server.close(() => resolve_()));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve_) => {
    child.once("exit", () => resolve_());
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve_();
    }, 1_000).unref();
  });
}

function parsedSource(input: string): RepositorySource {
  const parsed = parseRepositorySource(input);
  if (parsed.status === "error") throw parsed.error;
  return parsed.value;
}

function sourceWithClonePath(path: string): RepositorySource {
  const parsed = parsedSource("https://example.invalid/timeout/repository.git");
  return { ...parsed, cloneSource: testCast<string, RepositoryCloneSource>(path) };
}

function parseSubprocessResult(output: string): SubprocessResult {
  const decoded: unknown = JSON.parse(output);
  if (!Value.Check(SubprocessResultSchema, decoded)) throw new Error("Invalid subprocess result");
  return decoded;
}

async function git(cwd: string, ...arguments_: ReadonlyArray<string>): Promise<void> {
  await executeFile("git", arguments_, { cwd });
}
