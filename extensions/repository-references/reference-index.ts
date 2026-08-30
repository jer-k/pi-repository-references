import { posix } from "node:path";

/** An immutable index of visible repository files and their derived directories. */
export type ReferenceIndex = {
  /** Repository-relative file paths using Git's `/` separator. */
  readonly files: ReadonlySet<string>;
  /** Repository-relative directories derived from indexed files. */
  readonly directories: ReadonlySet<string>;
};

/**
 * Construct a file and directory index from NUL-delimited `git ls-files` output.
 *
 * @param output - Raw NUL-delimited Git output.
 * @returns An immutable index with all ancestor directories derived from files.
 */
export function buildReferenceIndex(output: string): ReferenceIndex {
  const files = new Set(output.split("\0").filter((path) => path.length > 0));
  const directories = new Set<string>();
  for (const file of files) {
    let directory = posix.dirname(file);
    while (directory !== ".") {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  return { files, directories };
}
