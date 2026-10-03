import { knowledgeErrors, pageMaxLimit } from "@grasp-os/shared/knowledge";
import type {
  Backlink,
  Collection,
  DocumentRead,
  DocumentSummary,
  VersionSummary,
} from "@grasp-os/shared/knowledge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";

import type { Session } from "../core.ts";
import { CollectionMarkers } from "../knowledge/collection-markers.tsx";
import { DocumentView } from "../knowledge/document.tsx";
import { KnowledgeFrame } from "../knowledge/frame.tsx";
import { loadKnowledgeNav } from "../knowledge/nav-data.ts";
import { Uploads } from "../knowledge/uploads.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// One collection: its files, the one open (`?doc=<id>`) with its details,
// text and history, and uploading more. Core decides what the person may
// read and change on every call; the page offers editing, restoring and
// uploading only where core says the person may change the collection.

interface CollectionPage {
  collection: Collection;
  documents: DocumentSummary[];
}

interface OpenDocument {
  doc: DocumentRead;
  versions: VersionSummary[];
  /** The first page of the documents that link to it. */
  backlinks: Backlink[];
}

/**
 * The collection, if the person may read it, and its first page of files.
 * The collections come from the navigation's read (`known`), which the page
 * waits for anyway; only when that failed are they read again here.
 */
const loadCollection = async (
  session: Session,
  collectionId: string,
  known: Promise<Collection[] | undefined>
): Promise<CollectionPage> => {
  const [listed, page] = await Promise.all([
    known,
    session.knowledge.listDocuments(collectionId),
  ]);
  const collections = listed ?? (await session.knowledge.listCollections());
  const collection = collections.find(({ id }) => id === collectionId);
  if (collection === undefined) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return { collection, documents: page.documents };
};

/**
 * The document `documentId` at `version` (the current one without it), if
 * it is in this collection, with its history and what links to it.
 */
const loadDocument = async (
  session: Session,
  collectionId: string,
  documentId: string,
  version: number | undefined
): Promise<OpenDocument> => {
  const [doc, history, links] = await Promise.all([
    session.knowledge.getDocument(documentId, version),
    session.knowledge.history(documentId),
    session.knowledge.backlinks(documentId),
  ]);
  // A link can name any document: only one of this collection opens here,
  // beside its files, and with this collection's controls.
  if (doc.collectionId !== collectionId) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return { doc, versions: history.versions, backlinks: links.backlinks };
};

