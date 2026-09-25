/**
 * Structured logs for Workers Logs: one object per line, so every field is
 * searchable. Never log secrets, headers, prompts or bodies.
 */
type LogFields = Readonly<Record<string, string | number | undefined>>;

// Workers Logs collects what the Worker writes to the console.
export const log = {
  info: (event: string, fields: LogFields): void => {
    console.info({ event, ...fields });
  },
  warn: (event: string, fields: LogFields): void => {
    console.warn({ event, ...fields });
  },
  error: (event: string, fields: LogFields): void => {
    console.error({ event, ...fields });
  },
};

/** What to log about something that was thrown. */
export const errorFields = (error: unknown): LogFields =>
  error instanceof Error
    ? {
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack,
      }
    : { errorName: typeof error };
