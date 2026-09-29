import type { Message } from "@earendil-works/pi-ai";
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { workspace } from "../src/durable-objects.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { Answer, GatewayReply } from "./ai-gateway.ts";

// A chat's agent, as the tests drive it: the Workspace object's loop, the
// code it runs in isolates of their own, and the model gateway, all real.
// The outside system is the model provider behind AI Gateway: a fake behind
// the object's AI binding answers with scripted replies, in the provider's
// own wire format.

export const model = "anthropic/claude-sonnet-4-5";

/** The model calls `executeCode` with `code`, `times` times at once. */
export const codeStep = (code: string, times = 1): Answer => ({
  text: "",
  toolCalls: Array.from({ length: times }, () => ({
    id: `call_${crypto.randomUUID()}`,
    name: "executeCode",
    arguments: { code },
  })),
  inputTokens: 200,
  outputTokens: 40,
});

/** The model answers. */
export const says = (text: string): Answer => ({
  text,
  inputTokens: 200,
  outputTokens: 20,
});

/**
 * `answer`, its stream stopped after its text's first `at` characters until
 * released: the model still answering, for as long as a test needs.
 */
export const pausedReply = (answer: Answer, at: number) => {
  const release = Promise.withResolvers<boolean>();
  const reply: Answer = { ...answer, pause: { at, until: release.promise } };
  return {
    reply,
    release: () => {
      release.resolve(true);
    },
  };
};

export type WorkspaceStub = ReturnType<typeof workspace>;

/** The deployment's model config: the model the tests use, and no other. */
export const gatewayConfig = { gateway: "grasp-os-test", models: [model] };

/**
 * Points the object's model gateway at a fake AI Gateway, with `config`,
 * and switches the agent on or off, the other flags as the tests' env
 * sets them (the client's model rules on). Objects may share their env,
 * so every test sets both; a restarted object may get a new one, so it is
 * pointed again.
 */
export const pointAtGateway = async (
  stub: WorkspaceStub,
  gateway: ReturnType<typeof fakeGateway>,
  {
    agentOn = true,
    config = gatewayConfig,
  }: { agentOn?: boolean; config?: object } = {}
) => {
  await runInDurableObject(stub, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The Workspace object has no env");
    }
    Object.assign(objectEnv, {
      AI: gateway.binding,
      MODEL_GATEWAY: config,
      FEATURES: {
        ...z.record(z.string(), z.boolean()).parse(env.FEATURES),
        agent: agentOn,
      },
    });
  });
};

/**
 * A new chat of `personId`'s in a new workspace, answered by `replies`,
 * and the agent subject its permissions are granted to.
 */
export const chatOf = async (personId: string, ...replies: GatewayReply[]) => {
  const id = workspaceIdSchema.parse(crypto.randomUUID());
  const stub = workspace(env, id);
  const chat = await stub.createChat("Questions", personId, id);
  const gateway = fakeGateway(...replies);
  await pointAtGateway(stub, gateway);
  const ask = async (text: string) => await stub.ask(chat.id, { text, model });
  // The workspace's agent: its grants hold in all the workspace's chats.
  const agent = { type: "agent" as const, agentId: id };
  return { id, stub, chat, personId, gateway, ask, agent };
};

/** The chat's transcript, as the object keeps it. */
export const transcript = async (
  stub: WorkspaceStub,
  chatId: string
): Promise<Message[]> =>
  await runInDurableObject(stub, (instance) => instance.messages(chatId));

/** What the code steps of the chat returned, or threw, as the model read it. */
export const codeResults = async (stub: WorkspaceStub, chatId: string) => {
  const messages = await transcript(stub, chatId);
  return messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          {
            isError: message.isError,
            text: message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join(""),
          },
        ]
      : []
  );
};
