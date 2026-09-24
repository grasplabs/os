import { createDynamicWorkflowEntrypoint } from "@cloudflare/dynamic-workflows";

export { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";

/**
 * The one dispatcher Workflow. Loads a run's workflow code by commit and
 * rebuilds its env from permission records on every resume.
 */
export const WorkflowDispatcher = createDynamicWorkflowEntrypoint<Env>(() => {
  throw new Error("Workflow dispatch is not implemented yet");
});
