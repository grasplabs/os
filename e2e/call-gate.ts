import type { Page } from "@playwright/test";

type Message = string | Buffer;

/** A page's connection to core, through Playwright. */
interface Connection {
  forward: (message: Message) => void;
  queue: Message[];
}

/**
 * Holds back the page's calls to core that name `call` (as Cap'n Web
 * writes a method's path, such as `["members","list"]`), from `hold` until
 * `release`: the message making the call, and everything after it on that
 * connection, which may build on it.
 */
export const callGate = async (page: Page, call: string) => {
  let holding = false;
  /** The connections held back, each with what it sent since. */
  const stalled: Connection[] = [];
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer();
    const queue: Message[] = [];
    const connection: Connection = {
      forward: (message) => {
        server.send(message);
      },
      queue,
    };
    socket.onMessage((message) => {
      const makesCall = String(message).includes(call);
      if (holding && makesCall && !stalled.includes(connection)) {
        stalled.push(connection);
      }
      if (stalled.includes(connection)) {
        connection.queue.push(message);
      } else {
        connection.forward(message);
      }
    });
  });
  return {
    hold: () => {
      holding = true;
    },
    stalled: () => stalled.length,
    release: () => {
      holding = false;
      for (const connection of stalled.splice(0)) {
        for (const message of connection.queue.splice(0)) {
          connection.forward(message);
        }
      }
    },
  };
};
