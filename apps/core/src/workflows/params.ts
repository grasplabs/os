import { paramValueSchemas } from "@grasp-os/sdk/params";
import { approvalErrors } from "@grasp-os/shared/approvals";
import type { ParamValue } from "@grasp-os/shared/approvals";
import { actorOf } from "@grasp-os/shared/audit";
import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowParam } from "@grasp-os/shared/workflows";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { toApproval } from "../approvals.ts";
import { findApp, requireBuilder, versionFiles } from "../apps.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
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
// (R16): events name the parameter only. Builders see the values, which
// they set themselves: by design.
//
// Versions can disagree about which parameters are sensitive, and a
// builder can make any version current. So what a version reads goes by
// that version's own declarations (`paramValues`): for a parameter it
// declares sensitive, only a value an approval set counts, and an approved
// value is never overwritten without another approval, whatever a later
// version declares.
//
// Runs don't read these values yet: every run uses its code's defaults
// until the dispatcher passes them in, through `paramValues`.

/** The longest value kept, as JSON text. */
const maxValueLength = 4096;

type ValueRow = typeof workflowParamValues.$inferSelect;

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

/** The stored values of a workflow's parameters, as rows. */
const valueRows = async (
  env: Env,
  app: AppId,
  workflow: WorkflowId
): Promise<ValueRow[]> =>
  await drizzle(env.DB)
    .select()
    .from(workflowParamValues)
    .where(
      and(
        eq(workflowParamValues.appId, app),
        eq(workflowParamValues.workflowId, workflow)
      )
    );

/**
 * The stored value that counts for `param` as a version declares it: one
 * of its kind and, for a sensitive parameter, set by an approval.
 * Otherwise none, and the code's default applies.
 */
const valueFor = (
  param: DeclaredParam,
  row: ValueRow | undefined
): ParamValue | undefined => {
  if (!row || (param.sensitive && row.approvalId === null)) {
    return undefined;
  }
  const parsed = paramValueSchemas[param.kind].safeParse(row.value);
  return parsed.success ? parsed.data : undefined;
};

/**
 * The values that count for a workflow's parameters, as the version that
 * reads them declares them (`params`), by name; a parameter missing here
 * has its code's default. The one way values are read.
 */
export const paramValues = async (
  env: Env,
  app: AppId,
  workflow: WorkflowId,
  params: readonly DeclaredParam[]
): Promise<Map<string, ParamValue>> => {
  const rows = await valueRows(env, app, workflow);
  const values = new Map<string, ParamValue>();
  for (const param of params) {
    const value = valueFor(
      param,
      rows.find((row) => row.param === param.name)
    );
    if (value !== undefined) {
      values.set(param.name, value);
    }
  }
  return values;
};

/** The workflow's parameters with their values and pending changes. */
const paramsOf = async (
  env: Env,
  { app, workflow, params }: CurrentWorkflow
): Promise<WorkflowParam[]> => {
  const [values, pending] = await Promise.all([
    paramValues(env, app, workflow, params),
    drizzle(env.DB)
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
      value: values.get(param.name) ?? null,
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
const parseValue = (param: DeclaredParam, value: unknown): ParamValue => {
  const parsed = paramValueSchemas[param.kind].safeParse(value);
  if (!parsed.success || JSON.stringify(parsed.data).length > maxValueLength) {
    throw workflowErrors.create("workflow.param_invalid");
  }
  return parsed.data;
};

/** Asks for `param` to change to `value`, for someone else to approve. */
const requestChange = async (
  env: Env,
  by: Identity,
  current: CurrentWorkflow,
  param: DeclaredParam,
  value: ParamValue
): Promise<void> => {
  const values = await paramValues(env, current.app, current.workflow, [param]);
  const approval = crypto.randomUUID();
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(approvals).values({
        id: approval,
        kind: "param",
        permissionId: null,
        appId: current.app,
        workflowId: current.workflow,
        param: param.name,
        value,
        previous: values.get(param.name) ?? null,
        approvers: "builders",
        status: "pending",
        requestedBy: by.userId,
        requestedAt: new Date(),
        decidedBy: null,
        decidedAt: null,
        breakGlass: false,
        version: current.version,
        decision: null,
      }),
      outboxed(db, {
        actor: actorOf(by),
        action: "workflow.param.requested",
        target: { type: "app", id: current.app },
        detail: {
          workflow: current.workflow,
          param: param.name,
          approval,
          version: current.version,
        },
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw approvalErrors.create("approval.conflict");
    }
    throw error;
  }
};

/**
 * Sets a value that needs no approval, in one statement: only while the
 * App's current version is still the one read, and never over a value an
 * approval set. Otherwise `workflow.param_conflict`.
 */
const setDirectly = async (
  env: Env,
  by: Identity,
  current: CurrentWorkflow,
  param: DeclaredParam,
  value: ParamValue
): Promise<void> => {
  const db = drizzle(env.DB);
  const [set] = await auditedBatch(env, db, [
    db
      .insert(workflowParamValues)
      .select(
        sql`SELECT ${current.app}, ${current.workflow}, ${param.name},
            ${JSON.stringify(value)}, ${by.userId}, ${Date.now()}, NULL
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
        },
        setWhere: sql`${workflowParamValues.approvalId} IS NULL`,
      })
      .returning({ param: workflowParamValues.param }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "workflow.param.updated",
      target: { type: "app", id: current.app },
      detail: {
        workflow: current.workflow,
        param: param.name,
        version: current.version,
      },
    }),
  ]);
  if (set.length === 0) {
    throw workflowErrors.create("workflow.param_conflict");
  }
};

/**
 * Sets a parameter: at once, or, when the current version declares it
 * sensitive or an approval set its value, as a change that waits for
 * someone else's approval. Grasp staff set nothing.
 */
export const setParam = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  name: unknown,
  value: unknown
): Promise<WorkflowParam> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const current = await currentWorkflow(env, by, app, workflow);
  const param = current.params.find((declared) => declared.name === name);
  if (!param) {
    throw workflowErrors.create("workflow.param_not_found");
  }
  const parsed = parseValue(param, value);
  const rows = await valueRows(env, current.app, current.workflow);
  const approved = rows.some(
    (row) => row.param === param.name && row.approvalId !== null
  );
  // An approved value changes only through another approval.
  const change = param.sensitive || approved ? requestChange : setDirectly;
  await change(env, by, current, param, parsed);
  const params = await paramsOf(env, current);
  const updated = params.find((declared) => declared.name === param.name);
  if (!updated) {
    throw workflowErrors.create("workflow.param_not_found");
  }
  return updated;
};
