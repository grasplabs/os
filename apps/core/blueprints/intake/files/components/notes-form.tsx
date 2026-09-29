import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import { useState } from "react";

import { SourceFields } from "./draft-editor";
import { emptyDraft, notesMax } from "./intake";
import type { DraftSource } from "./intake";
import { whilePending } from "./pending";

/** The most a run's input takes, as JSON text (the platform's bound). */
const runInputMax = 128 * 1024;

/** The largest file read as notes: its text is bounded again after. */
const fileMaxBytes = 1024 * 1024;

/** What the `extract` workflow takes: the source, and its notes. */
export interface NotesInput {
  source: Omit<DraftSource, "notes">;
  notes: string;
}

/** Why `source` can't be read yet, if it can't. */
const notesProblem = (source: DraftSource): string | undefined => {
  if (source.title.trim() === "") {
    return "Give the source a title.";
  }
  if (source.date === "") {
    return "Give the source its date.";
  }
  if (source.notes.trim() === "") {
    return "Paste the notes, or pick a text file.";
  }
  if (source.notes.length > notesMax) {
    return `Notes are at most ${notesMax.toLocaleString()} characters.`;
  }
  return undefined;
};

/**
 * Notes to take statements out of: pasted, or read from a text file, with
 * the source they are from. `onStart` starts the reading, and says why it
 * didn't start, if it didn't.
 */
export const NotesForm = ({
  onStart,
  onBack,
}: {
  onStart: (input: NotesInput) => Promise<string | undefined>;
  onBack: () => void;
}) => {
  const [source, setSource] = useState<DraftSource>(emptyDraft().source);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const invalid = notesProblem(source);

  const readFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) {
      return;
    }
    if (file.size > fileMaxBytes) {
      setProblem("That file is too large: pick one under 1 MB.");
      return;
    }
    const text = await file.text();
    if (text.length > notesMax) {
      setProblem(
        `That file has more than ${notesMax.toLocaleString()} characters: split it.`
      );
      return;
    }
    setProblem("");
    setSource({
      ...source,
      notes: text,
      title: source.title === "" ? file.name.slice(0, 200) : source.title,
    });
  };

  const start = async (): Promise<void> => {
    const { notes, ...described } = source;
    const input: NotesInput = { source: described, notes };
    if (JSON.stringify(input).length > runInputMax) {
      setProblem("The notes are too long to read at once: split them.");
      return;
    }
    const why = await whilePending(setBusy, async () => await onStart(input));
    setProblem(why ?? "");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Take statements out of notes</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            A model reads the notes and lists the claims in them, tagged. They
            come back as a draft to review: nothing is saved to the Playbook
            until you save it.
          </p>
          <SourceFields source={source} disabled={busy} onChange={setSource} />
          <Input
            aria-label="Notes file"
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            disabled={busy}
            onChange={(event) => {
              void readFile(event.target.files?.[0]);
            }}
          />
          {problem === "" ? null : (
            <p role="alert" className="text-destructive text-sm">
              {problem}
            </p>
          )}
          {invalid === undefined ? null : (
            <p className="text-muted-foreground text-sm">{invalid}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || invalid !== undefined}
              onClick={() => {
                void start();
              }}
            >
              Take out statements
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onBack}>
              Back
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
