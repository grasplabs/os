import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectResult } from "@grasp-os/shared/connect";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { PermissionSubject } from "@grasp-os/shared/permissions";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { idempotentCalls } from "./db/schema.ts";

// Side effects happen once per idempotency key. The first call claims the
// key before it calls out; its answer (a result, or the tool's error) is
// stored under the key, and a repeat gets that answer without calling out
// again. A call that fails after it may have reached the server spends the
// key: nobody can tell whether the effect happened, so a repeat is refused
// rather than risk doing it twice. Only a server that turned the call away
// frees the key again.

/**
 * How long a claim holds before connect stops waiting for its call: well
 * past the longest an MCP request may take. A claim older than this was
 * left by a call that died mid-way, so its outcome is unknown.
 */
const claimTimeoutMs = 5 * 60 * 1000;

/**
 * How long stored answers are kept. A workflow retries a step within this;
 * after it, the key is free again. Spent keys are kept for good.
 */
const retentionMs = 30 * 24 * 60 * 60 * 1000;

/** Whose key it is, and for which call: never the key alone. */
export interface IdempotencyScope {
  subject: PermissionSubject;
  onBehalfOf: string;
  connectionId: string;
  action: string;
  idempotencyKey: string;
}

type Row = typeof idempotentCalls.$inferSelect;

/** An earlier call's answer: its result, or the tool's error. */
export interface StoredAnswer {
  result: ConnectResult;
  /** The tool reported an error; `result` holds what it said. */
  failed: boolean;
}

const provenanceSchema = z.array(z.string());

const subjectColumns = (subject: PermissionSubject) =>
  subject.type === "app"
    ? { subjectType: subject.type, subjectId: subject.appId }
    : { subjectType: subject.type, subjectId: subject.agentId };

const keyOf = (scope: IdempotencyScope) => {
  const { subjectType, subjectId } = subjectColumns(scope.subject);
  return and(
    eq(idempotentCalls.subjectType, subjectType),
    eq(idempotentCalls.subjectId, subjectId),
    eq(idempotentCalls.onBehalfOf, scope.onBehalfOf),
    eq(idempotentCalls.connectionId, scope.connectionId),
    eq(idempotentCalls.action, scope.action),
    eq(idempotentCalls.idempotencyKey, scope.idempotencyKey)
  );
};

/** SHA-256 over the call's resource and input, in canonical JSON. */
export const hashCall = async (
  resource: string | null,
  input: Json
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson({ resource, input }))
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

/** What a stored row means for a repeat of the call: its answer, or why not. */
const replay = (row: Row, inputHash: string, now: number): StoredAnswer => {
  if (row.inputHash !== inputHash) {
    throw connectErrors.create("connect.idempotency_conflict");
  }
  const answered = row.state === "done" || row.state === "failed";
  if (answered && row.output !== null) {
    return {
      result: {
        output: row.output,
        provenance: provenanceSchema.parse(JSON.parse(row.provenance ?? "[]")),
      },
      failed: row.state === "failed",
    };
  }
  if (
    row.state === "running" &&
    now - row.createdAt.getTime() < claimTimeoutMs
  ) {
    throw connectErrors.create("connect.call_in_progress");
  }
  throw connectErrors.create("connect.outcome_unknown");
};

/** The idempotency store for one key: see the module comment. */
export const idempotencyStore = (
  database: D1Database,
  scope: IdempotencyScope,
  inputHash: string
) => {
  const db = drizzle(database);
  const key = keyOf(scope);

  const find = async (): Promise<Row | undefined> =>
    await db.select().from(idempotentCalls).where(key).get();

  return {
    /** The stored answer of an earlier call with this key, if there was one. */
    replay: async (): Promise<StoredAnswer | undefined> => {
      const row = await find();
      return row === undefined ? undefined : replay(row, inputHash, Date.now());
    },

    /**
     * Claims the key for a call about to go out: undefined once claimed. If
     * another call claimed it first, answers as a repeat of that call.
     */
    claim: async (): Promise<StoredAnswer | undefined> => {
      const now = Date.now();
      const [, claimed] = await db.batch([
        // Expired answers make room; the index on created_at keeps it
        // cheap. Spent keys stay: their effect may have happened.
        db
          .delete(idempotentCalls)
          .where(
            and(
              lt(idempotentCalls.createdAt, new Date(now - retentionMs)),
              inArray(idempotentCalls.state, ["done", "failed"])
            )
          ),
        db
          .insert(idempotentCalls)
          .values({
            ...subjectColumns(scope.subject),
            onBehalfOf: scope.onBehalfOf,
            connectionId: scope.connectionId,
            action: scope.action,
            idempotencyKey: scope.idempotencyKey,
            inputHash,
            state: "running",
            createdAt: new Date(now),
          })
          .onConflictDoNothing()
          .returning({ state: idempotentCalls.state }),
      ]);
      if (claimed.length > 0) {
        return undefined;
      }
      const row = await find();
      if (row === undefined) {
        // Claimed and released again in between: that call did nothing.
        throw connectErrors.create("connect.call_in_progress");
      }
      return replay(row, inputHash, now);
    },

    /**
     * The statement that stores the answer of the call this key was claimed
     * for, to run in one batch with the call's audit events.
     */
    completion: ({ result, failed }: StoredAnswer): BatchItem<"sqlite"> =>
      db
        .update(idempotentCalls)
        .set({
          state: failed ? "failed" : "done",
          output: result.output,
          provenance: JSON.stringify(result.provenance),
        })
        .where(and(key, eq(idempotentCalls.state, "running"))),

    /** Frees the key: the call is known not to have had its effect. */
    release: async (): Promise<void> => {
      await db
        .delete(idempotentCalls)
        .where(and(key, eq(idempotentCalls.state, "running")));
    },

    /** Spends the key: the call may or may not have had its effect. */
    spend: async (): Promise<void> => {
      await db
        .update(idempotentCalls)
        .set({ state: "unknown" })
        .where(and(key, eq(idempotentCalls.state, "running")));
    },
  };
};
