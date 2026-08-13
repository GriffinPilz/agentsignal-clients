import { defineConfig } from 'tsup';

/**
 * Three entries because three are imported.
 *
 * `.` is the whole surface, and `./endpoints` and `./priority` exist so the
 * dashboard can pull in a URL rule or a priority table without dragging zod
 * into a browser bundle. Publishing has to preserve that -- collapsing them
 * into one entry would silently undo the reason they were split.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/endpoints.ts', 'src/priority.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // zod stays external: it is a real dependency of this package, and bundling
  // it would ship a second copy alongside whatever the consumer already has.
  external: ['zod'],
});
