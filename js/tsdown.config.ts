import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // Emit .js / .d.ts instead of the default .mjs / .d.mts (package is ESM).
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  // Zero runtime deps — nothing to externalize.
});
