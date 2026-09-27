/**
 * Mail connections in connect's registry for core's tests: each a Composio
 * toolkit's, to a mail server of its own (test/mail-server.ts). Its admin
 * allowed `mail.send`, a side effect, and may allow `mail.search` too.
 */
import { z } from "zod";

import { mailControlUrl, mailServerUrl } from "./mail-server.ts";
import type { MailAnswer } from "./mail-server.ts";
import { connectDb, testBinding } from "./test-env.ts";

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The outside systems connect reaches (test/connect-providers.ts). */
const providers = (): Fetcher => {
  const fetcher = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(fetcher)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return fetcher;
};

const mailServerStateSchema = z.object({
  calls: z.number(),
  sent: z.array(z.object({ to: z.string(), subject: z.string() })),
});

/** `mail.send`, and `mail.search` marked as a read, as an admin allows them. */
export const mailWithSearch = [
  "mail.send",
  { name: "mail.search", read: true },
];

/**
 * A shared mail connection in connect's registry, as a Composio toolkit's,
 * allowing `tools`, to a mail server of its own that answers its next
 * calls as `plan` says (then sends mail), and tells what it did.
 */
export const mailConnection = async (
  plan: MailAnswer[] = [],
  tools: unknown[] = ["mail.send"]
) => {
  const name = `mail-${crypto.randomUUID()}`;
  const id = `connection-${name}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, status, server_kind, server, tools, created_at, updated_at) VALUES (?, 'mail', 'shared', 'active', 'composio', ?, ?, ?, ?)"
    )
    .bind(id, mailServerUrl(name), JSON.stringify(tools), now, now)
    .run();
  await providers().fetch(mailControlUrl(name), {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
  return {
    id,
    /** Whether the server holds a `slow` call now. */
    holding: async () => {
      const response = await providers().fetch(mailControlUrl(name));
      return z.object({ holding: z.boolean() }).parse(await response.json())
        .holding;
    },
    /** Lets a held `slow` call go through. */
    release: async () => {
      await providers().fetch(mailControlUrl(name), {
        method: "POST",
        body: JSON.stringify({ release: true }),
      });
    },
    /** What the mail server did: calls that reached `mail.send`, mail sent. */
    did: async () => {
      const response = await providers().fetch(mailControlUrl(name));
      return mailServerStateSchema.parse(await response.json());
    },
    /** The queries `mail.search` ran for, in order. */
    searched: async () => {
      const response = await providers().fetch(mailControlUrl(name));
      return z
        .object({ searched: z.array(z.string()) })
        .parse(await response.json()).searched;
    },
  };
};
