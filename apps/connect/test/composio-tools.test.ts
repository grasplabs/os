import { signCapability } from "@grasp-os/shared/capability";
import { composioConsentText } from "@grasp-os/shared/connect";
import type { ComposioToolRule } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { fakeComposioApi } from "./composio-api.ts";
import {
  addConnection,
  agentFor,
  auditEvents,
  callAs,
  chatOrigin,
  clientOrigin,
  outcome,
  someone,
} from "./connect.ts";
import type { Call } from "./connect.ts";

// The admin's allowlist for a Composio connection (threat model CN16):
// which of its tools only read, and which input property names the one
// resource a call acts on. Connect goes by it, never by what Composio's
// server declares about its own tools: a tool is a read only if the admin
// said so, and held to one resource only by the property the admin named.
// The ways that could fail come first: a server declaring a write
// read-only, or naming a resource property of its own; an admin's rule
// naming a property the tool doesn't take.

const composio = fakeComposioApi(
  [
    {
      slug: "hubspot",
      name: "HubSpot",
      tools: [
        { slug: "HUBSPOT_LIST_CONTACTS", inputs: ["owner_id", "limit"] },
        {
          slug: "HUBSPOT_GET_CONTACT",
          inputs: ["contact_id"],
          // Composio says it only reads; the list above, it says nothing of.
          tags: ["readOnlyHint"],
        },
        { slug: "HUBSPOT_CREATE_CONTACT", inputs: ["owner_id", "email"] },
      ],
    },
  ],
  {
    mcpTools: [
      {
        name: "HUBSPOT_LIST_CONTACTS",
        inputs: ["owner_id", "limit"],
        run: ({ owner_id: owner }) => ({ output: { owner, contacts: [] } }),
      },
      {
        // The server says it only reads, and where its resource is.
        name: "HUBSPOT_GET_CONTACT",
        readOnly: true,
        resourceField: "contact_id",
        inputs: ["contact_id"],
        run: ({ contact_id: id }) => ({ output: { id } }),
      },
      {
        name: "HUBSPOT_CREATE_CONTACT",
        inputs: ["owner_id", "email"],
        run: () => ({ output: { id: "contact-3" } }),
      },
    ],
  }
);

const { events } = auditEvents();

/** The admin's allowlist for the connections here. */
const rules: (string | ComposioToolRule)[] = [
  { name: "HUBSPOT_LIST_CONTACTS", read: true, resource: "owner_id" },
  // Allowed by name alone: a side effect, never held to one resource.
  "HUBSPOT_GET_CONTACT",
  { name: "HUBSPOT_CREATE_CONTACT", resource: "owner_id" },
];

/** A HubSpot connection allowing `rules`, as the flow leaves it. */
const hubspot = async (): Promise<string> =>
  await addConnection({
    provider: "hubspot",
    server: `https://backend.composio.dev/v3/mcp/${crypto.randomUUID()}?connected_account_id=ca_1`,
    tools: JSON.stringify(rules),
  });

const owner = "owner-7";

/** Where a run's call comes from, as core signs it. */
const runOrigin = {
  permissionId: "permission-hubspot",
  context: { type: "run" as const, appId: "app-crm", runId: "run-1" },
};

/** An answer's output, as the JSON value it holds. */
const parsed = (text: string): unknown => JSON.parse(text);

/** A call without an idempotency key. */
const read = (
  connectionId: string,
  action: string,
  input: Call["input"] = {}
): Call => ({ connectionId, action, input });

