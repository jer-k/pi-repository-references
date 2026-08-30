import { dirname, isAbsolute, join, resolve } from "node:path";

import { Result, type Result as ResultType } from "better-result";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  ConfigurationJsonParseError,
  ConfigurationReadError,
  ConfigurationValidationError,
  UnsupportedConfigurationVersionError,
} from "../repository-reference-errors.ts";
import { parseAlias, type Alias } from "./alias.ts";
import { parseJsonValue, type JsonValue } from "./json-value.ts";
import type { RepositoryFileSystem } from "./ports.ts";
import { DEFAULT_REFRESH_POLICY, parseRefreshPolicy, type RefreshPolicy } from "./refresh-policy.ts";
import { parseRepositorySource, type RepositorySource } from "./repository-source.ts";

/** Pi's project configuration directory name. */
export const CONFIG_DIR_NAME = ".pi";

/** Repository References configuration filename in global and project scopes. */
export const CONFIG_FILE_NAME = "repository-references.json";

/** A parsed Local Reference before local Git validation. */
export type LocalReferenceConfiguration = {
  readonly _tag: "local";
  readonly alias: Alias;
  readonly path: string;
  readonly description: string | undefined;
};

/** A parsed Remote Reference with its effective Refresh Policy. */
export type RemoteReferenceConfiguration = {
  readonly _tag: "remote";
  readonly alias: Alias;
  readonly repository: RepositorySource;
  readonly configuredRef: string | undefined;
  readonly description: string | undefined;
  readonly refresh: RefreshPolicy;
};

/** One fully merged and parsed Repository Reference entry. */
export type RepositoryReferenceConfiguration = LocalReferenceConfiguration | RemoteReferenceConfiguration;

/** One strict version 1 document, before global/project policy inheritance. */
export type ParsedConfigurationDocument = {
  readonly references: ReadonlyMap<string, ParsedReferenceEntry>;
  readonly refresh: RefreshPolicy | undefined;
};

/** Successfully loaded and merged configuration. */
export type RepositoryReferencesConfiguration = {
  readonly references: ReadonlyMap<string, RepositoryReferenceConfiguration>;
  readonly fileWideRefresh: RefreshPolicy;
};

/** Inputs for trust-aware global and project configuration loading. */
export type LoadConfigurationOptions = {
  readonly agentDirectory: string;
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly projectTrusted: boolean;
  readonly configDirectoryName?: string;
  readonly fileSystem: Pick<RepositoryFileSystem, "readTextFile">;
};

/** Expected failures that disable the complete configured reference set. */
export type ConfigurationLoadError =
  | ConfigurationReadError
  | ConfigurationJsonParseError
  | UnsupportedConfigurationVersionError
  | ConfigurationValidationError;

type ParsedLocalReference = LocalReferenceConfiguration;
type ParsedRemoteReference = Omit<RemoteReferenceConfiguration, "refresh"> & {
  readonly configuredRefresh: RefreshPolicy | undefined;
};

/** A strict reference entry retaining an optional per-entry policy before merge inheritance. */
export type ParsedReferenceEntry = ParsedLocalReference | ParsedRemoteReference;

const DurationSchema = Type.String({ pattern: "^[1-9][0-9]*[mhd]$" });
const DescriptionSchema = Type.String({ minLength: 1, pattern: "\\S" });
const SessionRefreshSchema = Type.Object({ policy: Type.Literal("session") }, { additionalProperties: false });
const ManualRefreshSchema = Type.Object({ policy: Type.Literal("manual") }, { additionalProperties: false });
const TtlRefreshSchema = Type.Object(
  { policy: Type.Literal("ttl"), ttl: DurationSchema },
  { additionalProperties: false }
);
const RefreshSchema = Type.Union([SessionRefreshSchema, ManualRefreshSchema, TtlRefreshSchema]);
const LocalReferenceSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    description: Type.Optional(DescriptionSchema),
  },
  { additionalProperties: false }
);
const RemoteReferenceSchema = Type.Object(
  {
    repository: Type.String({ minLength: 1 }),
    ref: Type.Optional(Type.String()),
    description: Type.Optional(DescriptionSchema),
    refresh: Type.Optional(RefreshSchema),
  },
  { additionalProperties: false }
);
const ReferenceSchema = Type.Union([LocalReferenceSchema, RemoteReferenceSchema]);
const ConfigurationSchema = Type.Object(
  {
    version: Type.Literal(1),
    refresh: Type.Optional(RefreshSchema),
    references: Type.Record(Type.String({ pattern: "^[a-z0-9][a-z0-9._-]*$" }), ReferenceSchema),
  },
  { additionalProperties: false }
);
type ConfigurationProtocol = Static<typeof ConfigurationSchema>;
type ReferenceProtocol = Static<typeof ReferenceSchema>;

