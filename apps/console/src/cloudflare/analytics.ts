/**
 * What client accounts used, read from Cloudflare's GraphQL Analytics API
 * with the deployer's token (it needs Account Analytics Read): their
 * Workers' requests, CPU time and errors, and their AI Gateway's spend.
 * One request reads several accounts, each under its own alias.
 *
 * Every Worker in a client's account is one the console deployed, so an
 * account's totals are the client's.
 */
import { log } from "@grasp-os/shared/log";
import { z } from "zod";

import { clientGatewayId } from "../deploy/core-config.ts";
import { errorCode } from "../deploy/deploy.ts";
import type { CloudflareApi } from "./api.ts";

/** A client account's usage, as the grid shows it. */
export interface AccountUsage {
  /** Worker requests since the month started (UTC). */
  monthRequests: number;
  /** Worker CPU time since the month started, in milliseconds. */
  monthCpuMs: number;
  /** AI Gateway spend since the month started, in USD, as the gateway estimates it. */
  monthAiUsd: number;
  /** Worker requests over the last 24 hours. */
  dayRequests: number;
  /** Of those, the ones that ended in an error. */
  dayErrors: number;
}

/** Accounts one request reads: each is a few datasets of its own. */
const accountsPerQuery = 10;

const sumsOf = <T extends z.ZodRawShape>(shape: T) =>
  z.array(z.object({ sum: z.object(shape) }));

/** One account's answer, as its alias holds it. */
const accountSchema = z.array(
  z.object({
    month: sumsOf({ requests: z.number(), cpuTimeUs: z.number() }),
    day: sumsOf({ requests: z.number(), errors: z.number() }),
    ai: sumsOf({ cost: z.number() }),
  })
);

/**
 * The query for `count` accounts, `$a0` to `$a<count-1>`: the month's
 * Workers requests and CPU time, the last day's requests and errors, and
 * the month's spend on the client's AI Gateway.
 */
export const usageQuery = (count: number): string => {
  const aliases = Array.from(
    { length: count },
    (_, index) => `a${index}: accounts(filter: { accountTag: $a${index} }) {
    month: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $monthStart, datetime_leq: $now }) { sum { requests cpuTimeUs } }
    day: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $dayStart, datetime_leq: $now }) { sum { requests errors } }
    ai: aiGatewayRequestsAdaptiveGroups(limit: 1, filter: { datetime_geq: $monthStart, datetime_leq: $now, gateway: $gateway }) { sum { cost } }
  }`
  );
  const tags = Array.from(
    { length: count },
    (_, index) => `$a${index}: string!`
  );
  return `query Usage(${tags.join(", ")}, $monthStart: Time!, $dayStart: Time!, $now: Time!, $gateway: string!) {
  viewer {
  ${aliases.join("\n  ")}
  }
}`;
};

/** The first group's sums, or zeros when the window had none. */
const total = <T extends Record<string, number>>(
  groups: readonly { sum: T }[],
  zero: T
): T => groups[0]?.sum ?? zero;

/** `items` in chunks of `size`. */
const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

/** The usage an account's answer says, or undefined when it doesn't say one. */
const usageOf = (answer: unknown): AccountUsage | undefined => {
  const parsed = accountSchema.safeParse(answer);
  const [account] = parsed.success ? parsed.data : [];
  if (account === undefined) {
    return undefined;
  }
  const month = total(account.month, { requests: 0, cpuTimeUs: 0 });
  const day = total(account.day, { requests: 0, errors: 0 });
  return {
    monthRequests: month.requests,
    monthCpuMs: month.cpuTimeUs / 1000,
    monthAiUsd: total(account.ai, { cost: 0 }).cost,
    dayRequests: day.requests,
    dayErrors: day.errors,
  };
};

/**
 * Each of `accountIds`' usage, by account id, as of `now`. Never throws:
 * an account the API doesn't answer for (the token isn't a member, its
 * answer doesn't parse), or one in a request that failed, is left out,
 * for the grid to show as unknown, and the other accounts stand.
 */
export const accountUsage = async (
  api: CloudflareApi,
  accountIds: readonly string[],
  now: Date
): Promise<Map<string, AccountUsage>> => {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const answers = await Promise.all(
    chunks(accountIds, accountsPerQuery).map(async (chunk) => {
      const variables = {
        ...Object.fromEntries(chunk.map((id, index) => [`a${index}`, id])),
        monthStart: monthStart.toISOString(),
        dayStart: dayStart.toISOString(),
        now: now.toISOString(),
        gateway: clientGatewayId,
      };
      try {
        const { viewer } = await api.graphql(
          usageQuery(chunk.length),
          variables,
          z.object({ viewer: z.record(z.string(), z.unknown()) })
        );
        return chunk.map((id, index): [string, AccountUsage | undefined] => [
          id,
          usageOf(viewer[`a${index}`]),
        ]);
      } catch (error) {
        log.warn("analytics.unread", {
          accounts: chunk.length,
          error: errorCode(error),
        });
        return [];
      }
    })
  );
  return new Map(
    answers
      .flat()
      .flatMap(([id, usage]): [string, AccountUsage][] =>
        usage === undefined ? [] : [[id, usage]]
      )
  );
};

/**
 * Workers Paid's price, in USD: a monthly base, with requests and CPU time
 * past what it includes billed per million
 * (https://developers.cloudflare.com/workers/platform/pricing/).
 */
const workersPaid = {
  baseUsd: 5,
  includedRequests: 10_000_000,
  usdPerMillionRequests: 0.3,
  includedCpuMs: 30_000_000,
  usdPerMillionCpuMs: 0.02,
} as const;

/**
 * What `usage` costs this month so far, in USD, estimated: the account's
 * Workers Paid base and its requests and CPU time past what that
 * includes, counted from the calendar month's start (its included usage
 * resets on its billing cycle, which may start on another day), and its
 * AI Gateway spend. Storage (D1, R2) and Durable Objects aren't in it.
 */
export const monthCostUsd = (
  usage: AccountUsage
): { workers: number; ai: number } => {
  const overRequests = Math.max(
    0,
    usage.monthRequests - workersPaid.includedRequests
  );
  const overCpuMs = Math.max(0, usage.monthCpuMs - workersPaid.includedCpuMs);
  return {
    workers:
      workersPaid.baseUsd +
      (overRequests / 1_000_000) * workersPaid.usdPerMillionRequests +
      (overCpuMs / 1_000_000) * workersPaid.usdPerMillionCpuMs,
    ai: usage.monthAiUsd,
  };
};
