import type { DocumentRead, VersionSummary } from "@grasp-os/shared/knowledge";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { DocumentMarkdown } from "./markdown.tsx";
import { saveOrNewer } from "./save.ts";

// One document: its details, its text rendered, and, where the person may
// change it, an editor and its history to restore from. Every save names
// the version it was edited from, so a save that would overwrite someone
// else's shows their version instead.

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Who saved a version: the person themselves, or their user ID. */
const savedBy = (author: string, me: string): string =>
  author === me ? "You" : author;

const Details = ({ doc }: { doc: DocumentRead }) => (
  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
    <dt className="text-muted-foreground">Path</dt>
    <dd>{doc.path}</dd>
    <dt className="text-muted-foreground">Type</dt>
    <dd>{doc.type}</dd>
    <dt className="text-muted-foreground">Version</dt>
    <dd>{doc.currentVersion}</dd>
    <dt className="text-muted-foreground">Review by</dt>
    <dd>{doc.reviewDate ?? "–"}</dd>
    <dt className="text-muted-foreground">When to use</dt>
    <dd className="col-span-1 sm:col-span-3">{doc.description || "–"}</dd>
  </dl>
);

const Editor = ({
  doc,
  onClose,
}: {
  doc: DocumentRead;
  onClose: () => void;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState(doc.version.text);
  const [message, setMessage] = useState("");
  // The version this text is edited from: a conflict moves it on to the
  // newer one, which the person has now seen.
  const [base, setBase] = useState(doc.currentVersion);
  const [newer, setNewer] = useState<DocumentRead>();
  const save = async (): Promise<void> => {
    const outcome = await run(async (session) => {
      const result = await saveOrNewer(session, doc.id, {
        collectionId: doc.collectionId,
        path: doc.path,
        text,
        ifVersion: base,
        ...(message.trim() === "" ? {} : { message }),
      });
      if ("saved" in result) {
        // `sync` waits for the loader: the page shows the new version.
        await router.invalidate({ sync: true });
      }
      return result;
    });
    if (outcome === undefined) {
      return;
    }
    if ("newer" in outcome) {
      setNewer(outcome.newer);
      setBase(outcome.newer.currentVersion);
      return;
    }
    onClose();
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {newer === undefined ? null : (
        <section
          aria-labelledby="newer-version"
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <p
            className="text-destructive text-sm"
            id="newer-version"
            role="alert"
          >
            {`This document changed since you opened it. Version ${newer.currentVersion} is below; your text is kept. Apply your change to it, then save again.`}
          </p>
          <DocumentMarkdown text={newer.version.text} />
          <Button
            className="self-start"
            onClick={() => {
              setText(newer.version.text);
            }}
            type="button"
            variant="outline"
          >
            {`Start again from version ${newer.currentVersion}`}
          </Button>
        </section>
      )}
      <Textarea
        aria-label="Text"
        className="min-h-96"
        onChange={(event) => {
          setText(event.target.value);
        }}
        value={text}
      />
      <Input
        aria-label="What changed"
        maxLength={500}
        onChange={(event) => {
          setMessage(event.target.value);
        }}
        placeholder="What changed"
        value={message}
      />
      <div className="flex gap-2">
        <Button disabled={busy} type="submit">
          Save
        </Button>
        <Button
          disabled={busy}
          onClick={onClose}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

const History = ({
  doc,
  versions,
  me,
  writable,
}: {
  doc: DocumentRead;
  versions: VersionSummary[];
  me: string;
  writable: boolean;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const restore = async (version: number): Promise<void> => {
    await run(async (session) => {
      // Read again whatever the outcome: a restore refused as a conflict
      // means the page shows an old version.
      await changeThenRefresh(
        async () =>
          await session.knowledge.restoreVersion({
            documentId: doc.id,
            version,
            ifVersion: doc.currentVersion,
          }),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <section aria-labelledby="history" className="flex flex-col gap-2">
      <h3 className="font-medium" id="history">
        History
      </h3>
      <ErrorText>{failure}</ErrorText>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead>
            <TableHead>Saved by</TableHead>
            <TableHead>When</TableHead>
            <TableHead>What changed</TableHead>
            {writable ? <TableHead /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((version) => (
            <TableRow key={version.number}>
              <TableCell>{version.number}</TableCell>
              <TableCell>{savedBy(version.author, me)}</TableCell>
              <TableCell>
                {dateTime.format(new Date(version.createdAt))}
              </TableCell>
              <TableCell>
                {version.restoredFrom === null
                  ? (version.message ?? "")
                  : `Restored version ${version.restoredFrom}`}
              </TableCell>
              {writable ? (
                <TableCell>
                  {version.number === doc.currentVersion ? null : (
                    <Button
                      aria-label={`Restore version ${version.number}`}
                      disabled={busy}
                      onClick={() => {
                        void restore(version.number);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Restore
                    </Button>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
};

/** A document, with its editor and history where the person may change it. */
export const DocumentView = ({
  doc,
  versions,
  me,
  writable,
}: {
  doc: DocumentRead;
  versions: VersionSummary[];
  me: string;
  writable: boolean;
}) => {
  const [editing, setEditing] = useState(false);
  return (
    <section aria-labelledby="document" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-medium" id="document">
          {doc.title}
        </h2>
        {writable && !editing ? (
          <Button
            className="ml-auto"
            onClick={() => {
              setEditing(true);
            }}
            variant="outline"
          >
            Edit
          </Button>
        ) : null}
      </div>
      <Details doc={doc} />
      {editing ? (
        <Editor
          doc={doc}
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : (
        <DocumentMarkdown text={doc.version.text} />
      )}
      <History doc={doc} me={me} versions={versions} writable={writable} />
    </section>
  );
};