/** The collection's files, each a row that opens it. */
const FileList = ({ documents }: { documents: DocumentSummary[] }) => {
  const { i18n } = useLingui();
  if (documents.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileTextIcon />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>This collection has no files yet.</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              Documents written here, and files uploaded to it, show up here for
              Grasp and its agents to read.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <ul className="-mx-2 flex flex-col">
        {documents.map((document) => (
          <li key={document.id}>
            <Link
              className="hover:bg-muted flex items-center gap-3 rounded-lg px-2 py-2 text-sm"
              from="/knowledge/$collection"
              search={{ doc: document.id }}
            >
              <FileTextIcon
                aria-hidden="true"
                className="text-muted-foreground size-4 flex-none"
              />
              <span className="min-w-0 flex-1 truncate">{document.path}</span>
              <span className="text-muted-foreground flex-none text-xs tabular-nums">
                {new Date(document.updatedAt).toLocaleDateString(i18n.locale, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {documents.length === pageMaxLimit ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Showing the first {pageMaxLimit} files.</Trans>
        </p>
      ) : null}
    </>
  );
};

const CollectionView = () => {
  const { collection, open, nav } = Route.useLoaderData();
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  // Core says whether the person may change it, by the rule it applies to
  // every change: the page offers only the changes core would take.
  const writable =
    collection.state === "ready" && collection.data.collection.writable;
  // `[[links]]` name paths in the collection: those in the file list open
  // here; any other stays as written.
  const paths = new Map(
    collection.state === "ready"
      ? collection.data.documents.map(({ path, id }) => [path, id])
      : []
  );
  const name =
    collection.state === "ready"
      ? collection.data.collection.name
      : t`Collection`;
  const { collection: collectionId } = Route.useParams();
  const document = open?.state === "ready" ? open.data.doc : undefined;
  return (
    <KnowledgeFrame
      at={{
        collection: collectionId,
        ...(collection.state === "ready"
          ? { documents: collection.data.documents }
          : {}),
        ...(document === undefined ? {} : { document }),
      }}
      crumbs={[
        { label: t`Knowledge`, to: "/knowledge" },
        ...(document === undefined
          ? [{ label: name }]
          : [
              {
                label: name,
                to: "/knowledge/$collection" as const,
                params: { collection: collectionId },
              },
              // The folders the document is in, as its path names them.
              ...document.path
                .split("/")
                .slice(0, -1)
                .map((folder) => ({ label: folder })),
              { label: document.title },
            ]),
      ]}
      data={nav}
    >
      {open === undefined || open.state !== "ready" ? (
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8 md:px-12">
            {open === undefined ? null : <NotLoaded page={open} />}
            <NotLoaded page={collection} />
            {collection.state === "ready" ? (
              <>
                <header className="flex flex-col gap-2.5">
                  <h1 className="text-2xl font-medium tracking-tight">
                    {collection.data.collection.name}
                  </h1>
                  {collection.data.collection.description === "" ? null : (
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      {collection.data.collection.description}
                    </p>
                  )}
                  <CollectionMarkers collection={collection.data.collection} />
                </header>
                {writable ? (
                  <Uploads
                    // Another collection starts with no uploads to follow.
                    key={collection.data.collection.id}
                    collectionId={collection.data.collection.id}
                    listed={new Set(paths.values())}
                  />
                ) : null}
                <section
                  aria-labelledby="files"
                  className="flex flex-col gap-2"
                >
                  <h2 className="text-sm font-medium" id="files">
                    <Trans>Files</Trans>
                  </h2>
                  <FileList documents={collection.data.documents} />
                </section>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <DocumentView
          // A new document starts with its editor closed.
          key={`${open.data.doc.id}@${open.data.doc.version.number}`}
          backlinks={open.data.backlinks}
          collection={name}
          doc={open.data.doc}
          me={identity.userId}
          resolve={(path) => paths.get(path)}
          versions={open.data.versions}
          writable={writable}
        />
      )}
    </KnowledgeFrame>
  );
};

export const Route = createFileRoute("/_shell/knowledge/$collection")({
  validateSearch: (
    search: Record<string, unknown>
  ): { doc?: string; version?: number } => {
    if (typeof search.doc !== "string") {
      return {};
    }
    // An earlier version to read, by its number; any other value reads the
    // current one.
    const { version } = search;
    return typeof version === "number" &&
      Number.isSafeInteger(version) &&
      version > 0
      ? { doc: search.doc, version }
      : { doc: search.doc };
  },
  loaderDeps: ({ search: { doc, version } }) => ({ doc, version }),
  // The collection and the open document are read on their own, and say on
  // their own why they failed.
  loader: async ({
    abortController,
    context: { core },
    params,
    deps: { doc, version },
  }) => {
    const navLoad = loadKnowledgeNav(core, abortController.signal);
    const known = (async () => {
      const { collections } = await navLoad;
      return collections.state === "ready" ? collections.data : undefined;
    })();
    const [collection, open] = await Promise.all([
      loadFromCore(
        core,
        async (session) =>
          await loadCollection(session, params.collection, known)
      ),
      doc === undefined
        ? undefined
        : loadFromCore(
            core,
            async (session) =>
              await loadDocument(session, params.collection, doc, version)
          ),
    ]);
    return { collection, open, nav: await navLoad };
  },
  component: CollectionView,
});
