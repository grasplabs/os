import { callServer } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useState } from "react";

import { WorkflowEditor } from "../components/editor";
import { WorkflowList } from "../components/overview";
import { refusal } from "../components/playbook";
import type { Opened, Outcome, Overview } from "../components/playbook";

/** What the screen shows: every workflow, a new one, or one opened. */
type View =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "open"; opened: Opened };

/** Every workflow and team, as the server answers them. */
const loadOverview = async (): Promise<Outcome<Overview>> =>
  await callServer<Outcome<Overview>>("overview");

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

/**
 * The workflow map: the Playbook's workflows by team, with their totals,
 * and an editor for each, drawn and designed side by side.
 */
const WorkflowMap = () => {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [problem, setProblem] = useState("");

  const show = (answer: Outcome<Overview>): void => {
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
      const answer = await loadOverview();
      if (!mounted) {
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

  const open = async (id: string): Promise<void> => {
    setProblem("");
    const answer = await callServer<Outcome<Opened>>("open", id);
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setView({ kind: "open", opened: answer.ok });
  };

  const showList = async (): Promise<void> => {
    setView({ kind: "list" });
    show(await loadOverview());
  };

  // Opens what was saved, with the teams as they are now: one added while
  // editing is among them.
  const saved = async (id: string): Promise<void> => {
    await open(id);
    const answer = await loadOverview();
    if ("ok" in answer) {
      setOverview(answer.ok);
    }
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
          setView({ kind: "new" });
        }}
      />
      {problem === "" ? null : (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
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
              ? "new"
              : `${view.opened.current.id}@${view.opened.current.version}`
          }
          opened={view.kind === "new" ? null : view.opened}
          teams={teams}
          writable={writable}
          onSaved={saved}
          onBack={() => {
            void showList();
          }}
        />
      )}
    </main>
  );
};

export default WorkflowMap;
