import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { Result, type Result as ResultType } from "better-result";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type {
  CacheLockError,
  RepositoryFileSystemError,
  RepositoryReferenceError,
} from "../repository-reference-errors.ts";
import { parseJsonValue, type JsonValue } from "./json-value.ts";
import type { CacheLocks, Clock, RepositoryFileSystem } from "./ports.ts";
import type { ErrorLogConfiguration } from "./reference-configuration.ts";

/** Filename for structured, credential-safe Repository Reference error records. */
export const ERROR_LOG_FILE_NAME = "errors.jsonl";

const ERROR_LOG_VERSION = 1;
const ERROR_LOG_LOCK_KEY = "error-log";
const MAX_STRING_LENGTH = 4_000;
const JsonValueSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue"
);
const ErrorLogEntrySchema = Type.Object(
  {
    version: Type.Literal(ERROR_LOG_VERSION),
    timestamp: Type.String(),
    context: Type.Object(
      {
        alias: Type.Optional(Type.String()),
        operation: Type.String(),
        mode: Type.Optional(Type.Union([Type.Literal("automatic"), Type.Literal("explicit")])),
      },
      { additionalProperties: false }
    ),
    error: JsonValueSchema,
  },
  { additionalProperties: false }
);
const ProcessCauseSchema = Type.Object(
  {
    exitCode: Type.Number(),
    signal: Type.Optional(Type.String()),
    timedOut: Type.Optional(Type.Boolean()),
    diagnostic: Type.Optional(Type.String()),
  },
  { additionalProperties: true }
);
const NamedCauseSchema = Type.Object(
  {
    name: Type.String(),
    message: Type.String(),
    code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: true }
);

/** Filesystem and lock failures that can prevent error-log maintenance. */
export type ErrorLogIoError = CacheLockError | RepositoryFileSystemError;

/** Context identifying the Repository Reference operation that failed. */
export type ErrorLogContext = {
  readonly alias?: string;
  readonly operation: string;
  readonly mode?: "automatic" | "explicit";
};

/** One versioned JSONL error record retained by the diagnostic log. */
export type ErrorLogEntry = {
  readonly version: 1;
  readonly timestamp: string;
  readonly context: ErrorLogContext;
  readonly error: JsonValue;
};

/** A serialized, TTL-pruned error log safe for command display and agent review. */
export type RepositoryReferenceErrorLog = {
  /** Absolute path to the JSONL log. */
  readonly path: string;
  /** Append one structured error after pruning expired records. */
  readonly record: (
    context: ErrorLogContext,
    error: RepositoryReferenceError
  ) => Promise<ResultType<void, ErrorLogIoError>>;
  /** Read currently retained, valid records in chronological order. */
  readonly read: () => Promise<ResultType<ReadonlyArray<ErrorLogEntry>, ErrorLogIoError>>;
  /** Wait for every queued operation started by this process. */
  readonly flush: () => Promise<void>;
};

/** Inputs for opening and pruning the opt-in structured error log. */
export type CreateErrorLogOptions = {
  readonly cacheRoot: string;
  readonly configuration: Extract<ErrorLogConfiguration, { readonly _tag: "enabled" }>;
  readonly fileSystem: RepositoryFileSystem;
  readonly locks: CacheLocks;
  readonly clock: Clock;
};

/**
 * Open the structured error log and remove expired or malformed records.
 *
 * Every mutation uses the shared inter-process lock and an atomic replacement so concurrent Pi
 * sessions cannot overwrite each other's records.
 */
export async function createRepositoryReferenceErrorLog(
  options: CreateErrorLogOptions
): Promise<ResultType<RepositoryReferenceErrorLog, ErrorLogIoError>> {
  const path = join(options.cacheRoot, ERROR_LOG_FILE_NAME);
  const initialized = await mutateEntries(path, options, (entries) => entries);
  if (initialized.status === "error") {
    return initialized;
  }

  let queue: Promise<void> = Promise.resolve();

  const enqueue = <T>(
    operation: () => Promise<ResultType<T, ErrorLogIoError>>
  ): Promise<ResultType<T, ErrorLogIoError>> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return Result.ok({
    path,
    record: (context, error) =>
      enqueue(() =>
        mutateEntries(path, options, (entries) => [
          ...entries,
          {
            version: ERROR_LOG_VERSION,
            timestamp: options.clock.now().toISOString(),
            context,
            error: serializeRepositoryReferenceError(error),
          },
        ])
      ),
    read: () => enqueue(() => readEntriesWhileLocked(path, options)),
    flush: () => queue,
  });
}

