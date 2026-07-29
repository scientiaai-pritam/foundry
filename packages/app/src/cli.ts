#!/usr/bin/env node
/**
 * `scientia` CLI binary (composition root, design v1, §4 "cli").
 *
 * The kernel's `main()` builds its own context but defaults to EMPTY plugin
 * maps, so without this binary `scientia apply` / `destroy` / `migrate` find no
 * provisioner or connector. This entry builds the default plugin registry
 * (provisioner for "aws.dynamodb" + connector for "dynamodb") and hands it to
 * `main()`, wiring the slice end-to-end.
 *
 * Run: `scientia plan|apply|migrate|destroy` from a directory containing a
 * `scientia.config.{ts,js}`. Region resolves from AWS_REGION / AWS_DEFAULT_REGION.
 */
import { main } from "@scientia/core";
import { buildDefaultPlugins } from "./context.js";

async function run(): Promise<number> {
  // buildDefaultPlugins resolves region from the ambient credential chain
  // (AWS_REGION / AWS_DEFAULT_REGION) and throws if neither is set.
  const plugins = buildDefaultPlugins();
  return main(process.argv, {
    provisioners: plugins.provisioners,
    connectors: plugins.connectors,
  });
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    const label = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(label);
    process.exit(1);
  });
