import { useWorkflow } from "@grasp-os/sdk/screen";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { useEffect, useRef, useState } from "react";

import { DraftEditor } from "../components/draft-editor";
import type { EditorResult } from "../components/draft-editor";
import { Extractions } from "../components/extractions";
import { ask, originLabels, refusal, settle } from "../components/intake";
import type { DraftSummary, OpenedDraft, Overview } from "../components/intake";
import { NotesForm } from "../components/notes-form";
import type { NotesInput } from "../components/notes-form";

/**
 * What the screen shows: the drafts, a new source typed in (the
 * `count`-th since the screen opened), notes to read, or a draft opened
 * for review.
 */
type View =
  | { kind: "list" }
  | { kind: "new"; count: number }
  | { kind: "notes" }
  | { kind: "open"; opened: OpenedDraft; problem: string };

/** What a run of `extract` answers once it has kept its draft. */
const draftOfRun = (output: unknown): string | undefined =>
  typeof output === "object" &&
  output !== null &&
  "draft" in output &&
  typeof output.draft === "string"
    ? output.draft
    : undefined;

/** Why something failed, when there is a reason. */
const Problem = ({ text }: { text: string }) =>
  text === "" ? null : (
    <p role="alert" className="text-destructive text-sm">
      {text}
    </p>
  );

/** The screen's title, and what someone who takes intake starts from it. */
const IntakeHeader = ({
  canStart,
  onNotes,
  onNew,
}: {
  canStart: boolean;
  onNotes: () => void;
  onNew: () => void;
}) => (
  <div className="flex items-center justify-between gap-2">
    <h1 className="text-lg font-medium">Intake</h1>
    {canStart ? (
      <div className="flex gap-2">
        <Button onClick={onNotes}>Read notes</Button>
        <Button variant="outline" onClick={onNew}>
          New source
        </Button>
      </div>
    ) : null}
  </div>
);

/** Why intake shows nothing, when it can't be taken here. */
const AccessNote = ({ overview }: { overview: Overview | null }) => {
  if (overview?.access === "none") {
    return (
      <p className="text-muted-foreground text-sm">
        Intake needs the Playbook: an admin approves its permission first.
      </p>
    );
  }
  if (overview?.access === "ok" && !overview.writable) {
    return (
      <p className="text-muted-foreground text-sm">
        Only admins take intake: they change the Playbook.
      </p>
    );
  }
  return null;
};