describe("a Composio tool the admin marked as a read", () => {
  it("runs without an idempotency key, from chat too, without waiting for anyone", async () => {
    const connectionId = await hubspot();
    const inChat = agentFor("user-anna", "agent-chat", "interactive");
    const result = await callAs(
      inChat,
      read(connectionId, "HUBSPOT_LIST_CONTACTS", { limit: "5" }),
      { origin: chatOrigin }
    );
    expect(JSON.parse(result.output)).toStrictEqual({ contacts: [] });
    const [call] = await events();
    expect(call?.detail).toMatchObject({ sideEffect: false, outcome: "ok" });
  });

  it("is held for its person in a restricted context, as a side effect: what it sends may carry that data", async () => {
    const anna = someone();
    const connectionId = await hubspot();
    const run = agentFor(anna.userId);
    const signed = { restricted: true, origin: runOrigin };
    const withoutKey = await outcome(
      callAs(run, read(connectionId, "HUBSPOT_LIST_CONTACTS"), signed)
    );
    const call = {
      ...read(connectionId, "HUBSPOT_LIST_CONTACTS", { owner_id: owner }),
      idempotencyKey: "run-1:list",
    };
    const withKey = await outcome(callAs(run, call, signed));
    const ranBefore = [...composio.state.mcp.ran];
    const [held, ...others] = await exports.default.listPendingActions(anna);
    if (held === undefined || others.length > 0) {
      throw new Error("Expected one held action");
    }
    const confirmed = await exports.default.confirmAction({
      person: anna,
      id: held.id,
      inputHash: held.inputHash,
      capability: await signCapability(env.CAPABILITY_SIGNING_KEY, run, {
        connectionId,
        action: held.action,
        idempotencyKey: held.idempotencyKey,
        ...signed,
        confirms: held.id,
      }),
    });
    // The step tries again under the same key: it gets the answer, and
    // the tool doesn't run again.
    const repeat = await callAs(run, call, signed);
    const recorded = await events();
    const calls = recorded.filter(({ action }) => action === "connection.call");
    const output = { owner, contacts: [] };
    expect({
      withoutKey,
      withKey,
      ranBefore,
      confirmed: parsed(confirmed.output),
      repeat: parsed(repeat.output),
      outcomes: calls.map(({ detail }) => detail.outcome),
      ran: composio.state.mcp.ran,
    }).toStrictEqual({
      withoutKey: "connect.idempotency_key_required",
      withKey: "connect.held",
      ranBefore: [],
      confirmed: output,
      repeat: output,
      outcomes: ["refused", "held", "ok", "replayed"],
      ran: [{ tool: "HUBSPOT_LIST_CONTACTS", input: { owner_id: owner } }],
    });
  });

  it("is held to one resource by the input property the admin named", async () => {
    const connectionId = await hubspot();
    const forOwner = (input: Call["input"]) => ({
      ...read(connectionId, "HUBSPOT_LIST_CONTACTS", input),
      resource: owner,
    });
    const inputs: Call["input"][] = [
      { owner_id: owner, limit: "5" },
      { owner_id: "owner-8" },
      {},
      // A property the tool's schema doesn't take.
      { owner_id: owner, ownerId: "owner-8" },
    ];
    const ends = await Promise.all(
      inputs.map(
        async (input) =>
          await outcome(callAs(agentFor("user-anna"), forOwner(input)))
      )
    );
    expect(ends).toStrictEqual([
      "ok",
      "connect.resource_out_of_scope",
      "connect.resource_out_of_scope",
      "connect.resource_out_of_scope",
    ]);
    expect(composio.state.mcp.ran).toStrictEqual([
      { tool: "HUBSPOT_LIST_CONTACTS", input: { owner_id: owner, limit: "5" } },
    ]);
  });
});

describe("a Composio tool the admin didn't mark as a read", () => {
  it("is a side effect even when its server declares it read-only", async () => {
    const connectionId = await hubspot();
    await expect(
      outcome(
        callAs(
          agentFor("user-anna"),
          read(connectionId, "HUBSPOT_GET_CONTACT", { contact_id: "c-1" })
        )
      )
    ).resolves.toBe("connect.idempotency_key_required");
    expect(composio.state.mcp.ran).toStrictEqual([]);
  });

  it("waits in chat for its person, audited as a side effect, and doesn't run", async () => {
    const anna = someone();
    const connectionId = await hubspot();
    const inChat = agentFor(anna.userId, "agent-chat", "interactive");
    const call = {
      ...read(connectionId, "HUBSPOT_GET_CONTACT", { contact_id: "c-1" }),
      idempotencyKey: crypto.randomUUID(),
    };
    const answer = await callAs(inChat, call, { origin: chatOrigin });
    const [pending] = await exports.default.listPendingActions(anna);
    expect(answer.pending?.id).toBe(pending?.id);
    expect(pending?.action).toBe("HUBSPOT_GET_CONTACT");
    const [held] = await events();
    expect(held?.detail).toMatchObject({ sideEffect: true, outcome: "held" });
    expect(composio.state.mcp.ran).toStrictEqual([]);
  });

  it("isn't held to the resource property its server names, only to one the admin named", async () => {
    const connectionId = await hubspot();
    const call = {
      ...read(connectionId, "HUBSPOT_GET_CONTACT", { contact_id: "c-1" }),
      resource: "c-1",
      idempotencyKey: crypto.randomUUID(),
    };
    await expect(outcome(callAs(agentFor("user-anna"), call))).resolves.toBe(
      "connect.resource_out_of_scope"
    );
    // A write the admin held to a property runs for that resource only.
    const create = {
      ...read(connectionId, "HUBSPOT_CREATE_CONTACT", {
        owner_id: owner,
        email: "new@acme.test",
      }),
      resource: owner,
      idempotencyKey: crypto.randomUUID(),
    };
    await expect(outcome(callAs(agentFor("user-anna"), create))).resolves.toBe(
      "ok"
    );
    expect(composio.state.mcp.ran.map(({ tool }) => tool)).toStrictEqual([
      "HUBSPOT_CREATE_CONTACT",
    ]);
  });
});

