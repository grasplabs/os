import { useRun } from "@grasp-os/sdk/screen";
import type { ScreenRun } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useRef } from "react";

/** What a reading of notes is doing, in words. */
const statusOf = (run: ScreenRun | null | undefined): string => {
  if (run === undefined) {
    return "Starting";
  }
  if (run === null) {
    return "Unknown: Grasp has no record of this reading";
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
 * One reading, followed by its run's ID (`useRun`), however many runs came
 * since. Tells the screen once it is ready (`onReady`), so the drafts it
 * lists include the one the run kept.
 */
const Reading = ({
  id,
  title,
  onReady,
  onReview,
  onDismiss,
}: {
  id: string;
  title: string;
  onReady: () => void;
  onReview: (run: string) => void;
  onDismiss: (run: string) => void;
}) => {
  const run = useRun("extract", id);
  const ready = run?.status === "completed";
  const told = useRef(false);
  useEffect(() => {
    if (ready && !told.current) {
      told.current = true;
      onReady();
    }
  }, [ready, onReady]);
  const ended =
    run === null || run?.status === "failed" || run?.status === "cancelled";
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{title}</span>
      <span>{statusOf(run)}</span>
      {ready ? (
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
      {ended ? (
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
};

/**
 * The notes this screen sent to be read, newest first, each as its run
 * says it is doing: reading, failed, ready to review as a draft, or
 * unknown when Grasp has no record of it.
 */
export const Extractions = ({
  started,
  onReady,
  onReview,
  onDismiss,
}: {
  /** The runs this screen started, newest first, with their titles. */
  started: { id: string; title: string }[];
  /** A reading is ready: its draft is kept. */
  onReady: () => void;
  onReview: (run: string) => void;
  onDismiss: (run: string) => void;
}) =>
  started.length === 0 ? null : (
    <section aria-label="Notes being read" className="flex flex-col gap-2">
      <h2 className="font-medium">Notes being read</h2>
      <ul className="flex flex-col gap-2">
        {started.map(({ id, title }) => (
          <Reading
            key={id}
            id={id}
            title={title}
            onReady={onReady}
            onReview={onReview}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
    </section>
  );
