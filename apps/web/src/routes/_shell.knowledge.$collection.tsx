import { knowledgeErrors, pageMaxLimit } from "@grasp-os/shared/knowledge";
import type {
  Backlink,
  Collection,
  DocumentRead,
  DocumentSummary,
  VersionSummary,
} from "@grasp-os/shared/knowledge";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { CollectionMarkers } from "../knowledge/collection-markers.tsx";
import { DocumentView } from "../knowledge/document.tsx";
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

/** The collection, if the person may read it, and its first page of files. */
const loadCollection = async (
  session: Session,
  collectionId: string
): Promise<CollectionPage> => {
  const [collections, page] = await Promise.all([
    session.knowledge.listCollections(),
    session.knowledge.listDocuments(collectionId),
  ]);
  const collection = collections.find(({ id }) => id === collectionId);
  if (collection === undefined) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return { collection, documents: page.documents };
};

/**
 * The document `documentId`, if it is in this collection, with its history
 * and what links to it.
 */
const loadDocument = async (
  session: Session,
  collectionId: string,
  documentId: string
): Promise<OpenDocument> => {
  const [doc, history, links] = await Promise.all([
    session.knowledge.getDocument(documentId),
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

const FileList = ({
  documents,
  open,
}: {
  documents: DocumentSummary[];
  open: string | undefined;
}) => {
  if (documents.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>This collection has no files yet.</Trans>
      </p>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-1">
        {documents.map((document) => (
          <li className="text-sm" key={document.id}>
            <Link
              aria-current={document.id === open ? "page" : undefined}
              className={
                document.id === open ? "font-medium underline" : "underline"
              }
              from="/knowledge/$collection"
              search={{ doc: document.id }}
            >
              {document.path}
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
  const { collection, open } = Route.useLoaderData();
  const { doc } = Route.useSearch();
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
  return (
    <main className="flex max-w-6xl flex-col gap-6 p-6">
      <Link className="text-sm underline" to="/knowledge">
        <Trans>Knowledge</Trans>
      </Link>
      <NotLoaded page={collection} />
      {collection.state === "ready" ? (
        <>
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-medium">
              {collection.data.collection.name}
            </h1>
            <CollectionMarkers collection={collection.data.collection} />
            {collection.data.collection.description === "" ? null : (
              <p className="text-muted-foreground text-sm">
                {collection.data.collection.description}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-6 md:flex-row">
            <div className="flex flex-col gap-6 md:w-64 md:shrink-0">
              <section aria-labelledby="files" className="flex flex-col gap-2">
                <h2 className="text-lg font-medium" id="files">
                  <Trans>Files</Trans>
                </h2>
                <FileList documents={collection.data.documents} open={doc} />
              </section>
              {writable ? (
                <Uploads
                  // Another collection starts with no uploads to follow.
                  key={collection.data.collection.id}
                  collectionId={collection.data.collection.id}
                  listed={new Set(paths.values())}
                />
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              {open === undefined ? null : <NotLoaded page={open} />}
              {open?.state === "ready" ? (
                <DocumentView
                  // A new document starts with its editor closed.
                  key={open.data.doc.id}
                  backlinks={open.data.backlinks}
                  doc={open.data.doc}
                  me={identity.userId}
                  resolve={(path) => paths.get(path)}
                  versions={open.data.versions}
                  writable={writable}
                />
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </main>
  );
};

export const Route = createFileRoute("/_shell/knowledge/$collection")({
  validateSearch: (search: Record<string, unknown>): { doc?: string } =>
    typeof search.doc === "string" ? { doc: search.doc } : {},
  loaderDeps: ({ search: { doc } }) => ({ doc }),
  // The collection and the open document are read on their own, and say on
  // their own why they failed.
  loader: async ({ context: { core }, params, deps: { doc } }) => {
    const [collection, open] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await loadCollection(session, params.collection)
      ),
      doc === undefined
        ? undefined
        : loadFromCore(
            core,
            async (session) =>
              await loadDocument(session, params.collection, doc)
          ),
    ]);
    return { collection, open };
  },
  component: CollectionView,
});
