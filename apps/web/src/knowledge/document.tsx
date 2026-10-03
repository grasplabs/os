import { linkPath, wikiLinkPattern } from "@grasp-os/shared/knowledge";
import type {
  Backlink,
  DocumentRead,
  VersionSummary,
} from "@grasp-os/shared/knowledge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon, DownloadIcon, PencilIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { documentTypeLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { DocumentMarkdown } from "./markdown.tsx";
import { saveOrNewer } from "./save.ts";
import { Timeline } from "./timeline.tsx";
import type { ResolveLink } from "./wiki-links.ts";

// One document, read like a note in the prototype's brain
// (grasplabs/prototype `routes/brain/$noteId.tsx`): its kind, title and
// when to use it, then its text, and its history as a timeline below it.
// Its details (where it is, what it links to and what links to it, its
// review date) sit beside it, or fold in at its foot on a narrower window. Where the person may change it: an editor, and
// restoring from its history. Every save names the version it was edited
// from, so a save that would overwrite one made since, in another tab or
// by someone else, shows that version instead.

const Editor = ({
  doc,
  resolve,
  onClose,
}: {
  doc: DocumentRead;
  resolve: ResolveLink;
  onClose: () => void;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState(doc.version.text);
  const [message, setMessage] = useState("");
  // The version this text is edited from.
  const [base, setBase] = useState(doc.currentVersion);
  // A version saved since `base`, shown after a conflict. While it is, a
  // save would replace it: only the explicit "Replace" does, or the person
  // starts again from it.
  const [newer, setNewer] = useState<DocumentRead>();
  const { t } = useLingui();
  const newerVersion = newer?.currentVersion;
  /** Saves the text as the version after `from`. */
  const save = async (from: number): Promise<void> => {
    const outcome = await run(async (session) => {
      const result = await saveOrNewer(session, doc.id, {
        collectionId: doc.collectionId,
        path: doc.path,
        text,
        ifVersion: from,
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
      return;
    }
    onClose();
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        // With a newer version shown, only the explicit button replaces it.
        if (newer === undefined) {
          void save(base);
        }
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
            {t`This document changed since you opened it. Version ${newerVersion} is below; your text is kept. Start again from it, or replace it with your text.`}
          </p>
          <DocumentMarkdown resolve={resolve} text={newer.version.text} />
          <Button
            className="self-start"
            onClick={() => {
              setText(newer.version.text);
              setBase(newer.currentVersion);
              setNewer(undefined);
            }}
            type="button"
            variant="outline"
          >
            {t`Start again from version ${newerVersion}`}
          </Button>
        </section>
      )}
      <Textarea
        aria-label={t`Text`}
        className="min-h-96"
        onChange={(event) => {
          setText(event.target.value);
        }}
        value={text}
      />
      <Input
        aria-label={t`What changed`}
        maxLength={500}
        onChange={(event) => {
          setMessage(event.target.value);
        }}
        placeholder={t`What changed`}
        value={message}
      />
      <div className="flex gap-2">
        {newer === undefined ? (
          <Button disabled={busy} type="submit">
            <Trans>Save</Trans>
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() => {
              void save(newer.currentVersion);
            }}
            type="button"
            variant="destructive"
          >
            {t`Replace version ${newerVersion} with mine`}
          </Button>
        )}
        <Button
          disabled={busy}
          onClick={onClose}
          type="button"
          variant="outline"
        >
          <Trans>Cancel</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

/** How long an exported file stays readable for the browser's download. */
const exportKeptMs = 40_000;

/** Downloads the document's text, frontmatter and all, as Markdown. */
const exportMarkdown = (doc: DocumentRead): void => {
  const name = doc.path.split("/").at(-1) ?? doc.title;
  const url = URL.createObjectURL(
    new Blob([doc.version.text], { type: "text/markdown;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name.endsWith(".md") ? name : `${name}.md`;
  link.click();
  // Some browsers read the file only after the click returns: it is let go
  // once they surely have it, as FileSaver.js does.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, exportKeptMs);
};

/** A document another one links to, or that links to it, as a chip. */
const DocumentChip = ({
  collectionId,
  documentId,
  title,
}: {
  collectionId: string;
  documentId: string;
  title: string;
}) => (
  <Link
    className="bg-muted hover:bg-accent inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-sm"
    params={{ collection: collectionId }}
    search={{ doc: documentId }}
    to="/knowledge/$collection"
  >
    <span
      aria-hidden="true"
      className="bg-muted-foreground/60 size-1.5 flex-none rounded-full"
    />
    <span className="truncate">{title}</span>
  </Link>
);

/** One of a document's properties: its name in a fixed column, then its value. */
const Property = ({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex gap-4">
    <dt className="text-muted-foreground w-32 flex-none py-0.5">{label}</dt>
    <dd className="min-w-0 flex-1 py-0.5">{children}</dd>
  </div>
);

/** A document this one links to, by its ID, named as the link names it. */
interface Linked {
  documentId: string;
  title: string;
}

/** Fenced code, whose `[[…]]` are code, not links. */
const fencedCode = /^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$/gmu;

/**
 * The documents `text` links to with `[[links]]` that `resolve` knows, each
 * once, in the order they first appear, named by the link's label or its
 * target.
 */
const linksOf = (text: string, resolve: ResolveLink): Linked[] => {
  const found = new Map<string, string>();
  for (const match of text
    .replaceAll(fencedCode, "")
    .matchAll(wikiLinkPattern)) {
    const [target = "", ...rest] = (match.groups?.inner ?? "").split("|");
    const path = linkPath(target);
    const documentId = path === undefined ? undefined : resolve(path);
    if (documentId !== undefined && !found.has(documentId)) {
      const label = rest.join("|").trim();
      found.set(documentId, label === "" ? target.trim() : label);
    }
  }
  return [...found].map(([documentId, title]) => ({ documentId, title }));
};

/** A part of the page folded at its foot, opened by its title. */
const Fold = ({ title, children }: { title: string; children: ReactNode }) => (
  <Collapsible>
    <CollapsibleTrigger
      render={<Button className="-ml-2.5" size="sm" variant="ghost" />}
    >
      <ChevronRightIcon className="text-muted-foreground transition-transform group-aria-expanded/button:rotate-90" />
      {title}
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="pt-2 pb-4">{children}</div>
    </CollapsibleContent>
  </Collapsible>
);

/** The document's properties: where it is, its version and review, and what uses it. */
const Properties = ({
  doc,
  collection,
  links,
  backlinks,
}: {
  doc: DocumentRead;
  collection: string;
  links: Linked[];
  backlinks: Backlink[];
}) => (
  <dl className="flex flex-col gap-2 text-sm">
    <Property label={<Trans>Collection</Trans>}>
      <Link
        className="hover:underline"
        params={{ collection: doc.collectionId }}
        search={{}}
        to="/knowledge/$collection"
      >
        {collection}
      </Link>
    </Property>
    <Property label={<Trans>Path</Trans>}>
      <span className="break-all">{doc.path}</span>
    </Property>
    <Property label={<Trans>Version</Trans>}>
      <span className="tabular-nums">{doc.version.number}</span>
    </Property>
    <Property label={<Trans>Review by</Trans>}>
      {doc.reviewDate ?? "–"}
    </Property>
    <Property label={<Trans>Links to</Trans>}>
      {links.length === 0 ? (
        <span className="text-muted-foreground">–</span>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {links.map((link) => (
            <li className="min-w-0" key={link.documentId}>
              <DocumentChip
                collectionId={doc.collectionId}
                documentId={link.documentId}
                title={link.title}
              />
            </li>
          ))}
        </ul>
      )}
    </Property>
    <Property label={<Trans>Used by</Trans>}>
      {backlinks.length === 0 ? (
        <span className="text-muted-foreground">–</span>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {backlinks.map((backlink) => (
            <li className="min-w-0" key={backlink.documentId}>
              <DocumentChip
                collectionId={backlink.collectionId}
                documentId={backlink.documentId}
                title={backlink.title}
              />
            </li>
          ))}
        </ul>
      )}
    </Property>
  </dl>
);

/** Says an earlier version is open, with the way back to the current one. */
const EarlierVersion = ({ doc }: { doc: DocumentRead }) => {
  const { t, i18n } = useLingui();
  const { number } = doc.version;
  const current = doc.currentVersion;
  const saved = new Date(doc.version.createdAt).toLocaleDateString(
    i18n.locale,
    { day: "numeric", month: "short", year: "numeric" }
  );
  return (
    <div className="bg-muted flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg px-3.5 py-2.5 text-sm">
      <span>
        {t`You're reading version ${number}, saved ${saved}. The current version is ${current}.`}
      </span>
      <Link
        className="font-medium underline-offset-4 hover:underline"
        params={{ collection: doc.collectionId }}
        search={{ doc: doc.id }}
        to="/knowledge/$collection"
      >
        <Trans>Back to the current version</Trans>
      </Link>
    </div>
  );
};

/** A document, with its editor and history where the person may change it. */
export const DocumentView = ({
  doc,
  collection,
  versions,
  backlinks,
  resolve,
  me,
  writable,
}: {
  doc: DocumentRead;
  /** The name of the collection it is in. */
  collection: string;
  versions: VersionSummary[];
  backlinks: Backlink[];
  /** The collection's document at a `[[link]]`'s path, if the page has it. */
  resolve: ResolveLink;
  me: string;
  writable: boolean;
}) => {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  // An earlier version, opened from the history: read only.
  const earlier = doc.version.number !== doc.currentVersion;
  const details = (
    <Properties
      backlinks={backlinks}
      collection={collection}
      doc={doc}
      links={linksOf(doc.version.text, resolve)}
    />
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8 md:px-12">
          <header className="flex flex-col gap-5">
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <span className="bg-muted text-muted-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium">
                  <span
                    aria-hidden="true"
                    className="bg-muted-foreground/60 size-1.5 rounded-full"
                  />
                  {documentTypeLabel(doc.type)}
                </span>
                <div className="flex items-center gap-1.5">
                  {writable && !editing && !earlier ? (
                    <Button
                      onClick={() => {
                        setEditing(true);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <PencilIcon data-icon="inline-start" />
                      <Trans>Edit</Trans>
                    </Button>
                  ) : null}
                  <Button
                    onClick={() => {
                      exportMarkdown(doc);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <DownloadIcon data-icon="inline-start" />
                    <Trans>Export</Trans>
                  </Button>
                </div>
              </div>
              <h1 className="text-2xl font-medium tracking-tight wrap-break-word">
                {doc.title}
              </h1>
              {doc.description === "" ? null : (
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {doc.description}
                </p>
              )}
            </div>
          </header>
          {earlier ? <EarlierVersion doc={doc} /> : null}
          {editing ? (
            <Editor
              doc={doc}
              resolve={resolve}
              onClose={() => {
                setEditing(false);
              }}
            />
          ) : (
            <DocumentMarkdown
              resolve={resolve}
              text={doc.version.text}
              title={doc.title}
            />
          )}
          {/* Too narrow for the side: the details fold in here instead. */}
          <div className="border-t pt-4 2xl:hidden">
            <Fold title={t`Details`}>{details}</Fold>
          </div>
          <Timeline doc={doc} me={me} versions={versions} writable={writable} />
        </div>
      </div>
      <aside
        aria-label={t`Details`}
        className="bg-sidebar hidden w-96 flex-none flex-col overflow-y-auto border-l px-5 pt-4 pb-6 2xl:flex"
      >
        {details}
      </aside>
    </div>
  );
};
