import { callServer } from "@grasp-os/sdk/screen";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { useEffect, useState } from "react";

import { snapshotRecordOf } from "../components/board";
import { BoardPage } from "../components/board-page";
import { NarrativeEditor, TakeSnapshot } from "../components/controls";
import { refusal } from "../components/snapshot";
import type { Outcome, Snapshot, Snapshots } from "../components/snapshot";

/**
 * The board page: a snapshot of the Playbook on one page, the newest by
 * default, with a way to take a new one and write its narrative. Only the
 * page itself prints: the controls around it don't.
 */
const Board = () => {
  const [listed, setListed] = useState<Snapshots | null>(null);
  const [opened, setOpened] = useState<Snapshot | null>(null);
  const [problem, setProblem] = useState("");

  const open = async (id: string): Promise<void> => {
    const answer = await callServer<Outcome<Snapshot>>("open", id);
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setProblem("");
    setOpened(answer.ok);
  };

  // Lists the snapshots again, with one just taken, and opens it.
  const taken = async (id: string): Promise<void> => {
    const answer = await callServer<Outcome<Snapshots>>("snapshots");
    if ("ok" in answer) {
      setListed(answer.ok);
    }
    await open(id);
  };

  // On opening: the snapshots, and the newest of them.
  useEffect(() => {
    let mounted = true;
    const first = async (): Promise<void> => {
      const answer = await callServer<Outcome<Snapshots>>("snapshots");
      if (!mounted) {
        return;
      }
      if ("error" in answer) {
        setProblem(refusal(answer.error));
        return;
      }
      setListed(answer.ok);
      const newest = answer.ok.snapshots[0]?.id;
      if (newest === undefined) {
        return;
      }
      const snapshot = await callServer<Outcome<Snapshot>>("open", newest);
      if (!mounted) {
        return;
      }
      if ("error" in snapshot) {
        setProblem(refusal(snapshot.error));
        return;
      }
      setOpened(snapshot.ok);
    };
    void first();
    return () => {
      mounted = false;
    };
  }, []);

  const items = (listed?.snapshots ?? []).map(({ id, title }) => ({
    value: id,
    label: title,
  }));
  const refused = (code: string): void => {
    setProblem(refusal(code));
  };

  return (
    <main className="flex flex-col gap-4 p-6 print:p-0">
      <div className="flex flex-wrap items-end justify-between gap-2 print:hidden">
        <h1 className="text-lg font-medium">Board page</h1>
        {listed?.access === "ok" ? (
          <div className="flex flex-wrap items-end gap-2">
            {items.length === 0 ? null : (
              <Select
                items={items}
                value={opened?.id ?? null}
                onValueChange={(id: string | null) => {
                  if (id !== null) {
                    void open(id);
                  }
                }}
              >
                <SelectTrigger aria-label="Snapshot">
                  <SelectValue placeholder="Snapshot" />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <TakeSnapshot
              onTaken={(id) => {
                void taken(id);
              }}
              onRefused={refused}
            />
          </div>
        ) : null}
      </div>
      {problem === "" ? null : (
        <p role="alert" className="text-destructive text-sm print:hidden">
          {problem}
        </p>
      )}
      {listed?.access === "none" ? (
        <p className="text-muted-foreground text-sm">
          The page needs the Playbook: an admin approves its permission first.
        </p>
      ) : null}
      {listed?.access === "ok" && listed.snapshots.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No snapshots yet. Take the first one.
        </p>
      ) : null}
      {opened === null ? null : (
        <>
          <p className="text-muted-foreground text-sm print:hidden">
            To print it or save it as a PDF, open this screen full page and use
            your browser&apos;s print: only the page below prints.
          </p>
          <BoardPage
            snapshot={snapshotRecordOf(opened.record)}
            narrative={opened.body}
          />
          <div className="print:hidden">
            <NarrativeEditor
              key={`${opened.id}@${opened.version}`}
              snapshot={opened}
              onSaved={(id) => {
                void open(id);
              }}
              onRefused={refused}
            />
          </div>
        </>
      )}
    </main>
  );
};

export default Board;
