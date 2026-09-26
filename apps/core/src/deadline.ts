/** Why work was stopped: it took too long, or its caller cancelled it. */
export type Stopped = "timeout" | "cancelled";

/** A deadline for one piece of work, as {@link deadline} makes it. */
export interface Deadline {
  /** Aborts when the time is up or the caller cancels. */
  signal: AbortSignal;
  /** Why the work was stopped, if it was. */
  stopped: () => Stopped | undefined;
  /** Ends the deadline: call it when the work ends, however it ends. */
  clear: () => void;
}

/**
 * Ends work after `ms`, or when its caller cancels it. Its timer is cleared
 * when the work ends, so none outlives it to keep a Durable Object awake
 * (`AbortSignal.timeout` can't be cleared).
 */
export const deadline = (ms: number, caller?: AbortSignal): Deadline => {
  const timer = new AbortController();
  const handle = setTimeout(() => {
    timer.abort();
  }, ms);
  return {
    signal:
      caller === undefined
        ? timer.signal
        : AbortSignal.any([caller, timer.signal]),
    stopped: () => {
      if (caller?.aborted === true) {
        return "cancelled";
      }
      return timer.signal.aborted ? "timeout" : undefined;
    },
    clear: () => {
      clearTimeout(handle);
    },
  };
};
