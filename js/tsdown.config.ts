import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" }, // no types needed for the CLI entry

  clean: true,
  // Emit .js / .d.ts instead of the default .mjs / .d.mts (package is ESM).
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  // Zero runtime deps — nothing to externalize.
});
