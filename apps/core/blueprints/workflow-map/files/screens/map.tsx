import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useRef, useState } from "react";

import { WorkflowEditor } from "../components/editor";
import { WorkflowList } from "../components/overview";
import { ask, refusal } from "../components/playbook";
import type { Opened, Overview } from "../components/playbook";

/**
 * What the screen shows: every workflow, a new one (the `draw`-th drawn
 * since the screen opened), or one opened.
 */
type View =
  | { kind: "list" }
  | { kind: "new"; draw: number }
  | { kind: "open"; opened: Opened };

/** The map's title, and drawing a new workflow for who may (`canDraw`). */
const MapHeader = ({
  canDraw,
  onDraw,
}: {
  canDraw: boolean;
  onDraw: () => void;
}) => (
  <div className="flex items-center justify-between gap-2">
    <h1 className="text-lg font-medium">Workflow map</h1>
    {canDraw ? <Button onClick={onDraw}>Draw a workflow</Button> : null}
  </div>
);

/** Why something failed, while `shown` and there is a reason. */
const Problem = ({ text, shown }: { text: string; shown: boolean }) =>
  shown && text !== "" ? (
    <p role="alert" className="text-destructive text-sm">
      {text}
    </p>
  ) : null;

/** What a view is of, as `selected` holds it. */
const selectionOf = (view: View): string | null => {
  switch (view.kind) {
    case "list": {
      return null;
    }
    case "new": {
      return `new:${view.draw}`;
    }
    case "open": {
      return view.opened.current.id;
    }
    default: {
      return view satisfies never;
    }
  }
};

/**
 * The workflow map: the Playbook's workflows by team, with their totals,
 * and an editor for each, drawn and designed side by side.
 */
const WorkflowMap = () => {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  // Why the overview, or an opening, failed: each cleared when its own
  // call next succeeds. The overview's shows only with the list, which it
  // is about.
  const [listProblem, setListProblem] = useState("");
  const [openProblem, setOpenProblem] = useState("");
  // What the person asked for last (a workflow's ID, a new drawing, or
  // the list, null), and each opening and listing asked for, numbered: an
  // answer to any but the latest, arriving late, is dropped, as it would
  // show what they moved away from, or an older version.
  const selected = useRef<string | null>(null);
  const openings = useRef(0);
  const listings = useRef(0);
  const draws = useRef(0);

  // Asks for what the person chose, and forgets any opening on its way
  // (and why the last one failed).
  const choose = (next: View): void => {
    selected.current = selectionOf(next);
    openings.current += 1;
    setOpenProblem("");
    setView(next);
  };

  const list = async (): Promise<void> => {
    listings.current += 1;
    const asked = listings.current;
    const answer = await ask<Overview>("overview");
    if (asked !== listings.current) {
      return;
    }
    if ("error" in answer) {
      setListProblem(refusal(answer.error));
      return;
    }
    setListProblem("");
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
        setListProblem(refusal(answer.error));
        return;
      }
      setListProblem("");
      setOverview(answer.ok);
    };
    void first();
    return () => {
      mounted = false;
    };
  }, []);

  const open = async (id: string): Promise<void> => {
    selected.current = id;
    openings.current += 1;
    const asked = openings.current;
    const answer = await ask<Opened>("open", id);
    if (asked !== openings.current) {
      return;
    }
    if ("error" in answer) {
      setOpenProblem(refusal(answer.error));
      return;
    }
    setOpenProblem("");
    setView({ kind: "open", opened: answer.ok });
  };

  const showList = async (): Promise<void> => {
    choose({ kind: "list" });
    await list();
  };

  // After a save from `from`: the teams as they are now (one added while
  // editing is among them), and what was saved opened, only while the
  // person is still on what they saved.
  const saved = async (from: View, id: string): Promise<void> => {
    const still = selected.current === selectionOf(from);
    await Promise.all([list(), still ? open(id) : Promise.resolve()]);
  };

  const teams = overview?.teams ?? [];
  // Whether the Playbook takes this person's changes through the map
  // (only an admin's, and only while the map may write it): if not, the
  // map reads it.
  const writable = overview?.writable === true;

  return (
    <main className="flex flex-col gap-4 p-6">
      <MapHeader
        canDraw={view.kind === "list" && writable}
        onDraw={() => {
          draws.current += 1;
          choose({ kind: "new", draw: draws.current });
        }}
      />
      <Problem text={listProblem} shown={view.kind === "list"} />
      <Problem text={openProblem} shown />
      {overview?.access === "none" ? (
        <p className="text-muted-foreground text-sm">
          The map needs the Playbook: an admin approves its permission first.
        </p>
      ) : null}
      {view.kind === "list" && (overview?.unreadable.length ?? 0) > 0 ? (
        <output className="text-muted-foreground text-sm">
          Could not read{" "}
          {overview?.unreadable.map(({ title }) => title).join(", ")}. The map
          no longer reads what is stored for it.
        </output>
      ) : null}
      {view.kind === "list" && overview?.access === "ok" ? (
        <WorkflowList
          workflows={overview.workflows}
          teams={teams}
          writable={writable}
          onOpen={(id) => {
            void open(id);
          }}
        />
      ) : null}
      {view.kind === "list" ? null : (
        <WorkflowEditor
          key={
            view.kind === "new"
              ? `new:${view.draw}`
              : `${view.opened.current.id}@${view.opened.current.version}`
          }
          opened={view.kind === "new" ? null : view.opened}
          teams={teams}
          writable={writable}
          onSaved={async (id) => {
            await saved(view, id);
          }}
          onBack={() => {
            void showList();
          }}
        />
      )}
    </main>
  );
};

export default WorkflowMap;
