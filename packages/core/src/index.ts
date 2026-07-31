/**
 * @foundry/core — engine-agnostic kernel for foundry.
 *
 * Public entrypoint. Re-exports the contracts (§5) and the kernel modules
 * (§4): config, state, plan, apply, runtime, cli. The core never imports a
 * concrete provisioner or connector — only the contract shapes.
 */

export * from "./contracts.js";
export * from "./config/index.js";
export * from "./state/index.js";
export * from "./plan/index.js";
export * from "./apply/index.js";
export * from "./runtime/index.js";
export * from "./migrations/index.js";
export * from "./cli/index.js";
