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
import { viewer } from "../components/viewer";
import type { Shown } from "../components/viewer";

/** Opens a snapshot on the server. */
const openSnapshot = async (id: string) => await ask<Snapshot>("open", id);

/**
 * The board page: a snapshot of the Playbook on one page, the newest by
 * default, with a way to take a new one and write its narrative. Only the
 * page itself prints: the controls around it don't.
 */
const Board = () => {
  const [listed, setListed] = useState<Snapshots | null>(null);
  const [opened, setOpened] = useState<Snapshot | null>(null);
  const [problem, setProblem] = useState("");
  // Which snapshot is shown, from the answers as they come (viewer.ts).
  const snapshots = useRef(viewer(openSnapshot));
  const to: Shown = {
    show: (snapshot) => {
      setProblem("");
      setOpened(snapshot);
    },
    refuse: (code) => {
      setProblem(refusal(code));
    },
  };
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

  // Lists the snapshots again, with one just taken, and opens it.
  const taken = async (id: string): Promise<void> => {
    await Promise.all([list(), snapshots.current.open(id, to)]);
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
      if (newest !== undefined) {
        await snapshots.current.first(newest, {
          show: (snapshot) => {
            setOpened(snapshot);
          },
          refuse: (code) => {
            setProblem(refusal(code));
          },
        });
      }
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
                    void snapshots.current.open(id, to);
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
                void snapshots.current.saved(id, to);
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
