/**
 * Free-port selection for the local Postgres provisioner. Used when a spec omits
 * `port` so a fresh local DB never collides with a host Postgres on 5432.
 */
import { createServer } from "node:net";

/**
 * Reserve and immediately release an ephemeral TCP port by listening on port 0
 * (the OS picks a free one). There is an inherent TOCTOU window between release
 * and Docker's bind; if Docker then loses the race, its error is surfaced as-is.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
