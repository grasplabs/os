import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import type { ConnectorManifest } from "@grasp-os/connector-kit/manifest";
import { connectErrors } from "@grasp-os/shared/connect";
import { log } from "@grasp-os/shared/log";
import { compatibilityDate } from "@grasp-os/shared/runtime";
import { exports } from "cloudflare:workers";

import bundled from "#connectors";

import type { Connection } from "./connections.ts";
import type { EgressProps } from "./egress.ts";
import { callTimeoutMs, mcpServer } from "./mcp.ts";
import type { McpServer } from "./mcp.ts";
import { accessTokenFor } from "./tokens.ts";

// Native connectors: our own MCP servers (packages/connectors), shipped in
// connect's release (build.ts) and run each in an isolate of its own
// through the Worker Loader. The isolate has an empty env, can't import
// connect's, and reaches the network only through the egress handler
// (egress.ts), whose props carry this call's token and the requests the
// called action declares. The token stays in connect: the connector's code
// never sees it (threat model R1, R9, EG1).
//
// Every call loads its own isolate (`LOADER.load`, not a cached `get`):
// the loader keeps an isolate's `globalOutbound` for as long as it keeps
// the isolate, so a cached one would send a later call's requests with an
// earlier call's token, for another connection or person. A fresh isolate
// also leaves nothing from one call in module state for the next (EG5).

/** A connector of this release: its manifest and its bundled module. */
interface NativeConnector {
  manifest: ConnectorManifest;
  code: string;
}

/** The release's connectors by name; one whose manifest is broken is left out. */
const connectors = new Map<string, NativeConnector>();
for (const { manifest, code } of bundled) {
  const parsed = connectorManifestSchema.safeParse(manifest);
  if (parsed.success) {
    connectors.set(parsed.data.name, { manifest: parsed.data, code });
  } else {
    log.error("connectors.invalid_manifest", {});
  }
}

/** The connector named `name` in this release, if there is one. */
export const nativeConnector = (name: string): NativeConnector | undefined =>
  connectors.get(name);

/**
 * How a connector's isolate runs: no importable env, and limits per call,
 * enforced by the runtime. Its env is empty; its one way out is the egress
 * handler.
 */
const isolate = {
  compatibilityDate,
  compatibilityFlags: ["disallow_importable_env"],
  limits: { cpuMs: 10_000, subRequests: 50 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/** The URL connect's MCP client posts to; the isolate answers any. */
const connectorEndpoint = "https://connector.internal/mcp";

/**
 * The MCP server for one call of `action` on a native `connection`, in a
 * fresh isolate of the connector the connection names. Refuses a
 * connector this release doesn't have, one for another provider than the
 * connection's (its token must never go to another provider's hosts), and
 * an action the connector doesn't declare, all before a token is read.
 */
export const nativeServer = async (
  env: Env,
  connection: Connection,
  action: string
): Promise<McpServer> => {
  const connector = nativeConnector(connection.server);
  if (connector?.manifest.provider !== connection.provider) {
    throw connectErrors.create("connect.server_unavailable");
  }
  const { manifest, code } = connector;
  const declared = Object.hasOwn(manifest.actions, action)
    ? manifest.actions[action]
    : undefined;
  if (declared === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  const props: EgressProps = {
    connector: `${manifest.name}@${manifest.version}`,
    hosts: manifest.hosts,
    routes: declared.routes,
    token: await accessTokenFor(env, connection.id),
    // The egress closes when connect's MCP client gives up on the call.
    expiresAt: Date.now() + callTimeoutMs,
  };
  const worker = env.LOADER.load({
    ...isolate,
    mainModule: "connector.js",
    modules: { "connector.js": code },
    env: {},
    globalOutbound: exports.ConnectorEgress({ props }),
  });
  const entrypoint = worker.getEntrypoint();
  return mcpServer(
    connectorEndpoint,
    async (request) => await entrypoint.fetch(request)
  );
};
