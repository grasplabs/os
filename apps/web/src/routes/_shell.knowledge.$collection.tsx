import { knowledgeErrors, pageMaxLimit } from "@grasp-os/shared/knowledge";
import type {
  Collection,
  DocumentRead,
  DocumentSummary,
  VersionSummary,
} from "@grasp-os/shared/knowledge";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import {
  CollectionMarkers,
  isReadOnly,
} from "../knowledge/collection-markers.tsx";
import { DocumentView } from "../knowledge/document.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// One collection: its files, and the one open (`?doc=<id>`) with its
// details, text and history. Core decides what the person may read and
// change on every call; the page leaves out editing and restoring only
// where nobody may change the collection here.

interface CollectionPage {
  collection: Collection;
  documents: DocumentSummary[];
}

interface OpenDocument {
  doc: DocumentRead;
  versions: VersionSummary[];
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

/** The document `documentId`, if it is in this collection, and its history. */
const loadDocument = async (
  session: Session,
  collectionId: string,
  documentId: string
): Promise<OpenDocument> => {
  const [doc, history] = await Promise.all([
    session.knowledge.getDocument(documentId),
    session.knowledge.history(documentId),
  ]);
  // A link can name any document: only one of this collection opens here,
  // beside its files, and with this collection's controls.
  if (doc.collectionId !== collectionId) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return { doc, versions: history.versions };
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
        This collection has no files yet.
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
          {`Showing the first ${pageMaxLimit} files.`}
        </p>
      ) : null}
    </>
  );
};

const CollectionView = () => {
  const { collection, open } = Route.useLoaderData();
  const { doc } = Route.useSearch();
  const { identity } = Route.useRouteContext();
  const writable =
    collection.state === "ready" && !isReadOnly(collection.data.collection);
  return (
    <main className="flex max-w-6xl flex-col gap-6 p-6">
      <Link className="text-sm underline" to="/knowledge">
        Knowledge
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
                  Files
                </h2>
                <FileList documents={collection.data.documents} open={doc} />
              </section>
            </div>
            <div className="min-w-0 flex-1">
              {open === undefined ? null : <NotLoaded page={open} />}
              {open?.state === "ready" ? (
                <DocumentView
                  // A new document starts with its editor closed.
                  key={open.data.doc.id}
                  doc={open.data.doc}
                  me={identity.userId}
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
  loader: async ({ params, deps: { doc } }) => {
    const [collection, open] = await Promise.all([
      loadFromCore(
        async (session) => await loadCollection(session, params.collection)
      ),
      doc === undefined
        ? undefined
        : loadFromCore(
            async (session) =>
              await loadDocument(session, params.collection, doc)
          ),
    ]);
    return { collection, open };
  },
  component: CollectionView,
});