/** The drafts waiting for review, newest first. */
const DraftList = ({
  drafts,
  onOpen,
}: {
  drafts: DraftSummary[];
  onOpen: (id: string) => void;
}) =>
  drafts.length === 0 ? (
    <p className="text-muted-foreground text-sm">No drafts wait for review.</p>
  ) : (
    <Table aria-label="Drafts">
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>Taken from</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Statements</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {drafts.map((draft) => (
          <TableRow key={draft.id}>
            <TableCell>
              {draft.title}
              {draft.status === "saving" ? (
                <Badge variant="secondary" className="ml-2">
                  saving
                </Badge>
              ) : null}
            </TableCell>
            <TableCell>{originLabels[draft.origin]}</TableCell>
            <TableCell>{draft.date}</TableCell>
            <TableCell>{draft.statements}</TableCell>
            <TableCell>
              <Button
                variant="outline"
                aria-label={`Review ${draft.title}`}
                onClick={() => {
                  onOpen(draft.id);
                }}
              >
                Review
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

/**
 * Intake: sources and the statements taken from them, reviewed and edited
 * as drafts before they are saved to the Playbook.
 */
const Intake = () => {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  // Each listing and opening asked for, numbered: an answer to any but
  // the latest, arriving late, is dropped, as it would show what the
  // person moved away from.
  const listings = useRef(0);
  const openings = useRef(0);
  const counts = useRef(0);
  const extract = useWorkflow("extract");
  // The notes this screen sent to be read, newest first: each becomes a
  // draft once its run is done.
  const [reading, setReading] = useState<{ id: string; title: string }[]>([]);

  const list = async (): Promise<void> => {
    listings.current += 1;
    const asked = listings.current;
    const answer = await ask<Overview>("overview");
    if (asked !== listings.current) {
      return;
    }
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setProblem("");
    setOverview(answer.ok);
  };

  useEffect(() => {
    let mounted = true;
    const first = async (): Promise<void> => {
      listings.current += 1;
      const asked = listings.current;
      const answer = await ask<Overview>("overview");
      if (!mounted || asked !== listings.current) {
        return;
      }
      if ("error" in answer) {
        setProblem(refusal(answer.error));
        return;
      }
      setOverview(answer.ok);
    };
    void first();
    return () => {
      mounted = false;
    };
  }, []);

  const showList = async (): Promise<void> => {
    openings.current += 1;
    setView({ kind: "list" });
    await list();
  };

  const open = async (id: string): Promise<void> => {
    openings.current += 1;
    const asked = openings.current;
    setNotice("");
    const answer = await ask<OpenedDraft>("draft", id);
    if (asked !== openings.current) {
      return;
    }
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setProblem("");
    setView({ kind: "open", opened: answer.ok, problem: "" });
  };

  /** Starts reading `input`, and says why it didn't start, if it didn't. */
  const startReading = async (
    input: NotesInput
  ): Promise<string | undefined> => {
    const started = await settle(async () => await extract.start(input));
    if ("error" in started) {
      return refusal(started.error);
    }
    const { id } = started.ok;
    setReading((runs) => [{ id, title: input.source.title }, ...runs]);
    openings.current += 1;
    setView({ kind: "list" });
    await list();
    return undefined;
  };

  /** Opens the draft a finished reading kept. */
  const review = async (run: string): Promise<void> => {
    const found = await settle(async () => await extract.status(run));
    if ("error" in found) {
      setProblem(refusal(found.error));
      return;
    }
    const draft = draftOfRun(found.ok.output);
    setReading((runs) => runs.filter(({ id }) => id !== run));
    if (draft === undefined) {
      setProblem("That reading kept no draft.");
      return;
    }
    await open(draft);
  };

  const onResult = async (result: EditorResult): Promise<void> => {
    switch (result.kind) {
      case "kept": {
        openings.current += 1;
        setView({
          kind: "open",
          opened: result.opened,
          problem: result.problem ?? "",
        });
        await list();
        return;
      }
      case "saved": {
        const { statements } = result.saved;
        setNotice(
          `Saved to the Playbook: ${statements} ${statements === 1 ? "statement" : "statements"} and their source.`
        );
        await showList();
        return;
      }
      case "discarded": {
        setNotice(
          result.saving
            ? "Discarded. Records its save already wrote stay in the Playbook."
            : "Discarded."
        );
        await showList();
        return;
      }
      default: {
        result satisfies never;
      }
    }
  };

  const writable = overview?.writable === true;
  return (
    <main className="flex flex-col gap-4 p-6">
      <IntakeHeader
        canStart={view.kind === "list" && writable}
        onNotes={() => {
          openings.current += 1;
          setNotice("");
          setView({ kind: "notes" });
        }}
        onNew={() => {
          counts.current += 1;
          openings.current += 1;
          setNotice("");
          setView({ kind: "new", count: counts.current });
        }}
      />
      <Problem text={problem} />
      {notice === "" ? null : <output className="text-sm">{notice}</output>}
      <AccessNote overview={overview} />
      {view.kind === "list" && writable ? (
        <Extractions
          started={reading}
          onReady={() => {
            void list();
          }}
          onReview={(run) => {
            void review(run);
          }}
          onDismiss={(run) => {
            setReading((runs) => runs.filter(({ id }) => id !== run));
          }}
        />
      ) : null}
      {view.kind === "list" && writable ? (
        <DraftList
          drafts={overview?.drafts ?? []}
          onOpen={(id) => {
            void open(id);
          }}
        />
      ) : null}
      {view.kind === "notes" ? (
        <NotesForm
          onStart={startReading}
          onBack={() => {
            void showList();
          }}
        />
      ) : null}
      {view.kind === "new" || view.kind === "open" ? (
        <DraftEditor
          key={
            view.kind === "new"
              ? `new:${view.count}`
              : `${view.opened.id}@${view.opened.version}`
          }
          opened={view.kind === "new" ? null : view.opened}
          problem={view.kind === "new" ? "" : view.problem}
          onResult={(result) => {
            void onResult(result);
          }}
          onBack={() => {
            void showList();
          }}
        />
      ) : null}
    </main>
  );
};

export default Intake;
