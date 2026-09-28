import { callServer } from "@grasp-os/sdk/screen";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useState } from "react";

import { LinkForm } from "./link-form";
import { ParametersEditor } from "./parameters";
import { recordOf, refusal } from "./playbook";
import type { Opened, Outcome, Team, Workflow } from "./playbook";
import { draftChanged, draftOf, draftProblem, recordToSave } from "./record";
import type { Draft } from "./record";
import { StepsEditor } from "./steps";
import { TeamPicker } from "./team-picker";
import { expectedGain, formatHours, shortTextMax, totalsOf } from "./totals";
import type { Step, Totals, WorkflowRecord } from "./totals";

/** What a save answers: the workflow's document. */
interface Saved {
  id: string;
  currentVersion: number;
}

const TotalsLine = ({ totals, label }: { totals: Totals; label: string }) => (
  <dl aria-label={label} className="flex flex-wrap gap-6 text-sm">
    <div>
      <dt className="text-muted-foreground">Hours a week</dt>
      <dd className="font-medium">{formatHours(totals.hoursPerWeek)}</dd>
    </div>
    <div>
      <dt className="text-muted-foreground">People</dt>
      <dd className="font-medium">{totals.people}</dd>
    </div>
    <div>
      <dt className="text-muted-foreground">Handovers</dt>
      <dd className="font-medium">{totals.handovers}</dd>
    </div>
    <div>
      <dt className="text-muted-foreground">Numbers</dt>
      <dd className="font-medium">{totals.basis}</dd>
    </div>
  </dl>
);

/** The drawn workflow a designed one is set beside, read only. */
const DrawnSide = ({ drawn }: { drawn: Workflow }) => {
  const record = recordOf(drawn);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Drawn (version {drawn.version})</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <TotalsLine label="Drawn totals" totals={totalsOf(record.steps)} />
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
            {record.steps.map((step, index) => (
              <li key={index}>
                {step.name}
                {step.who === undefined ? "" : ` (${step.who})`}
                {step.handover ? ", then hands over" : ""}
              </li>
            ))}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
};

