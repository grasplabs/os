import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Changes the platform lets nobody make alone (threat model R4, R8, WF5):
// granting an App or agent a permission, and changing a workflow's
// sensitive parameter. Each is a request that does nothing until someone
// other than the person who asked approves it; the approval and the change
// it approves happen together, once.

/** What an approval is for. */
export const approvalKindSchema = z.enum(["permission", "param"]);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

/**
 * Pending: waits for a decision. Approved: its change is made. Declined:
 * someone who may approve it said no. Withdrawn: the person who asked took
 * it back. Only a pending approval changes, once.
 */
export const approvalStatusSchema = z.enum([
  "pending",
  "approved",
  "declined",
  "withdrawn",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/**
 * Who may approve: admins (permission grants), or admins and builders
 * (sensitive values). Never the person who asked, and never Grasp staff.
 */
export const approversSchema = z.enum(["admins", "builders"]);
export type Approvers = z.infer<typeof approversSchema>;

/** A workflow parameter's value: a number, or text. */
export type ParamValue = string | number;

interface ApprovalFields {
  id: string;
  status: ApprovalStatus;
  approvers: Approvers;
  /** User IDs, and when (ISO 8601). */
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  /**
   * Approved by the person who asked, as the organization's only admin
   * (break-glass). Only ever for a permission.
   */
  breakGlass: boolean;
}

/** An approval, as the API returns it. */
export type Approval = ApprovalFields &
  (
    | {
        kind: "permission";
        /** The requested permission it grants (`permissions.list`). */
        permission: string;
      }
    | {
        kind: "param";
        app: string;
        workflow: string;
        param: string;
        /**
         * The App version it was asked against: approving it once another
         * version is current is refused.
         */
        version: number;
        /** The value when it was asked for; null while the default applied. */
        from: ParamValue | null;
        to: ParamValue;
      }
  );

/** How an approver decides. */
export const approveOptionsSchema = z.strictObject({
  /**
   * The only admin approves their own permission request. Refused while
   * any other admin exists, and audited as break-glass.
   */
  breakGlass: z.boolean().optional(),
});
export type ApproveOptions = z.input<typeof approveOptionsSchema>;

/**
 * A signed-in person's approvals, over `/rpc`. Every call checks the
 * session, the person's role and the approval again, on the server.
 */
export interface ApprovalsApi {
  /** Pending approvals, oldest first. Admins and builders. */
  list: () => Promise<Approval[]>;
  /** Approves, and so makes the change. Never the person who asked. */
  approve: (id: string, options?: ApproveOptions) => Promise<Approval>;
  /** Refuses the change. Anyone who may approve it. */
  decline: (id: string) => Promise<Approval>;
  /** Takes back one's own request. */
  withdraw: (id: string) => Promise<Approval>;
}

/** Why an approval call was refused. */
export const approvalErrors = defineErrorFamily({
  "approval.not_found": "There's no such approval.",
  "approval.invalid": "That isn't a valid way to decide an approval.",
  "approval.forbidden": "You may not decide this approval.",
  "approval.self": "Someone other than the person who asked must approve this.",
  "approval.break_glass_refused":
    "Another admin can approve this, so it can't be approved as break-glass.",
  "approval.closed": "This approval was already decided or withdrawn.",
  "approval.stale":
    "What this approval asks for no longer applies: the person who asked has left or lost the role to ask, what it changes is gone, or the App version it was asked against is no longer current.",
  "approval.conflict":
    "A change of this value is already waiting for approval.",
});
