// test/workers-pool-smoke.worker.test.ts
//
// Smoke test proving the Workers Vitest pool is wired up correctly: these
// assertions only hold when the test executes inside the Cloudflare Workers
// runtime (workerd) via @cloudflare/vitest-pool-workers, not plain Node.
import { describe, expect, it } from "vitest";

describe("vitest-pool-workers smoke test", () => {
  it("runs inside the Cloudflare Workers runtime", () => {
    // workerd reports this exact user agent; Node reports "Node.js/<version>".
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("exposes WebCrypto, which src/crypto.ts relies on", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("mcpforoura")
    );
    expect(digest.byteLength).toBe(32);
  });
});