/** The editor's form: the workflow's title, team, steps and parameters. */
const DraftCard = ({
  draft,
  onDraft,
  body,
  onBody,
  designed,
  drawnSteps,
  wide,
  teams,
  onSave,
  onDesign,
  designBlocked,
  saveProblem,
  busy,
  onRefused,
}: {
  draft: Draft;
  onDraft: (draft: Draft) => void;
  body: string;
  onBody: (body: string) => void;
  designed: boolean;
  /** The drawn version's steps, beside a designed one. */
  drawnSteps: Step[] | undefined;
  /** Whether it has the whole width: nothing is set beside it. */
  wide: boolean;
  teams: Team[];
  onSave: () => void;
  /** Saves it as designed; undefined when a workflow can't be designed. */
  onDesign: (() => void) | undefined;
  /** Whether designing waits: unsaved changes. */
  designBlocked: boolean;
  /** Why it can't be saved as it is, if it can't (`draftProblem`). */
  saveProblem: string | undefined;
  /**
   * While a save or link is on its way and the saved version is opened:
   * nothing can be edited, so no change is lost when it opens.
   */
  busy: boolean;
  onRefused: (code: string) => void;
}) => (
  <Card className={wide ? "lg:col-span-2" : undefined}>
    <CardHeader>
      <CardTitle>{designed ? "Designed" : "Drawn"}</CardTitle>
    </CardHeader>
    <CardContent>
      <fieldset
        aria-label="Workflow"
        disabled={busy}
        className="flex min-w-0 flex-col gap-4"
      >
        <div className="flex flex-wrap items-end gap-2">
          <Input
            aria-label="Title"
            placeholder="Title"
            maxLength={shortTextMax}
            value={draft.title}
            onChange={(event) => {
              onDraft({ ...draft, title: event.target.value });
            }}
          />
          <TeamPicker
            teams={teams}
            team={draft.team}
            onChange={(team) => {
              onDraft({ ...draft, team });
            }}
            onRefused={onRefused}
          />
        </div>
        <StepsEditor
          steps={draft.steps}
          designed={designed}
          disabled={busy}
          onChange={(steps) => {
            onDraft({ ...draft, steps });
          }}
        />
        <TotalsLine
          label={designed ? "Designed totals" : "Totals"}
          totals={totalsOf(draft.steps)}
        />
        {drawnSteps === undefined ? null : (
          <p aria-label="Expected gain" className="text-sm font-medium">
            Expected gain: {formatHours(expectedGain(drawnSteps, draft.steps))}{" "}
            a week
          </p>
        )}
        <ParametersEditor
          parameters={draft.parameters}
          onChange={(parameters) => {
            onDraft({ ...draft, parameters });
          }}
        />
        <Textarea
          aria-label="Description"
          placeholder="What this workflow is for, in plain words"
          value={body}
          onChange={(event) => {
            onBody(event.target.value);
          }}
        />
        {saveProblem === undefined ? null : (
          <p
            aria-label="Why it can't be saved"
            className="text-destructive text-sm"
          >
            {saveProblem}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={saveProblem !== undefined} onClick={onSave}>
            Save
          </Button>
          {onDesign === undefined ? null : (
            <>
              <Button
                variant="outline"
                disabled={designBlocked || saveProblem !== undefined}
                onClick={onDesign}
              >
                Design it
              </Button>
              {designBlocked ? (
                <span className="text-muted-foreground self-center text-sm">
                  Save first, then design it.
                </span>
              ) : null}
            </>
          )}
        </div>
      </fieldset>
    </CardContent>
  </Card>
);

/** Back to the list, the workflow's state and version, and what went wrong. */
const EditorHeader = ({
  state,
  version,
  problem,
  unsaved,
  onBack,
}: {
  state: WorkflowRecord["state"];
  version: number | undefined;
  problem: string;
  /** Whether going back drops changes: it says so. */
  unsaved: boolean;
  onBack: () => void;
}) => (
  <>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={onBack}>
        {unsaved ? "Discard changes and go back" : "All workflows"}
      </Button>
      <Badge variant={state === "designed" ? "default" : "outline"}>
        {state}
      </Badge>
      {version === undefined ? null : (
        <span className="text-muted-foreground text-sm">Version {version}</span>
      )}
    </div>
    {problem === "" ? null : (
      <p role="alert" className="text-destructive text-sm">
        {problem}
      </p>
    )}
  </>
);

/**
 * A workflow's editor: its title, team, steps with their numbers, and
 * parameters. A designed one shows its expected gain against the drawn
 * version beside it. `opened` is null for a new, drawn, workflow.
 */
export const WorkflowEditor = ({
  opened,
  teams,
  onSaved,
  onBack,
}: {
  opened: Opened | null;
  teams: Team[];
  /** Opens the saved version, which replaces this editor. */
  onSaved: (id: string) => Promise<void>;
  onBack: () => void;
}) => {
  const current = opened?.current;
  const stored = current === undefined ? undefined : recordOf(current);
  const state = stored?.state ?? "drawn";
  const designed = state === "designed";
  const drawn = opened?.drawn ?? undefined;
  const drawnSteps = drawn === undefined ? undefined : recordOf(drawn).steps;
  const [draft, setDraft] = useState<Draft>(draftOf(stored));
  const [body, setBody] = useState(current?.body ?? "");
  // Designing saves the stored drawn version as designed: only once what
  // the editor holds is saved, so no edit lands as designed unseen.
  const unsaved = draftChanged(draft, body, current);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const refused = (code: string): void => {
    setProblem(refusal(code));
  };
  // Each save works its gain out from the drawn steps beside it, or, when
  // designing, from the drawn version open now.
  const baselineFor = (to: WorkflowRecord["state"]): Step[] | undefined =>
    drawnSteps ?? (to === "designed" ? stored?.steps : undefined);
  const gainOf = (to: WorkflowRecord["state"]): number | undefined => {
    const baseline = baselineFor(to);
    return to === "designed" && baseline !== undefined
      ? expectedGain(baseline, draft.steps)
      : undefined;
  };
  const saveProblem = draftProblem(draft, gainOf(state));

  // Nothing can be edited from the moment a change is sent until the
  // version it saved is open (or it was refused), so nothing typed
  // meanwhile is lost when that version replaces this editor.
  const whileBusy = async (
    run: () => Promise<string | undefined>
  ): Promise<void> => {
    setBusy(true);
    setProblem("");
    try {
      const saved = await run();
      if (saved !== undefined) {
        await onSaved(saved);
      }
    } catch {
      // The page couldn't reach core: nothing was saved.
      refused("app.unreachable");
    }
    setBusy(false);
  };

  const save = async (
    to: WorkflowRecord["state"]
  ): Promise<string | undefined> => {
    const toDesign = to === "designed";
    const baseline = baselineFor(to);
    const answer = await callServer<Outcome<Saved>>("save", {
      ...(current === undefined ? {} : { path: current.path }),
      ifVersion: current?.version ?? 0,
      record: recordToSave(current?.record ?? {}, draft, to, baseline),
      body,
      ...(toDesign && !designed ? { message: "Designed" } : {}),
    });
    if ("error" in answer) {
      refused(answer.error);
    }
    return "error" in answer ? undefined : answer.ok.id;
  };

  return (
    <div className="flex flex-col gap-4">
      <EditorHeader
        state={state}
        version={current?.version}
        problem={problem}
        unsaved={unsaved}
        onBack={onBack}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {drawn === undefined ? null : <DrawnSide drawn={drawn} />}
        <DraftCard
          draft={draft}
          onDraft={setDraft}
          body={body}
          onBody={setBody}
          designed={designed}
          drawnSteps={designed ? drawnSteps : undefined}
          wide={drawn === undefined}
          teams={teams}
          onSave={() => {
            void whileBusy(async () => await save(state));
          }}
          onDesign={
            current === undefined || designed
              ? undefined
              : () => {
                  void whileBusy(async () => await save("designed"));
                }
          }
          designBlocked={unsaved}
          saveProblem={saveProblem}
          busy={busy}
          onRefused={refused}
        />
      </div>
      {current !== undefined && designed ? (
        <LinkForm
          workflow={current}
          blocked={unsaved}
          busy={busy}
          onLink={(link) => {
            void whileBusy(async () => {
              const answer = await link();
              if ("error" in answer) {
                refused(answer.error);
              }
              return "error" in answer ? undefined : current.id;
            });
          }}
        />
      ) : null}
    </div>
  );
};
