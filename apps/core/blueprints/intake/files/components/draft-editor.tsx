import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useState } from "react";

import {
  ask,
  draftProblem,
  emptyDraft,
  mediumLabels,
  notesMax,
  refusal,
  shortTextMax,
  sourceMedia,
} from "./intake";
import type {
  Draft,
  DraftSource,
  OpenedDraft,
  Saved,
  SourceMedium,
} from "./intake";
import { whilePending } from "./pending";
import { StatementsEditor } from "./statements";

const media = sourceMedia.map((value) => ({
  value,
  label: mediumLabels[value],
}));

/** The source: its title, medium, date, who it came from, and its notes. */
const SourceFields = ({
  source,
  disabled,
  onChange,
}: {
  source: DraftSource;
  disabled: boolean;
  onChange: (source: DraftSource) => void;
}) => (
  <div className="flex flex-col gap-2">
    <Input
      aria-label="Source title"
      placeholder="Interview with the controller"
      maxLength={shortTextMax}
      value={source.title}
      disabled={disabled}
      onChange={(event) => {
        onChange({ ...source, title: event.target.value });
      }}
    />
    <div className="flex flex-wrap gap-2">
      <Select
        items={media}
        value={source.medium}
        disabled={disabled}
        onValueChange={(medium: SourceMedium | null) => {
          onChange({ ...source, medium: medium ?? source.medium });
        }}
      >
        <SelectTrigger aria-label="Medium">
          <SelectValue placeholder="Medium" />
        </SelectTrigger>
        <SelectContent>
          {media.map((medium) => (
            <SelectItem key={medium.value} value={medium.value}>
              {medium.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        aria-label="Date"
        type="date"
        className="w-auto"
        value={source.date}
        disabled={disabled}
        onChange={(event) => {
          onChange({ ...source, date: event.target.value });
        }}
      />
      <Input
        aria-label="From"
        placeholder="Who it came from: a name or a role"
        className="w-auto grow"
        maxLength={shortTextMax}
        value={source.from}
        disabled={disabled}
        onChange={(event) => {
          onChange({ ...source, from: event.target.value });
        }}
      />
    </div>
    <Textarea
      aria-label="Notes"
      placeholder="The notes, kept with the source (optional)"
      maxLength={notesMax}
      value={source.notes}
      disabled={disabled}
      onChange={(event) => {
        onChange({ ...source, notes: event.target.value });
      }}
    />
  </div>
);

/** What an action ends in, for the screen that holds the editor. */
export type EditorResult =
  /** Kept, and opened again; `problem` when saving it then failed. */
  | { kind: "kept"; opened: OpenedDraft; problem?: string }
  | { kind: "saved"; saved: Saved }
  /** Discarded; `saving` when its save had started, and wrote some. */
  | { kind: "discarded"; saving: boolean };

/**
 * A draft, reviewed and edited before it is saved: a new one (`opened`
 * null) or one kept earlier. Saving writes it to the Playbook; keeping
 * stores the edits for later; discarding drops it. A draft whose save
 * started (`saving`) can only be finished, as it was. Nothing can be
 * edited while an action is on its way, so none is lost when it ends.
 */
export const DraftEditor = ({
  opened,
  problem: shownFirst,
  onResult,
  onBack,
}: {
  opened: OpenedDraft | null;
  /** Why the last action on it failed, shown until the next one. */
  problem: string;
  onResult: (result: EditorResult) => void;
  onBack: () => void;
}) => {
  const [draft, setDraft] = useState<Draft>(opened?.draft ?? emptyDraft());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(shownFirst);
  const saving = opened?.status === "saving";
  const invalid = draftProblem(draft);

  /** Runs `act`, showing why it was refused, if it was. */
  const run = async <T,>(
    act: () => Promise<{ ok: T } | { error: string }>,
    then: (value: T) => Promise<void> | void
  ): Promise<void> => {
    const answer = await whilePending(setBusy, act);
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setProblem("");
    await then(answer.ok);
  };

  /**
   * The draft as the server has it now, after it was kept, opened in the
   * editor; saying `why` a save of it then failed, if it did.
   */
  const reopen = async (id: string, why?: string): Promise<void> => {
    await run(
      async () => await ask<OpenedDraft>("draft", id),
      (reopened) => {
        onResult({ kind: "kept", opened: reopened, problem: why });
      }
    );
  };

  const keep = async (): Promise<void> => {
    if (opened === null) {
      await run(
        async () => await ask<{ id: string }>("create", draft),
        async ({ id }) => {
          await reopen(id);
        }
      );
      return;
    }
    await run(
      async () =>
        await ask<{ version: number }>("keep", {
          id: opened.id,
          ifVersion: opened.version,
          draft,
        }),
      async () => {
        await reopen(opened.id);
      }
    );
  };

  const saveOf = async (id: string, version: number): Promise<void> => {
    await run(
      async () => await ask<Saved>("save", { id, ifVersion: version, draft }),
      (saved) => {
        onResult({ kind: "saved", saved });
      }
    );
  };

  const save = async (): Promise<void> => {
    if (opened !== null) {
      await saveOf(opened.id, opened.version);
      return;
    }
    // A new draft is kept first. Should saving it fail, it is open as
    // kept, saying why, so saving again saves that one, never another.
    await run(
      async () => await ask<{ id: string; version: number }>("create", draft),
      async ({ id, version }) => {
        const answer = await whilePending(
          setBusy,
          async () =>
            await ask<Saved>("save", { id, ifVersion: version, draft })
        );
        if ("error" in answer) {
          await reopen(id, refusal(answer.error));
          return;
        }
        onResult({ kind: "saved", saved: answer.ok });
      }
    );
  };

  const discard = async (): Promise<void> => {
    if (opened === null) {
      onBack();
      return;
    }
    await run(
      async () =>
        await ask<{ saving: boolean }>("discard", {
          id: opened.id,
          ifVersion: opened.version,
        }),
      (answer) => {
        onResult({ kind: "discarded", saving: answer.saving });
      }
    );
  };

  const locked = busy || saving;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{opened === null ? "New source" : "Review"}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {saving ? (
            <p className="text-sm">
              Saving this draft started and didn&apos;t finish. Finish saving it
              as it was, or discard it: what was saved already stays in the
              Playbook.
            </p>
          ) : null}
          <SourceFields
            source={draft.source}
            disabled={locked}
            onChange={(source) => {
              setDraft({ ...draft, source });
            }}
          />
          <StatementsEditor
            statements={draft.statements}
            disabled={locked}
            onChange={(statements) => {
              setDraft({ ...draft, statements });
            }}
          />
          {problem === "" ? null : (
            <p role="alert" className="text-destructive text-sm">
              {problem}
            </p>
          )}
          {invalid === undefined || saving ? null : (
            <p className="text-muted-foreground text-sm">{invalid}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                (!saving &&
                  (invalid !== undefined || draft.statements.length === 0))
              }
              onClick={() => {
                void save();
              }}
            >
              {saving ? "Finish saving" : "Save to the Playbook"}
            </Button>
            {saving ? null : (
              <Button
                variant="outline"
                disabled={busy || invalid !== undefined}
                onClick={() => {
                  void keep();
                }}
              >
                Keep as a draft
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void discard();
              }}
            >
              Discard
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
