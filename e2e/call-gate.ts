import type { Page, WebSocketRoute } from "@playwright/test";

type Message = string | Buffer;

/** A page's connection to core, through Playwright. */
interface Connection {
  page: WebSocketRoute;
  /** The calls held back, as Cap'n Web numbers them on this connection. */
  held: Set<number>;
  /** Core's answers to them, until they're let through. */
  answers: Message[];
}

/**
 * The messages that make a call, which Cap'n Web numbers in the order
 * they're sent on a connection, from 1: core answers each by its number.
 */
const makesCall = /^\["(?:push|stream)",/u;

/** The number of the call `message` answers, if it's an answer of core's. */
const answered = (message: Message): number | undefined => {
  const parsed: unknown = JSON.parse(String(message));
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const fields: unknown[] = parsed;
  const [kind, id] = fields;
  const answers = kind === "resolve" || kind === "reject";
  return answers && typeof id === "number" ? id : undefined;
};

/**
 * Holds back core's answers to the page's calls that name `call` (as Cap'n
 * Web writes a method's path, such as `["members","list"]`), from `hold`
 * until `release`. The calls themselves reach core, and everything else on
 * the connection goes on: the page has one connection for all it asks.
 */
export const callGate = async (page: Page, call: string) => {
  let holding = false;
  let stalled = 0;
  const connections: Connection[] = [];
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer();
    const connection: Connection = {
      page: socket,
      held: new Set(),
      answers: [],
    };
    connections.push(connection);
    let calls = 0;
    socket.onMessage((message) => {
      const text = String(message);
      if (makesCall.test(text)) {
        calls += 1;
        if (holding && text.includes(call)) {
          connection.held.add(calls);
          stalled += 1;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const id = answered(message);
      if (id !== undefined && connection.held.has(id)) {
        connection.answers.push(message);
      } else {
        socket.send(message);
      }
    });
  });
  return {
    hold: () => {
      holding = true;
    },
    /** How many calls have been held back so far. */
    stalled: () => stalled,
    release: () => {
      holding = false;
      for (const connection of connections) {
        connection.held.clear();
        for (const answer of connection.answers.splice(0)) {
          connection.page.send(answer);
        }
      }
    },
  };
};
