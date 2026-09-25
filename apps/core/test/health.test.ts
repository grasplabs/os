import { routerSecretHeader } from "@grasp-os/shared/router";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

// Smoke test: proves the Worker, its bindings and Durable Objects boot in
// workerd. The only test of its kind; everything else tests behaviour.
describe("core", () => {
  it("boots and answers health checks", async () => {
    const response = await exports.default.fetch("https://core/health", {
      headers: { [routerSecretHeader]: env.ROUTER_SECRET },
    });
    expect(response.status).toBe(200);
  });
});
