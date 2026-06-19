import { defineConfig } from "tsup";

export default defineConfig({
  // Object form pins the output to dist/cli/index.js (matches package.json bin
  // and the launchd installer). A bare string entry would flatten to dist/index.js.
  entry: { "cli/index": "src/cli/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  // Native module — keep external so it loads the prebuilt .node at runtime.
  external: ["better-sqlite3", "@anthropic-ai/claude-agent-sdk"],
});
