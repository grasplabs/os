import { paramValueSchemas } from "@grasp-os/sdk/params";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import type { ParamValue } from "@grasp-os/shared/workflows";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { workflowParamValues } from "../db/core/schema.ts";
import type { DeclaredParam } from "./code.ts";

// How the values people set for a workflow's parameters are read
// (params.ts sets them): as the version that reads them declares them.

export type ValueRow = typeof workflowParamValues.$inferSelect;

/** The stored values of a workflow's parameters, as rows. */
export const valueRows = async (
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
 * of its kind. Otherwise none, and the code's default applies.
 */
const valueFor = (
  param: DeclaredParam,
  row: ValueRow | undefined
): ParamValue | undefined => {
  if (!row) {
    return undefined;
  }
  const parsed = paramValueSchemas[param.kind].safeParse(row.value);
  return parsed.success ? parsed.data : undefined;
};

/** `paramValues`, of rows already read (`valueRows`). */
export const valuesOf = (
  params: readonly DeclaredParam[],
  rows: readonly ValueRow[]
): Map<string, ParamValue> => {
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
): Promise<Map<string, ParamValue>> =>
  valuesOf(params, await valueRows(env, app, workflow));
