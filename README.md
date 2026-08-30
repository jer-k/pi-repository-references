# Pi Repository References

A TypeScript [Pi](https://github.com/earendil-works/pi) extension for consulting source code from Git repositories outside the active project.

The domain language and intended behavior are documented in [`CONTEXT.md`](./CONTEXT.md).

## Development

Requirements:

- Node.js 22.19 or newer
- npm
- Pi

Install dependencies and run the development checks:

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run test:integration
```

Formatting is managed with Oxfmt:

```bash
npm run format
npm run format:check
```

Load the extension directly from this checkout while developing:

```bash
pi -e .
```

Pi executes extension TypeScript directly, so no build step is required. The extension entry point is [`extensions/repository-references.ts`](./extensions/repository-references.ts).

## Local installation

Install this checkout as a Pi package:

```bash
pi install /absolute/path/to/pi-repository-references
```

For project-local installation, add `-l`:

```bash
pi install -l /absolute/path/to/pi-repository-references
```
