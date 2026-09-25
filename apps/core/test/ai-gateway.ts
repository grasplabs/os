/**
 * A stand-in for AI Gateway behind the AI binding: it answers each request
 * with the next scripted reply, in the wire format of the provider route the
 * request went to, and keeps every request it got.
 */

/** A scripted answer, or a refusal with an HTTP status. */
export type GatewayReply =
  | { text: string; inputTokens: number; outputTokens: number }
  | { status: number };

export interface GatewayRequest {
  url: string;
  headers: Headers;
  body: unknown;
}

const encoder = new TextEncoder();

/** A server-sent event stream of `events`, each with its SSE event name. */
const eventStream = (
  events: readonly { event?: string; data: unknown }[],
  logId: string
): Response =>
  new Response(
    encoder.encode(
      events
        .map(({ event, data }) =>
          [
            ...(event === undefined ? [] : [`event: ${event}`]),
            `data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
            "",
            "",
          ].join("\n")
        )
        .join("")
    ),
    {
      headers: {
        "content-type": "text/event-stream",
        "cf-aig-log-id": logId,
      },
    }
  );

type Answer = Extract<GatewayReply, { text: string }>;

const anthropicEvents = ({ text, inputTokens, outputTokens }: Answer) => [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    },
  },
  {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 0 },
  },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
  },
  { event: "message_stop", data: { type: "message_stop" } },
];

const chunk = (fields: object) => ({
  data: {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "model",
    ...fields,
  },
});

const chatCompletionEvents = ({ text, inputTokens, outputTokens }: Answer) => [
  chunk({
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  chunk({
    choices: [],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  }),
  { data: "[DONE]" },
];

const responsesEvents = ({ text, inputTokens, outputTokens }: Answer) => {
  const message = { type: "message", id: "msg_1", role: "assistant" };
  return [
    {
      data: {
        type: "response.created",
        response: { id: "resp_1", status: "in_progress" },
      },
    },
    {
      data: {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, content: [] },
      },
    },
    {
      data: {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: text,
      },
    },
    {
      data: {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          ...message,
          content: [{ type: "output_text", text, annotations: [] }],
        },
      },
    },
    {
      data: {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        },
      },
    },
  ];
};

/** The provider's stream for `answer`, by the gateway route requested. */
const providerStream = (url: URL, answer: Answer, logId: string): Response => {
  if (url.pathname.endsWith("/v1/messages")) {
    return eventStream(anthropicEvents(answer), logId);
  }
  if (url.pathname.endsWith("/chat/completions")) {
    return eventStream(chatCompletionEvents(answer), logId);
  }
  if (url.pathname.endsWith("/responses")) {
    return eventStream(responsesEvents(answer), logId);
  }
  return new Response("No such route", { status: 404 });
};

/**
 * A fake AI binding whose gateway answers with `replies`, in order. Its
 * `requests` are what reached the gateway.
 */
export const fakeGateway = (...replies: GatewayReply[]) => {
  const requests: GatewayRequest[] = [];
  const fetch = async (
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: await request.json(),
    });
    const reply = replies.shift();
    if (reply === undefined) {
      throw new Error("The fake gateway has no reply left");
    }
    if ("status" in reply) {
      return Response.json(
        { error: { type: "error", message: "Refused by the fake gateway" } },
        { status: reply.status }
      );
    }
    return providerStream(
      new URL(request.url),
      reply,
      `log-${requests.length}`
    );
  };
  return { binding: { aiGatewayLogId: null, fetch }, requests };
};
