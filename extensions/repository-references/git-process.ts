import { spawn } from "node:child_process";

import { Result, type Result as ResultType } from "better-result";

import { GitProcessExecutionError } from "../repository-reference-errors.ts";
import type { GitProcess, GitProcessOutput, GitProcessRequest } from "./ports.ts";

/**
 * Create the direct, non-shell Git process adapter.
 *
 * The adapter disables terminal credential prompts, applies each request timeout, and returns
 * launch failures as structured errors without retaining potentially credential-bearing arguments.
 */
export function createNodeGitProcess(): GitProcess {
  return { run: executeGit };
}

/** Execute one Git child process and collect its completion output. */
function executeGit(request: GitProcessRequest): Promise<ResultType<GitProcessOutput, GitProcessExecutionError>> {
  return new Promise((complete) => {
    const child = spawn("git", request.arguments, {
      cwd: request.workingDirectory,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const standardOutput: Array<Buffer> = [];
    const standardError: Array<Buffer> = [];
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => standardOutput.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => standardError.push(chunk));

    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, request.timeoutMilliseconds);

    child.once("error", (cause) => {
      clearTimeout(timeout);
      if (hardKill !== undefined) clearTimeout(hardKill);
      if (settled) return;
      settled = true;
      complete(
        Result.err(
          new GitProcessExecutionError({
            operation: request.operation,
            cause: safeSpawnCause(cause),
            message: `Could not execute Git for ${request.operation}`,
          })
        )
      );
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (hardKill !== undefined) clearTimeout(hardKill);
      if (settled) return;
      settled = true;
      complete(
        Result.ok({
          exitCode: exitCode ?? -1,
          standardOutput: Buffer.concat(standardOutput).toString("utf8"),
          standardError: Buffer.concat(standardError).toString("utf8"),
          signal: signal ?? undefined,
          timedOut,
        })
      );
    });
  });
}

/** Preserve safe process-launch fields without retaining `spawnargs`, which may contain credentials. */
function safeSpawnCause(cause: Error) {
  return { name: cause.name, message: cause.message };
}
