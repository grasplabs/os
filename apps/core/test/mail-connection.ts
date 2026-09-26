/**
 * Mail connections in connect's registry for core's tests: each a Composio
 * toolkit's, to a mail server of its own (test/mail-server.ts) whose one
 * tool, `mail.send`, is a side effect.
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

/**
 * A shared mail connection in connect's registry, as a Composio toolkit's,
 * to a mail server of its own that answers its next calls as `plan` says
 * (then sends mail), and tells what it did.
 */
export const mailConnection = async (plan: MailAnswer[] = []) => {
  const name = `mail-${crypto.randomUUID()}`;
  const id = `connection-${name}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, status, server_kind, server, created_at, updated_at) VALUES (?, 'mail', 'shared', 'active', 'composio', ?, ?, ?)"
    )
    .bind(id, mailServerUrl(name), now, now)
    .run();
  await providers().fetch(mailControlUrl(name), {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
  return {
    id,
    /** What the mail server did: calls that reached its tool, mail sent. */
    did: async () => {
      const response = await providers().fetch(mailControlUrl(name));
      return mailServerStateSchema.parse(await response.json());
    },
  };
};