/**
 * Parse one strict version 1 document and resolve Local Reference paths from its directory.
 *
 * @param input - Parsed but otherwise untrusted JSON value.
 * @param configurationPath - Source path used for diagnostics and relative path resolution.
 * @param homeDirectory - Home directory used for `~` expansion.
 * @returns A parsed document or the first schema/version failure.
 */
export function parseConfigurationDocument(
  input: JsonValue,
  configurationPath: string,
  homeDirectory: string
): ResultType<ParsedConfigurationDocument, ConfigurationLoadError> {
  if (!Value.Check(ConfigurationSchema, input)) {
    const errors = [...Value.Errors(ConfigurationSchema, input)];
    const versionError = errors.find((error) => error.instancePath === "/version" && error.keyword === "const");
    if (versionError !== undefined) {
      return Result.err(
        new UnsupportedConfigurationVersionError({
          path: configurationPath,
          actualVersion: "present but unsupported",
          message: `Unsupported Repository References configuration version in ${configurationPath}`,
        })
      );
    }

    const firstError = errors[0];
    return validationError(
      configurationPath,
      formatIssuePath(firstError?.instancePath ?? ""),
      firstError?.message ?? "invalid document"
    );
  }

  return parseConfigurationProtocol(input, configurationPath, homeDirectory);
}

/**
 * Load optional global and trusted-project documents and merge complete entries.
 *
 * An error in either present document returns one diagnostic and no partial reference set.
 */
export async function loadRepositoryReferencesConfiguration(
  options: LoadConfigurationOptions
): Promise<ResultType<RepositoryReferencesConfiguration, ConfigurationLoadError>> {
  const globalPath = join(options.agentDirectory, CONFIG_FILE_NAME);
  const globalDocument = await readOptionalDocument(globalPath, options);
  if (globalDocument.status === "error") return globalDocument;

  let projectDocument: ParsedConfigurationDocument | undefined;
  if (options.projectTrusted) {
    const projectPath = join(options.cwd, options.configDirectoryName ?? CONFIG_DIR_NAME, CONFIG_FILE_NAME);
    const loadedProject = await readOptionalDocument(projectPath, options);
    if (loadedProject.status === "error") return loadedProject;
    projectDocument = loadedProject.value;
  }

  return Result.ok(mergeConfigurationDocuments(globalDocument.value, projectDocument));
}

/** Merge documents with whole-entry project replacement and file-wide policy replacement. */
export function mergeConfigurationDocuments(
  globalDocument: ParsedConfigurationDocument | undefined,
  projectDocument: ParsedConfigurationDocument | undefined
): RepositoryReferencesConfiguration {
  const fileWideRefresh = projectDocument?.refresh ?? globalDocument?.refresh ?? DEFAULT_REFRESH_POLICY;
  const parsedEntries = new Map<string, ParsedReferenceEntry>(globalDocument?.references);
  for (const [alias, reference] of projectDocument?.references ?? []) {
    parsedEntries.set(alias, reference);
  }

  const references = new Map<string, RepositoryReferenceConfiguration>();
  for (const [alias, reference] of parsedEntries) {
    references.set(alias, reference._tag === "local" ? reference : applyEffectiveRefresh(reference, fileWideRefresh));
  }

  return { references, fileWideRefresh };
}

