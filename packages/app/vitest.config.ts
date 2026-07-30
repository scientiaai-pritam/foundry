import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

/**
 * The E2E test crosses three workspace packages (@foundry/core,
 * @foundry/aws-dynamodb, @foundry/connector-dynamodb). We alias each bare
 * specifier to its SOURCE entry so the slice runs against real source across
 * package boundaries without requiring every package's `dist` to be built
 * first — mirroring how each package's own contract tests run.
 */
const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@foundry/core": src("../core/src/index.ts"),
      "@foundry/aws-dynamodb": src("../provisioners/aws-dynamodb/src/index.ts"),
      "@foundry/connector-dynamodb": src("../connectors/dynamodb/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
