import type {
  Collection,
  DocumentSummary,
  SearchHit,
} from "@grasp-os/shared/knowledge";
import { searchQueryMaxLength } from "@grasp-os/shared/knowledge";
import { memoryFileNames } from "@grasp-os/shared/memory";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { CollectionMarkers } from "../knowledge/collection-markers.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// Knowledge, calm by default: a search box, the memory files agents always
// have in context, and the collections the person may read. Core lists
// only those, and searches only those; the page shows what it gets.

/** The memory files in the person's own context, and where they are. */
interface MemoryFiles {
  /** The company's Memory collection, `null` until an admin sets it up. */
  memory: string | null;
  /** The person's Personal collection, with their USER.md. */
  personal: string;
  files: DocumentSummary[];
}

const memoryFilePaths = new Set<string>(memoryFileNames);

/**
 * The company's AGENTS.md and MEMORY.md and the person's USER.md, those
 * written so far: the files at the root of the two collections by those
 * names. An agent's own AGENTS.md sits deeper, and only that agent gets it.
 * They are on the first page: in path order, names in capitals come before
 * the folders (`agents/…`) the Memory collection has. Asking for the
 * collections creates what doesn't exist yet: the person's Personal
 * collection on their first visit, and the company's Memory collection
 * when an admin opens the page before it is set up.
 */
const loadMemory = async (session: Session): Promise<MemoryFiles> => {
  const { memory, personal } = await session.memory.collections();
  const pages = await Promise.all(
    [memory, personal]
      .filter((id) => id !== null)
      .map(async (id) => await session.knowledge.listDocuments(id))
  );
  const files = pages
    .flatMap(({ documents }) => documents)
    .filter(({ path }) => memoryFilePaths.has(path));
  return { memory, personal, files };
};

/**
 * The memory files, then the collections: asking for memory creates the
 * Personal collection on a first visit (and an admin's Memory
 * collection), which the list then has. Each says on its own why it
 * failed; the list is read whatever memory's outcome.
 */
const memoryThenCollections = async (core: CoreConnection) => {
  const memory = await loadFromCore(core, loadMemory);
  const collections = await loadFromCore(
    core,
    async (session) => await session.knowledge.listCollections()
  );
  return { memory, collections };
};

const DocumentLink = ({
  collectionId,
  documentId,
  children,
}: {
  collectionId: string;
  documentId: string;
  children: string;
}) => (
  <Link
    className="underline"
    params={{ collection: collectionId }}
    search={{ doc: documentId }}
    to="/knowledge/$collection"
  >
    {children}
  </Link>
);

const SearchBox = ({ query }: { query: string }) => {
  const navigate = useNavigate();
  const [typed, setTyped] = useState(query);
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const q = typed.trim();
        void navigate({
          to: "/knowledge",
          search: q === "" ? {} : { q },
        });
      }}
    >
      <Input
        aria-label="Search Knowledge"
        maxLength={searchQueryMaxLength}
        onChange={(event) => {
          setTyped(event.target.value);
        }}
        placeholder="Search Knowledge"
        type="search"
        value={typed}
      />
      <Button type="submit">Search</Button>
    </form>
  );
};

const SearchResults = ({
  hits,
  collections,
}: {
  hits: SearchHit[];
  collections: ReadonlyMap<string, string>;
}) => {
  if (hits.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing matched.</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {hits.map((hit) => (
        <li
          className="flex flex-col gap-1"
          key={`${hit.documentId}:${hit.section}`}
        >
          <DocumentLink
            collectionId={hit.collectionId}
            documentId={hit.documentId}
          >
            {hit.title}
          </DocumentLink>
          <span className="text-muted-foreground text-xs">
            {[collections.get(hit.collectionId) ?? hit.path, ...hit.headings]
              .filter((part) => part !== "")
              .join(" › ")}
          </span>
          <p className="text-sm">{hit.snippet}</p>
        </li>
      ))}
    </ol>
  );
};

const MemoryCard = ({ memory }: { memory: MemoryFiles }) => (
  <>
    {memory.files.length === 0 ? (
      <p className="text-muted-foreground text-sm">
        No memory files are written yet.
      </p>
    ) : (
      <ul className="flex flex-col gap-1">
        {memory.files.map((file) => (
          <li className="text-sm" key={file.id}>
            <DocumentLink collectionId={file.collectionId} documentId={file.id}>
              {file.path}
            </DocumentLink>{" "}
            <span className="text-muted-foreground">
              {file.collectionId === memory.personal ? "(yours)" : "(company)"}
            </span>
          </li>
        ))}
      </ul>
    )}
    {memory.memory === null ? (
      <p className="text-muted-foreground text-sm">
        An admin hasn&apos;t set up company memory yet.
      </p>
    ) : null}
  </>
);

const CollectionList = ({ collections }: { collections: Collection[] }) => {
  if (collections.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        There are no collections you can read yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {collections.map((collection) => (
        <li className="flex flex-col gap-1" key={collection.id}>
          <span className="flex flex-wrap items-center gap-2">
            <Link
              className="underline"
              params={{ collection: collection.id }}
              to="/knowledge/$collection"
            >
              {collection.name}
            </Link>
            <CollectionMarkers collection={collection} />
          </span>
          {collection.description === "" ? null : (
            <span className="text-muted-foreground text-sm">
              {collection.description}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
};

const Knowledge = () => {
  const { collections, memory, results } = Route.useLoaderData();
  const { q } = Route.useSearch();
  const names = new Map(
    collections.state === "ready"
      ? collections.data.map(({ id, name }) => [id, name])
      : []
  );
  return (
    <main className="flex max-w-4xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-medium">Knowledge</h1>
      {/* A new query starts from what the address says. */}
      <SearchBox key={q} query={q ?? ""} />
      {results === undefined ? null : (
        <section aria-labelledby="results" className="flex flex-col gap-3">
          <h2 className="text-lg font-medium" id="results">
            Results
          </h2>
          <NotLoaded page={results} />
          {results.state === "ready" ? (
            <SearchResults collections={names} hits={results.data.hits} />
          ) : null}
        </section>
      )}
      <section aria-labelledby="memory">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 id="memory">Memory</h2>
            </CardTitle>
            <CardDescription>
              What every agent has in its context, all the time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              <NotLoaded page={memory} />
              {memory.state === "ready" ? (
                <MemoryCard memory={memory.data} />
              ) : null}
            </div>
          </CardContent>
        </Card>
      </section>
      <section aria-labelledby="collections" className="flex flex-col gap-3">
        <h2 className="text-lg font-medium" id="collections">
          Collections
        </h2>
        <NotLoaded page={collections} />
        {collections.state === "ready" ? (
          <CollectionList collections={collections.data} />
        ) : null}
      </section>
    </main>
  );
};

export const Route = createFileRoute("/_shell/knowledge/")({
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" && search.q.trim() !== ""
      ? { q: search.q.slice(0, searchQueryMaxLength) }
      : {},
  loaderDeps: ({ search: { q } }) => ({ q }),
  // Each part says on its own why it failed; search runs beside the rest.
  loader: async ({ context: { core }, deps: { q } }) => {
    const [{ collections, memory }, results] = await Promise.all([
      memoryThenCollections(core),
      q === undefined
        ? undefined
        : loadFromCore(
            core,
            async (session) => await session.knowledge.search(q)
          ),
    ]);
    return { collections, memory, results };
  },
  component: Knowledge,
});
