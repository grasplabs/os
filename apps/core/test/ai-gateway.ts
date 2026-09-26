/**
 * A stand-in for AI Gateway behind the AI binding: it answers each request
 * with the next scripted reply, in the wire format of the provider route the
 * request went to, and keeps every request it got.
 */

/** A tool call the model makes in a scripted answer. */
export interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A scripted answer; a refusal with an HTTP status and the provider's error
 * type; or no answer at all until the request is aborted.
 */
export type GatewayReply =
  | {
      text: string;
      /** Tool calls after the text; the answer then stops for them. */
      toolCalls?: ScriptedToolCall[];
      inputTokens: number;
      outputTokens: number;
      /** The model hit its output limit (Anthropic and chat completions). */
      truncated?: boolean;
    }
  | { status: number; errorType?: string }
  | { hang: true };

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

/** How the answer stopped, as `[end_turn, max_tokens, tool_use]` name it. */
const stopOf = (
  { toolCalls, truncated }: Answer,
  [stop, length, toolUse]: readonly [string, string, string]
): string => {
  if (truncated === true) {
    return length;
  }
  return (toolCalls ?? []).length > 0 ? toolUse : stop;
};

const anthropicEvents = (answer: Answer) => {
  const { text, inputTokens, outputTokens } = answer;
  const blocks = [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...(answer.toolCalls ?? []).map((call) => ({
      type: "tool_use" as const,
      ...call,
    })),
  ];
  return [
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
    ...blocks.flatMap((block, index) => [
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block:
            block.type === "text"
              ? { type: "text", text: "" }
              : { type: "tool_use", id: block.id, name: block.name, input: {} },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta:
            block.type === "text"
              ? { type: "text_delta", text: block.text }
              : {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.arguments),
                },
        },
      },
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index },
      },
    ]),
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: stopOf(answer, ["end_turn", "max_tokens", "tool_use"]),
          stop_sequence: null,
        },
        usage: { output_tokens: outputTokens },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
};

const chunk = (fields: object) => ({
  data: {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "model",
    ...fields,
  },
});

const chatCompletionEvents = (answer: Answer) => {
  const { text, inputTokens, outputTokens } = answer;
  return [
    chunk({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    }),
    ...(answer.toolCalls ?? []).map((call, index) =>
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    ),
    chunk({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: stopOf(answer, ["stop", "length", "tool_calls"]),
        },
      ],
    }),
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
};

const responsesEvents = ({
  text,
  toolCalls,
  inputTokens,
  outputTokens,
}: Answer) => {
  const message = { type: "message", id: "msg_1", role: "assistant" };
  const items = [
    ...(text === ""
      ? []
      : [
          {
            added: { ...message, content: [] },
            deltas: [
              {
                type: "response.output_text.delta",
                content_index: 0,
                delta: text,
              },
            ],
            done: {
              ...message,
              content: [{ type: "output_text", text, annotations: [] }],
            },
          },
        ]),
    ...(toolCalls ?? []).map((call, index) => {
      const item = {
        type: "function_call",
        id: `fc_${index}`,
        call_id: call.id,
        name: call.name,
      };
      const args = JSON.stringify(call.arguments);
      return {
        added: { ...item, arguments: "" },
        deltas: [
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            delta: args,
          },
        ],
        done: { ...item, arguments: args },
      };
    }),
  ];
  return [
    {
      data: {
        type: "response.created",
        response: { id: "resp_1", status: "in_progress" },
      },
    },
    ...items.flatMap(({ added, deltas, done }, index) => [
      {
        data: {
          type: "response.output_item.added",
          output_index: index,
          item: added,
        },
      },
      ...deltas.map((delta) => ({ data: { ...delta, output_index: index } })),
      {
        data: {
          type: "response.output_item.done",
          output_index: index,
          item: done,
        },
      },
    ]),
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
    if ("hang" in reply) {
      const aborted = Promise.withResolvers<Response>();
      const stop = () => {
        aborted.reject(new Error("The request was aborted"));
      };
      // It may have been aborted while its body was read.
      if (request.signal.aborted) {
        stop();
      }
      request.signal.addEventListener("abort", stop);
      return await aborted.promise;
    }
    if ("status" in reply) {
      // As Anthropic words it; pi quotes OpenAI's inner `error` the same way.
      return Response.json(
        {
          type: "error",
          error: {
            type: reply.errorType ?? "api_error",
            message: "Refused by the fake gateway",
          },
        },
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
