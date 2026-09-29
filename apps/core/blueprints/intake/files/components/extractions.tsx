import type { ScreenRun } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";

/** What a reading of notes is doing, in words. */
const statusOf = (run: ScreenRun | undefined): string => {
  if (run === undefined) {
    return "Starting";
  }
  switch (run.status) {
    case "completed": {
      return "Ready to review";
    }
    case "failed": {
      return `Failed: ${run.failure?.error.message ?? "the model couldn't read the notes"}`;
    }
    case "cancelled": {
      return "Cancelled";
    }
    case "running":
    case "waiting":
    case "paused": {
      return "Reading the notes";
    }
    default: {
      return run.status satisfies never;
    }
  }
};

/**
 * The notes this screen sent to be read, newest first, each as its run
 * says it is doing: reading, failed, or ready to review as a draft.
 */
export const Extractions = ({
  started,
  runs,
  onReview,
  onDismiss,
}: {
  /** The runs this screen started, newest first, with their titles. */
  started: { id: string; title: string }[];
  /** The workflow's runs, as they are now. */
  runs: ScreenRun[];
  onReview: (run: string) => void;
  onDismiss: (run: string) => void;
}) =>
  started.length === 0 ? null : (
    <section aria-label="Notes being read" className="flex flex-col gap-2">
      <h2 className="font-medium">Notes being read</h2>
      <ul className="flex flex-col gap-2">
        {started.map(({ id, title }) => {
          const run = runs.find((each) => each.id === id);
          return (
            <li key={id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{title}</span>
              <span>{statusOf(run)}</span>
              {run?.status === "completed" ? (
                <Button
                  variant="outline"
                  aria-label={`Review the statements from ${title}`}
                  onClick={() => {
                    onReview(id);
                  }}
                >
                  Review
                </Button>
              ) : null}
              {run?.status === "failed" || run?.status === "cancelled" ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    onDismiss(id);
                  }}
                >
                  Dismiss
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