/** Render the newest retained records for `/references-logs`. */
export function renderErrorLogEntries(entries: ReadonlyArray<ErrorLogEntry>, path: string, limit = 10): string {
  if (entries.length === 0) {
    return `Repository References error log is empty.\nPath: ${path}`;
  }

  const visible = entries.slice(-limit);
  const omitted = entries.length - visible.length;
  const heading =
    omitted === 0
      ? `Repository References errors (${String(entries.length)} retained)`
      : `Repository References errors (newest ${String(visible.length)} of ${String(entries.length)} retained)`;
  return `${heading}\nPath: ${path}\n\n${visible.map(renderEntry).join("\n\n")}`;
}

/** Serialize a structured extension error through its known credential-safe diagnostic fields. */
function serializeRepositoryReferenceError(error: RepositoryReferenceError): JsonValue {
  const details: Record<string, JsonValue> = {};
  if ("alias" in error) {
    details.alias = error.alias;
  }
  if ("operation" in error) {
    details.operation = error.operation;
  }
  if ("repositoryIdentity" in error) {
    details.repositoryIdentity = error.repositoryIdentity;
  }
  if ("configuredRef" in error) {
    details.configuredRef = error.configuredRef;
  }
  if ("exitCode" in error) {
    details.exitCode = error.exitCode;
  }
  if ("signal" in error) {
    details.signal = error.signal;
  }
  if ("timeoutMilliseconds" in error) {
    details.timeoutMilliseconds = error.timeoutMilliseconds;
  }
  if ("diagnostic" in error) {
    details.diagnostic = sanitizeString(error.diagnostic);
  }
  if ("reason" in error) {
    details.reason = error.reason;
  }
  if ("path" in error) {
    details.path = error.path;
  }
  if ("issuePath" in error) {
    details.issuePath = error.issuePath;
  }
  if ("requestedPath" in error) {
    details.requestedPath = error.requestedPath;
  }
  if ("root" in error) {
    details.root = error.root;
  }
  if ("cacheKey" in error) {
    details.cacheKey = error.cacheKey;
  }
  if ("actualVersion" in error) {
    details.actualVersion = error.actualVersion;
  }
  if ("input" in error) {
    details.input = error.input;
  }
  if ("cause" in error) {
    details.cause = serializeCause(error.cause);
  }

  return {
    _tag: error._tag,
    name: error.name,
    message: sanitizeString(error.message),
    details,
  };
}

/** Project an unknown integration cause through a small allowlist of safe diagnostic shapes. */
function serializeCause(cause: unknown): JsonValue {
  if (cause instanceof Error) {
    return { name: cause.name, message: sanitizeString(cause.message) };
  }
  if (Value.Check(ProcessCauseSchema, cause)) {
    return {
      exitCode: cause.exitCode,
      signal: cause.signal ?? null,
      timedOut: cause.timedOut ?? false,
      diagnostic: cause.diagnostic === undefined ? null : sanitizeString(cause.diagnostic),
    };
  }
  if (Value.Check(NamedCauseSchema, cause)) {
    return {
      name: cause.name,
      message: sanitizeString(cause.message),
      code: cause.code ?? null,
    };
  }
  return "<unavailable cause>";
}

/** Remove URL userinfo and bound arbitrary diagnostic strings. */
function sanitizeString(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1<credentials>@").slice(0, MAX_STRING_LENGTH);
}

/** Render one JSONL record as readable command output. */
function renderEntry(entry: ErrorLogEntry): string {
  const alias = entry.context.alias === undefined ? "" : ` @${entry.context.alias}`;
  const mode = entry.context.mode === undefined ? "" : ` (${entry.context.mode})`;
  return `${entry.timestamp}${alias} — ${entry.context.operation}${mode}\n${JSON.stringify(entry.error, null, 2)}`;
}

