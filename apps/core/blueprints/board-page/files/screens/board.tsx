import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { useEffect, useRef, useState } from "react";

import { snapshotRecordOf } from "../components/board";
import { BoardPage } from "../components/board-page";
import { NarrativeEditor, TakeSnapshot } from "../components/controls";
import { ask, refusal } from "../components/snapshot";
import type { Snapshot, Snapshots } from "../components/snapshot";

/**
 * The board page: a snapshot of the Playbook on one page, the newest by
 * default, with a way to take a new one and write its narrative. Only the
 * page itself prints: the controls around it don't.
 */
const Board = () => {
  const [listed, setListed] = useState<Snapshots | null>(null);
  const [opened, setOpened] = useState<Snapshot | null>(null);
  const [problem, setProblem] = useState("");
  // The snapshot the person asked for last, and each opening asked for,
  // numbered: an answer to any but the latest, arriving late, is dropped,
  // as it would show what they moved away from, or an older version.
  const selected = useRef<string | null>(null);
  const openings = useRef(0);
  // Each listing asked for, numbered: an older one arriving late is dropped.
  const listings = useRef(0);

  const list = async (): Promise<void> => {
    listings.current += 1;
    const asked = listings.current;
    const answer = await ask<Snapshots>("snapshots");
    if (asked !== listings.current) {
      return;
    }
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setListed(answer.ok);
  };

  const open = async (id: string): Promise<void> => {
    selected.current = id;
    openings.current += 1;
    const asked = openings.current;
    const answer = await ask<Snapshot>("open", id);
    if (asked !== openings.current) {
      return;
    }
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setProblem("");
    setOpened(answer.ok);
  };

  // Lists the snapshots again, with one just taken, and opens it.
  const taken = async (id: string): Promise<void> => {
    await Promise.all([list(), open(id)]);
  };

  // A save shows its new version, unless another snapshot is open by then.
  const saved = async (id: string): Promise<void> => {
    if (selected.current === id) {
      await open(id);
    }
  };

  // On opening: the snapshots, and the newest of them, unless the person
  // opened one first.
  useEffect(() => {
    let mounted = true;
    const first = async (): Promise<void> => {
      listings.current += 1;
      const asked = listings.current;
      const answer = await ask<Snapshots>("snapshots");
      if (!mounted || asked !== listings.current) {
        return;
      }
      if ("error" in answer) {
        setProblem(refusal(answer.error));
        return;
      }
      setListed(answer.ok);
      const newest = answer.ok.snapshots[0]?.id;
      if (newest === undefined || selected.current !== null) {
        return;
      }
      selected.current = newest;
      openings.current += 1;
      const opening = openings.current;
      const snapshot = await ask<Snapshot>("open", newest);
      if (!mounted || opening !== openings.current) {
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
                void saved(id);
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
