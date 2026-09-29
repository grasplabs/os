/**
 * What client accounts used, read from Cloudflare's GraphQL Analytics API
 * with the deployer's token (it needs Account Analytics Read): their
 * Workers' requests, CPU time and errors, and their AI Gateway's spend.
 * One request reads several accounts, each under its own alias.
 *
 * Every Worker in a client's account is one the console deployed, so an
 * account's totals are the client's.
 */
import { z } from "zod";

import { clientGatewayId } from "../deploy/core-config.ts";
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

const accountSchema = z.object({
  month: sumsOf({ requests: z.number(), cpuTimeUs: z.number() }),
  day: sumsOf({ requests: z.number(), errors: z.number() }),
  ai: sumsOf({ cost: z.number() }),
});

/** The query for `count` accounts, `$a0` to `$a<count-1>`. */
const usageQuery = (count: number): string => {
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

/** `accountIds` in chunks of `size`. */
const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

/**
 * Each of `accountIds`' usage, by account id, as of `now`. An account the
 * API doesn't answer for (the token isn't a member, analytics not read)
 * is left out, for the grid to show as unknown; a request that fails
 * throws.
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
  const usage = new Map<string, AccountUsage>();
  for (const chunk of chunks(accountIds, accountsPerQuery)) {
    const variables = {
      ...Object.fromEntries(chunk.map((id, index) => [`a${index}`, id])),
      monthStart: monthStart.toISOString(),
      dayStart: dayStart.toISOString(),
      now: now.toISOString(),
      gateway: clientGatewayId,
    };
    // oxlint-disable-next-line no-await-in-loop -- a few accounts at a time
    const viewer = await api.graphql(
      usageQuery(chunk.length),
      variables,
      z.object({
        viewer: z.record(z.string(), z.array(accountSchema).nullable()),
      })
    );
    for (const [index, id] of chunk.entries()) {
      const [account] = viewer.viewer[`a${index}`] ?? [];
      if (account === undefined) {
        continue;
      }
      const month = total(account.month, { requests: 0, cpuTimeUs: 0 });
      const day = total(account.day, { requests: 0, errors: 0 });
      usage.set(id, {
        monthRequests: month.requests,
        monthCpuMs: month.cpuTimeUs / 1000,
        monthAiUsd: total(account.ai, { cost: 0 }).cost,
        dayRequests: day.requests,
        dayErrors: day.errors,
      });
    }
  }
  return usage;
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
 * includes, and its AI Gateway spend. Storage (D1, R2, Durable Objects)
 * isn't in it.
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