/** Read, retain, mutate, and atomically replace records while holding the diagnostic lock. */
async function mutateEntries(
  path: string,
  options: CreateErrorLogOptions,
  mutate: (entries: ReadonlyArray<ErrorLogEntry>) => ReadonlyArray<ErrorLogEntry>
): Promise<ResultType<void, ErrorLogIoError>> {
  const prepared = await options.fileSystem.makeDirectory(dirname(path));
  if (prepared.status === "error") {
    return prepared;
  }

  const acquired = await options.locks.acquire(ERROR_LOG_LOCK_KEY);
  if (acquired.status === "error") {
    return acquired;
  }

  const existing = await readEntries(path, options.fileSystem);
  let operation: ResultType<void, ErrorLogIoError>;
  if (existing.status === "error") {
    operation = existing;
  } else {
    const retained = retainUnexpired(existing.value, options.clock.now(), options.configuration.ttl.milliseconds);
    operation = await replaceEntries(path, mutate(retained), options.fileSystem);
  }

  const released = await acquired.value.release();
  if (operation.status === "error") {
    return operation;
  }
  return released;
}

/** Read records under the same lock used by mutations. */
async function readEntriesWhileLocked(
  path: string,
  options: CreateErrorLogOptions
): Promise<ResultType<ReadonlyArray<ErrorLogEntry>, ErrorLogIoError>> {
  const acquired = await options.locks.acquire(ERROR_LOG_LOCK_KEY);
  if (acquired.status === "error") {
    return acquired;
  }

  const entries = await readEntries(path, options.fileSystem);
  const released = await acquired.value.release();
  if (entries.status === "error") {
    return entries;
  }
  return released.status === "error" ? released : entries;
}

/** Parse valid versioned JSONL records, silently dropping malformed external lines. */
async function readEntries(
  path: string,
  fileSystem: Pick<RepositoryFileSystem, "readTextFile">
): Promise<ResultType<ReadonlyArray<ErrorLogEntry>, RepositoryFileSystemError>> {
  const contents = await fileSystem.readTextFile(path);
  if (contents.status === "error") {
    return isMissingCause(contents.error.cause) ? Result.ok([]) : contents;
  }

  const entries: Array<ErrorLogEntry> = [];
  for (const line of contents.value.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = Result.try({ try: () => parseJsonValue(line), catch: () => undefined });
    if (parsed.status === "error" || parsed.value === undefined) {
      continue;
    }
    const entry = parseEntry(parsed.value);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return Result.ok(entries);
}

/** Parse the fields needed to safely retain one record from disk. */
function parseEntry(value: JsonValue): ErrorLogEntry | undefined {
  if (!Value.Check(ErrorLogEntrySchema, value) || Number.isNaN(Date.parse(value.timestamp))) {
    return undefined;
  }
  return value;
}

/** Retain records whose timestamp is inside the configured TTL window. */
function retainUnexpired(
  entries: ReadonlyArray<ErrorLogEntry>,
  now: Date,
  ttlMilliseconds: number
): ReadonlyArray<ErrorLogEntry> {
  const threshold = now.getTime() - ttlMilliseconds;
  return entries.filter((entry) => Date.parse(entry.timestamp) >= threshold);
}

/** Atomically replace the JSONL file and clean up an unpublished temporary file. */
async function replaceEntries(
  path: string,
  entries: ReadonlyArray<ErrorLogEntry>,
  fileSystem: Pick<RepositoryFileSystem, "writeTextFile" | "rename" | "remove">
): Promise<ResultType<void, RepositoryFileSystemError>> {
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  const contents = entries.length === 0 ? "" : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const written = await fileSystem.writeTextFile(temporaryPath, contents);
  if (written.status === "error") {
    return written;
  }

  const renamed = await fileSystem.rename(temporaryPath, path);
  if (renamed.status === "error") {
    await fileSystem.remove(temporaryPath, "entry");
    return renamed;
  }
  return Result.ok(undefined);
}

/** Identify an absent optional log file through a nested Node filesystem cause. */
function isMissingCause(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