/** Starts connecting HubSpot with `tools`, for an admin. */
const start = async (
  tools: (string | ComposioToolRule)[],
  person = someone("admin")
) =>
  await exports.default.startToolkitConnection({
    person,
    composio: true,
    toolkit: "hubspot",
    tools,
    consent: composioConsentText,
    origin: clientOrigin,
    returnTo: "/connections",
  });

describe("the admin's allowlist, when they connect", () => {
  it("is kept with the flow, rules and all, and the log names each tool that runs unheld, and whether Composio said it only reads", async () => {
    const admin = someone("admin");
    const allowed = [
      { name: "HUBSPOT_LIST_CONTACTS", read: true },
      { name: "HUBSPOT_GET_CONTACT", read: true },
      "HUBSPOT_CREATE_CONTACT",
    ];
    const { url } = await start(allowed, admin);
    const { state } = composio.authorize(url);
    await exports.default.finishConnection({
      person: admin,
      state,
      composio: true,
    });
    const recorded = await events();
    const counted = recorded
      .filter(({ action }) =>
        ["connection.consent", "connection.connect"].includes(action)
      )
      .map(({ action, detail }) => ({
        action,
        toolCount: detail.toolCount,
        readCount: detail.readCount,
        unhintedReadCount: detail.unhintedReadCount,
      }));
    expect(counted).toStrictEqual([
      {
        action: "connection.consent",
        toolCount: 3,
        readCount: 2,
        unhintedReadCount: 1,
      },
      {
        action: "connection.connect",
        toolCount: 3,
        readCount: 2,
        unhintedReadCount: undefined,
      },
    ]);
    const consent = recorded.find(
      ({ action }) => action === "connection.consent"
    );
    expect(
      recorded
        .filter(({ action }) => action === "connection.consent.read_tools")
        .map(({ actor, detail }) => ({ actor, detail }))
    ).toStrictEqual(
      [
        { hinted: false, part: 1, names1: "HUBSPOT_LIST_CONTACTS" },
        { hinted: true, part: 1, names1: "HUBSPOT_GET_CONTACT" },
      ].map((names) => ({
        actor: consent?.actor,
        detail: {
          provider: "hubspot",
          scope: "shared",
          flowId: consent?.detail.flowId,
          ...names,
        },
      }))
    );
    expect(consent?.detail).not.toHaveProperty("unnamedReadCount");
  });

  it("names only the tools' own input properties as resources, and each tool once", async () => {
    const refused = [
      [{ name: "HUBSPOT_GET_CONTACT", read: true, resource: "owner_id" }],
      [{ name: "HUBSPOT_GET_CONTACT", resource: "contact.id" }],
      [{ name: "HUBSPOT_EXPORT", read: true }],
      ["HUBSPOT_GET_CONTACT", { name: "HUBSPOT_GET_CONTACT", read: true }],
    ];
    const ends = await Promise.all(
      refused.map(async (tools) => await outcome(start(tools)))
    );
    expect(ends).toStrictEqual(refused.map(() => "connection.invalid"));
    expect(
      composio.state.requests.filter(({ method }) => method !== "GET")
    ).toStrictEqual([]);
  });

  it("gives Composio's server the allowed tools by name", async () => {
    const admin = someone("admin");
    const { url } = await start(rules, admin);
    const { state } = composio.authorize(url);
    await exports.default.finishConnection({
      person: admin,
      state,
      composio: true,
    });
    const [server] = composio.state.holds.servers.values();
    expect(server?.allowedTools).toStrictEqual([
      "HUBSPOT_LIST_CONTACTS",
      "HUBSPOT_GET_CONTACT",
      "HUBSPOT_CREATE_CONTACT",
    ]);
  });
});
