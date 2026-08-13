import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  /**
   * core is external, and that is the point.
   *
   * It used to be bundled, because it was `private: true` and resolved to raw
   * TypeScript -- leaving it external would have made the published SDK import
   * a `.ts` file at runtime. That fixed the JavaScript and left the types
   * broken: the declaration pass does not follow `noExternal`, so index.d.ts
   * still carried `import { … } from '@agentsignal/core'`, naming a package
   * npm would never have. JS consumers were fine, and every TypeScript
   * consumer got an unresolvable module.
   *
   * Inlining the types instead is a dead end worth recording, because the near
   * miss looks like a fix: give core a `types` entry and rollup-plugin-dts
   * follows one level, then emits `from './endpoints.js'` -- a relative path
   * to a file no tarball contains. Grepping for "core" would have called that
   * success and shipped it.
   *
   * So core is published, and both the import and the type are simply true.
   * One copy on disk, shared with the CLI and the MCP server.
   */
  external: ['@agentsignal/core'],
});
