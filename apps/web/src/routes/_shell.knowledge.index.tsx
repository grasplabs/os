import type { Collection, SearchHit } from "@grasp-os/shared/knowledge";
import { searchQueryMaxLength } from "@grasp-os/shared/knowledge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LibraryIcon, SearchXIcon } from "lucide-react";

import {
  CollectionDrawing,
  MemoryDrawing,
  Panel,
} from "../knowledge/blocks.tsx";
import { CollectionMarkers } from "../knowledge/collection-markers.tsx";
import { KnowledgeFrame } from "../knowledge/frame.tsx";
import type { MemoryFiles } from "../knowledge/memory.ts";
import { loadKnowledgeNav } from "../knowledge/nav-data.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// Knowledge's home, a page to go on from, in the prototype's look
// (grasplabs/prototype `components/brain-home.tsx`): what it is in two
// sentences, the memory files agents always have in context, then a block
// per collection the person may read, three to a row. Core lists only
// those, and searches only those; the page shows what it gets.

const SearchResults = ({
  hits,
  collections,
}: {
  hits: SearchHit[];
  collections: ReadonlyMap<string, string>;
}) => {
  if (hits.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchXIcon />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>Nothing matched.</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              Search reads every collection you may read. Try other words, or
              fewer.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ol className="-mx-2 flex flex-col">
      {hits.map((hit) => (
        <li
          className="hover:bg-muted flex flex-col gap-1 rounded-lg px-2 py-2.5"
          key={`${hit.documentId}:${hit.section}`}
        >
          <Link
            className="text-sm font-medium hover:underline"
            params={{ collection: hit.collectionId }}
            search={{ doc: hit.documentId }}
            to="/knowledge/$collection"
          >
            {hit.title}
          </Link>
          <span className="text-muted-foreground text-xs">
            {[collections.get(hit.collectionId) ?? hit.path, ...hit.headings]
              .filter((part) => part !== "")
              .join(" › ")}
          </span>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {hit.snippet}
          </p>
        </li>
      ))}
    </ol>
  );
};

/** The memory files, as the first block: what every agent always has. */
const MemoryBlock = ({ memory }: { memory: MemoryFiles }) => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
      <div className="sm:w-72 sm:flex-none">
        <Panel short>
          <MemoryDrawing />
        </Panel>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
        <p className="text-muted-foreground leading-relaxed">
          <Trans>What every agent has in its context, all the time.</Trans>
        </p>
        {memory.files.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>No memory files are written yet.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {memory.files.map((file) => (
              <li key={file.id}>
                <Link
                  className="font-medium hover:underline"
                  params={{ collection: file.collectionId }}
                  search={{ doc: file.id }}
                  to="/knowledge/$collection"
                >
                  {file.path}
                </Link>{" "}
                <span className="text-muted-foreground">
                  {file.collectionId === memory.personal
                    ? t`(yours)`
                    : t`(company)`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {memory.memory === null ? (
          <p className="text-muted-foreground">
            <Trans>An admin hasn&apos;t set up company memory yet.</Trans>
          </p>
        ) : null}
      </div>
    </div>
  );
};

/** A block per collection, three to a row, each opening its own page. */
const CollectionBlocks = ({ collections }: { collections: Collection[] }) => {
  if (collections.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LibraryIcon />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>There are no collections you can read yet.</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              Collections hold the documents Grasp and its agents may read. An
              admin shares them with you, or you add your own.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className="grid gap-x-6 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
      {collections.map((collection) => (
        <li className="flex flex-col gap-3" key={collection.id}>
          <Link
            className="group flex flex-col gap-3"
            params={{ collection: collection.id }}
            search={{}}
            to="/knowledge/$collection"
          >
            <Panel>
              <CollectionDrawing collection={collection} />
            </Panel>
            <span className="text-sm font-medium group-hover:underline">
              {collection.name}
            </span>
          </Link>
          {collection.description === "" ? null : (
            <p className="text-muted-foreground -mt-2 text-sm leading-relaxed">
              {collection.description}
            </p>
          )}
          <CollectionMarkers collection={collection} />
        </li>
      ))}
    </ul>
  );
};

const Knowledge = () => {
  const { t } = useLingui();
  const { nav, results } = Route.useLoaderData();
  const { q } = Route.useSearch();
  const { collections, memory } = nav;
  const names = new Map(
    collections.state === "ready"
      ? collections.data.map(({ id, name }) => [id, name])
      : []
  );
  return (
    <KnowledgeFrame
      at={{}}
      crumbs={
        q === undefined
          ? [{ label: t`Knowledge` }]
          : [{ label: t`Knowledge`, to: "/knowledge" }, { label: q }]
      }
      data={nav}
    >
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-8 md:px-12">
          <header className="flex flex-col gap-2.5">
            <h1 className="text-2xl font-medium tracking-tight">
              <Trans>Knowledge</Trans>
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              <Trans>
                Everything Grasp and its agents may read, in collections: your
                own, your teams&apos; and your organization&apos;s. Agents read
                a document when they need it, and always have the memory files
                in mind.
              </Trans>
            </p>
          </header>
          {results === undefined ? null : (
            <section aria-labelledby="results" className="flex flex-col gap-3">
              <h2 className="text-sm font-medium" id="results">
                <Trans>Results</Trans>
              </h2>
              <NotLoaded page={results} />
              {results.state === "ready" ? (
                <SearchResults collections={names} hits={results.data.hits} />
              ) : null}
            </section>
          )}
          <section aria-labelledby="memory" className="flex flex-col gap-3">
            <h2 className="text-sm font-medium" id="memory">
              <Trans>Memory</Trans>
            </h2>
            <NotLoaded page={memory} />
            {memory.state === "ready" ? (
              <MemoryBlock memory={memory.data} />
            ) : null}
          </section>
          <section
            aria-labelledby="collections"
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-medium" id="collections">
              <Trans>Collections</Trans>
            </h2>
            <NotLoaded page={collections} />
            {collections.state === "ready" ? (
              <CollectionBlocks collections={collections.data} />
            ) : null}
          </section>
        </div>
      </div>
    </KnowledgeFrame>
  );
};

export const Route = createFileRoute("/_shell/knowledge/")({
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" && search.q.trim() !== ""
      ? { q: search.q.slice(0, searchQueryMaxLength) }
      : {},
  loaderDeps: ({ search: { q } }) => ({ q }),
  // Each part says on its own why it failed; search runs beside the rest.
  loader: async ({ abortController, context: { core }, deps: { q } }) => {
    const [nav, results] = await Promise.all([
      loadKnowledgeNav(core, abortController.signal),
      q === undefined
        ? undefined
        : loadFromCore(
            core,
            async (session) => await session.knowledge.search(q)
          ),
    ]);
    return { nav, results };
  },
  component: Knowledge,
});
