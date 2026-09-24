/**
 * Screen hooks. Screens talk to their App's server over Cap'n Web and start,
 * list and follow the App's workflows; they never run anything on their own.
 */
export interface WorkflowHandle {
  start: (input: unknown) => Promise<string>;
  status: (runId: string) => Promise<string>;
  list: () => Promise<string[]>;
}
