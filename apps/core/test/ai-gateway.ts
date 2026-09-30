/**
 * A stand-in for AI Gateway behind the AI binding: it answers each request
 * with the next scripted reply, in the wire format of the provider route the
 * request went to, and keeps every request it got.
 */
import { z } from "zod";

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
      /**
       * Streams the text's first `at` characters, then waits for `until`
       * before the rest (Anthropic and chat completions): an answer caught
       * mid-stream.
       */
      pause?: { at: number; until: Promise<unknown> };
      /**
       * Streams the text's first `cut` characters, then closes the stream
       * with nothing after them, neither an end nor a count (Anthropic and
       * chat completions): an answer that breaks off.
       */
      cut?: number;
    }
  | {
      status: number;
      errorType?: string;
      /** The refusal's body, when not the provider's usual error. */
      body?: unknown;
    }
  | { hang: true };

export interface GatewayRequest {
  url: string;
  headers: Headers;
  body: unknown;
}

const encoder = new TextEncoder();

/** One server-sent event, with its SSE event name. */
interface StreamEvent {
  event?: string;
  data: unknown;
}

/** Where a stream stops until the promise settles (`pause`). */
interface StreamPause {
  until: Promise<unknown>;
}

const sse = ({ event, data }: StreamEvent): Uint8Array =>
  encoder.encode(
    [
      ...(event === undefined ? [] : [`event: ${event}`]),
      `data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
      "",
      "",
    ].join("\n")
  );

/**
 * A server-sent event stream of `events`, stopping at each pause until it
 * settles. Aborting the request (`signal`) breaks the stream off, as it
 * does a real response's body.
 */
const eventStream = (
  events: readonly (StreamEvent | StreamPause)[],
  logId: string,
  signal: AbortSignal
): Response => {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const stop = async (): Promise<void> => {
    try {
      await writer.abort(new Error("The request was aborted"));
    } catch {
      // Already closed: the answer was whole.
    }
  };
  signal.addEventListener("abort", () => {
    void stop();
  });
  const write = async (): Promise<void> => {
    try {
      for (const item of events) {
        // oxlint-disable-next-line no-await-in-loop -- in order, pausing where told
        await ("until" in item ? item.until : writer.write(sse(item)));
      }
      await writer.close();
    } catch {
      // The request was aborted: nobody reads the rest.
    }
  };
  void write();
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cf-aig-log-id": logId,
    },
  });
};

/** A scripted answer, as opposed to a refusal or a hang. */
export type Answer = Extract<GatewayReply, { text: string }>;

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

/** A text block's deltas: the text, or its two parts either side of a pause. */
const textDeltas = (
  index: number,
  text: string,
  pause: Answer["pause"]
): (StreamEvent | StreamPause)[] => {
  const delta = (part: string): StreamEvent => ({
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: part },
    },
  });
  return pause === undefined
    ? [delta(text)]
    : [
        delta(text.slice(0, pause.at)),
        { until: pause.until },
        delta(text.slice(pause.at)),
      ];
};

const anthropicEvents = (answer: Answer): (StreamEvent | StreamPause)[] => {
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
      ...(block.type === "text"
        ? textDeltas(index, block.text, answer.pause)
        : [
            {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.arguments),
                },
              },
            },
          ]),
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

const chatCompletionEvents = (
  answer: Answer
): (StreamEvent | StreamPause)[] => {
  const { text, inputTokens, outputTokens, pause } = answer;
  const content = (part: string): StreamEvent =>
    chunk({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: part },
          finish_reason: null,
        },
      ],
    });
  return [
    ...(pause === undefined
      ? [content(text)]
      : [
          content(text.slice(0, pause.at)),
          { until: pause.until },
          content(text.slice(pause.at)),
        ]),
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
const providerStream = (
  { url, signal }: Request,
  answer: Answer,
  logId: string
): Response => {
  const { pathname } = new URL(url);
  const { cut } = answer;
  // An answer that breaks off: only the events up to its first text.
  const begun = { ...answer, text: answer.text.slice(0, cut), toolCalls: [] };
  if (pathname.endsWith("/v1/messages")) {
    return eventStream(
      cut === undefined
        ? anthropicEvents(answer)
        : anthropicEvents(begun).slice(0, 3),
      logId,
      signal
    );
  }
  if (pathname.endsWith("/chat/completions")) {
    return eventStream(
      cut === undefined
        ? chatCompletionEvents(answer)
        : chatCompletionEvents(begun).slice(0, 1),
      logId,
      signal
    );
  }
  if (pathname.endsWith("/responses")) {
    return eventStream(responsesEvents(answer), logId, signal);
  }
  return new Response("No such route", { status: 404 });
};

const messagesSchema = z.object({
  messages: z.array(z.object({ content: z.unknown() })),
});

/**
 * Workers AI's refusal of a request its model's input schema doesn't take,
 * in its own words: a message without content, such as the `null` of an
 * assistant message that only calls tools, which OpenAI's API takes.
 * Its body has no `error`, so OpenAI's SDK drops it ("400 status code (no
 * body)"). `undefined` for a request Workers AI takes.
 */
const workersAiBadInput = (
  url: string,
  body: unknown
): Response | undefined => {
  if (!new URL(url).pathname.includes("/workers-ai/")) {
    return undefined;
  }
  const messages = messagesSchema.safeParse(body).data?.messages ?? [];
  const index = messages.findIndex(
    ({ content }) => typeof content !== "string" && !Array.isArray(content)
  );
  if (index === -1) {
    return undefined;
  }
  const problem = `Type mismatch of '/messages/${index}/content', 'string' not in 'null'`;
  return Response.json(
    {
      name: "AiError",
      internalCode: 5006,
      httpCode: 400,
      message: `AiError: Bad input: Error: ${problem}`,
      description: `Error: ${problem}`,
    },
    { status: 400 }
  );
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
    const body: unknown = await request.json();
    requests.push({ url: request.url, headers: request.headers, body });
    const badInput = workersAiBadInput(request.url, body);
    if (badInput !== undefined) {
      return badInput;
    }
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
        reply.body ?? {
          type: "error",
          error: {
            type: reply.errorType ?? "api_error",
            message: "Refused by the fake gateway",
          },
        },
        { status: reply.status }
      );
    }
    return providerStream(request, reply, `log-${requests.length}`);
  };
  return { binding: { aiGatewayLogId: null, fetch }, requests };
};
