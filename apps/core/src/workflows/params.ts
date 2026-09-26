import { paramValueSchemas } from "@grasp-os/sdk/params";
import { approvalErrors } from "@grasp-os/shared/approvals";
import type { ParamValue } from "@grasp-os/shared/approvals";
import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowParam } from "@grasp-os/shared/workflows";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { toApproval } from "../approvals.ts";
import { findApp, requireBuilder, versionFiles } from "../apps.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import { actorOf } from "../audit.ts";
import { apps, approvals, workflowParamValues } from "../db/core/schema.ts";
import { isUniqueViolation } from "../db/d1.ts";
import { declaredParams, hasWorkflow } from "./code.ts";
import type { DeclaredParam } from "./code.ts";

// The values people set for a workflow's parameters, over the defaults in
// its code. Which parameters there are, of what kind, and which are
// sensitive, is what the workflow's code in its App's current version
// declares. A value that isn't sensitive is set at once; a sensitive one
// becomes a pending change that someone other than its requester approves
// (approvals.ts), and the approval sets it. Values are validated as the
// SDK validates them when a run reads them, and kept out of the audit log
// (R16): events name the parameter only.
//
// Runs don't read these values yet: every run uses its code's defaults
// until the dispatcher passes them in.

/** The longest value kept, as JSON text. */
const maxValueLength = 4096;

/** A workflow of an App's current version, with what its code declares. */
interface CurrentWorkflow {
  app: AppId;
  workflow: WorkflowId;
  version: number;
  params: DeclaredParam[];
}

/** The workflow `workflow` of App `app`'s current version, for `by`. */
const currentWorkflow = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown
): Promise<CurrentWorkflow> => {
  requireBuilder(by);
  const found = await findApp(env, app);
  const workflowId = workflowErrors.parse(
    "workflow.invalid",
    workflowIdSchema,
    workflow
  );
  const version = found.currentVersion;
  if (version === null) {
    throw workflowErrors.create("workflow.not_found");
  }
  const files = await versionFiles(env, found.id, version);
  if (!hasWorkflow(files, workflowId)) {
    throw workflowErrors.create("workflow.not_found");
  }
  return {
    app: found.id,
    workflow: workflowId,
    version,
    params: await declaredParams(env, found.id, version, workflowId, files),
  };
};

/** The workflow's parameters with their values and pending changes. */
const paramsOf = async (
  env: Env,
  { app, workflow, params }: CurrentWorkflow
): Promise<WorkflowParam[]> => {
  const db = drizzle(env.DB);
  const [values, pending] = await Promise.all([
    db
      .select()
      .from(workflowParamValues)
      .where(
        and(
          eq(workflowParamValues.appId, app),
          eq(workflowParamValues.workflowId, workflow)
        )
      ),
    db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.kind, "param"),
          eq(approvals.appId, app),
          eq(approvals.workflowId, workflow),
          eq(approvals.status, "pending")
        )
      ),
  ]);
  return params.map((param) => {
    const change = pending.find((row) => row.param === param.name);
    return {
      ...param,
      value: values.find((row) => row.param === param.name)?.value ?? null,
      pending: change ? toApproval(change) : null,
    };
  });
};

/** A workflow's parameters, as its App's current version declares them. */
export const listParams = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown
): Promise<WorkflowParam[]> =>
  await paramsOf(env, await currentWorkflow(env, by, app, workflow));

/** `value` as parameter `param` holds it, or `workflow.param_invalid`. */
const valueFor = (param: DeclaredParam, value: unknown): ParamValue => {
  const parsed = paramValueSchemas[param.kind].safeParse(value);
  if (!parsed.success || JSON.stringify(parsed.data).length > maxValueLength) {
    throw workflowErrors.create("workflow.param_invalid");
  }
  return parsed.data;
};

/**
 * Sets a parameter: at once, while the App's current version is still the
 * one that declares it not sensitive, or, for a sensitive one, as a change
 * that waits for someone else's approval.
 */
export const setParam = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  name: unknown,
  value: unknown
): Promise<WorkflowParam> => {
  const current = await currentWorkflow(env, by, app, workflow);
  const param = current.params.find((declared) => declared.name === name);
  if (!param) {
    throw workflowErrors.create("workflow.param_not_found");
  }
  const parsed = valueFor(param, value);
  const detail = { workflow: current.workflow, param: param.name };
  const db = drizzle(env.DB);
  if (param.sensitive) {
    const previous = await db
      .select({ value: workflowParamValues.value })
      .from(workflowParamValues)
      .where(
        and(
          eq(workflowParamValues.appId, current.app),
          eq(workflowParamValues.workflowId, current.workflow),
          eq(workflowParamValues.param, param.name)
        )
      )
      .get();
    const approval = crypto.randomUUID();
    try {
      await auditedBatch(env, db, [
        db.insert(approvals).values({
          id: approval,
          kind: "param",
          permissionId: null,
          appId: current.app,
          workflowId: current.workflow,
          param: param.name,
          value: parsed,
          previous: previous?.value ?? null,
          approvers: "builders",
          status: "pending",
          requestedBy: by.userId,
          requestedAt: new Date(),
          decidedBy: null,
          decidedAt: null,
          breakGlass: false,
        }),
        outboxed(db, {
          actor: actorOf(by),
          action: "workflow.param.requested",
          target: { type: "app", id: current.app },
          detail: { ...detail, approval },
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw approvalErrors.create("approval.conflict");
      }
      throw error;
    }
  } else {
    const [set] = await auditedBatch(env, db, [
      db
        .insert(workflowParamValues)
        .select(
          sql`SELECT ${current.app}, ${current.workflow}, ${param.name},
              ${JSON.stringify(parsed)}, ${by.userId}, ${Date.now()}, NULL
            WHERE EXISTS (
              SELECT 1 FROM ${apps}
              WHERE ${apps.id} = ${current.app}
                AND ${apps.currentVersion} = ${current.version}
            )`
        )
        .onConflictDoUpdate({
          target: [
            workflowParamValues.appId,
            workflowParamValues.workflowId,
            workflowParamValues.param,
          ],
          set: {
            value: sql`excluded.value`,
            setBy: sql`excluded.set_by`,
            setAt: sql`excluded.set_at`,
            approvalId: sql`excluded.approval_id`,
          },
        })
        .returning({ param: workflowParamValues.param }),
      outboxedIfChanged(db, {
        actor: actorOf(by),
        action: "workflow.param.updated",
        target: { type: "app", id: current.app },
        detail,
      }),
    ]);
    // The current version changed since it said the value isn't sensitive.
    if (set.length === 0) {
      throw workflowErrors.create("workflow.param_conflict");
    }
  }
  const params = await paramsOf(env, current);
  const updated = params.find((declared) => declared.name === param.name);
  if (!updated) {
    throw workflowErrors.create("workflow.param_not_found");
  }
  return updated;
};