/** Convert a schema-parsed configuration protocol into refined entries. */
function parseConfigurationProtocol(
  input: ConfigurationProtocol,
  configurationPath: string,
  homeDirectory: string
): ResultType<ParsedConfigurationDocument, ConfigurationValidationError> {
  let refresh: RefreshPolicy | undefined;
  if (input.refresh !== undefined) {
    const parsedRefresh = parseRefreshPolicy(input.refresh);
    if (parsedRefresh.status === "error") {
      return validationError(configurationPath, "refresh", parsedRefresh.error.message);
    }
    refresh = parsedRefresh.value;
  }

  const references = new Map<string, ParsedReferenceEntry>();
  for (const [aliasInput, referenceInput] of Object.entries(input.references)) {
    const alias = parseAlias(aliasInput);
    if (alias.status === "error") {
      return validationError(configurationPath, `references.${aliasInput}`, alias.error.message);
    }
    const reference = parseReferenceProtocol(alias.value, referenceInput, configurationPath, homeDirectory);
    if (reference.status === "error") return reference;
    references.set(aliasInput, reference.value);
  }

  return Result.ok({ references, refresh });
}

/** Parse one Local or Remote Reference protocol into its domain entry. */
function parseReferenceProtocol(
  alias: Alias,
  input: ReferenceProtocol,
  configurationPath: string,
  homeDirectory: string
): ResultType<ParsedReferenceEntry, ConfigurationValidationError> {
  if ("path" in input) {
    return Result.ok({
      _tag: "local",
      alias,
      path: resolveLocalPath(input.path, dirname(configurationPath), homeDirectory),
      description: input.description,
    });
  }

  const repository = parseRepositorySource(input.repository);
  if (repository.status === "error") {
    return validationError(configurationPath, `references.${alias}.repository`, repository.error.reason);
  }

  let configuredRefresh: RefreshPolicy | undefined;
  if (input.refresh !== undefined) {
    const parsedRefresh = parseRefreshPolicy(input.refresh, `references.${alias}.refresh`);
    if (parsedRefresh.status === "error") {
      return validationError(configurationPath, `references.${alias}.refresh`, parsedRefresh.error.message);
    }
    configuredRefresh = parsedRefresh.value;
  }
  return Result.ok({
    _tag: "remote",
    alias,
    repository: repository.value,
    configuredRef: input.ref,
    description: input.description,
    configuredRefresh,
  });
}

/** Apply policy inheritance to a Remote Reference without field-level entry merging. */
function applyEffectiveRefresh(
  reference: ParsedRemoteReference,
  fileWideRefresh: RefreshPolicy
): RemoteReferenceConfiguration {
  return {
    _tag: "remote",
    alias: reference.alias,
    repository: reference.repository,
    configuredRef: reference.configuredRef,
    description: reference.description,
    refresh: reference.configuredRefresh ?? fileWideRefresh,
  };
}

/** Read and parse one optional configuration file. */
async function readOptionalDocument(
  path: string,
  options: LoadConfigurationOptions
): Promise<ResultType<ParsedConfigurationDocument | undefined, ConfigurationLoadError>> {
  const contents = await options.fileSystem.readTextFile(path);
  if (contents.status === "error") {
    const cause = contents.error.cause;
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return Result.ok(undefined);
    }
    return Result.err(
      new ConfigurationReadError({
        path,
        cause,
        message: `Could not read Repository References configuration ${path}`,
      })
    );
  }

  const json = Result.try({
    try: () => parseJsonValue(contents.value),
    catch: (cause) =>
      new ConfigurationJsonParseError({
        path,
        cause,
        message: `Could not parse Repository References configuration ${path} as JSON`,
      }),
  });
  if (json.status === "error") return json;
  return parseConfigurationDocument(json.value, path, options.homeDirectory);
}

/** Resolve absolute, home-relative, and configuration-directory-relative Local paths. */
function resolveLocalPath(input: string, configurationDirectory: string, homeDirectory: string): string {
  if (input === "~") return resolve(homeDirectory);
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return resolve(homeDirectory, input.slice(2));
  }
  return isAbsolute(input) ? resolve(input) : resolve(configurationDirectory, input);
}

/** Render a TypeBox instance path as a configuration issue path. */
function formatIssuePath(instancePath: string): string {
  const issuePath = instancePath.replace(/^\//u, "").replaceAll("/", ".");
  return issuePath.length === 0 ? "$" : issuePath;
}

/** Construct one path-addressed strict configuration validation failure. */
function validationError(
  path: string,
  issuePath: string,
  reason: string
): ResultType<never, ConfigurationValidationError> {
  return Result.err(
    new ConfigurationValidationError({
      path,
      issuePath,
      reason,
      message: `Invalid Repository References configuration at ${issuePath}: ${reason}`,
    })
  );
}
