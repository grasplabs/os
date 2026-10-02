import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import { pageMaxLimit, searchQueryMaxLength } from "@grasp-os/shared/knowledge";
import { Button } from "@grasp-os/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BookIcon,
  ChevronDownIcon,
  LibraryIcon,
  LockIcon,
  NotebookPenIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import {
  PageSidebar,
  PageSidebarBody,
  PageSidebarTop,
  RailButton,
  RailDivider,
  RailExpand,
  usePageSidebarFold,
} from "../frame/page-sidebar.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import type { KnowledgeNavData } from "./nav-data.ts";
import { countDocuments, folderTree, foldersTo } from "./tree.ts";
import type { Folder } from "./tree.ts";

// Knowledge's navigation in the page sidebar, in the prototype's look
// (grasplabs/prototype `components/brain-nav.tsx`): search at the top, the
// home, the memory files pinned under it, then one entry per collection
// the person may read, which opens in place to its folders and documents
// along a thin guide line, a page at a time. The open document is marked
// and its folders open. It folds to a rail of icons.

/** Where the person is: the collection open, and the document in it. */
export interface KnowledgeAt {
  collection?: string;
  document?: { id: string; path: string };
  /** The collection's first page of documents, when the page read it. */
  documents?: DocumentSummary[];
}

/** A collection's documents, as far as the navigation has read them. */
interface Listed {
  documents: DocumentSummary[];
  /** Whether there may be more after them. */
  more: boolean;
  /** Whether they go past the first page: the person asked for more. */
  extended: boolean;
  failure?: Loaded<unknown>;
}

const entryClass =
  "flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground";

/** One document in the tree. */
const DocumentItem = ({
  document,
  active,
}: {
  document: DocumentSummary;
  active: boolean;
}) => (
  <Link
    aria-current={active ? "page" : undefined}
    className={entryClass}
    params={{ collection: document.collectionId }}
    search={{ doc: document.id }}
    title={document.path}
    to="/knowledge/$collection"
  >
    <span
      aria-hidden="true"
      className="flex size-3 flex-none items-center justify-center"
    >
      <span className="bg-muted-foreground/60 size-1.5 rounded-full" />
    </span>
    <span className="min-w-0 flex-1 truncate">
      {document.path.split("/").at(-1)}
    </span>
  </Link>
);

/** A folder as a heading that folds what it holds: its documents, then its folders. */
const FolderGroup = ({
  folder,
  openDoc,
  isOpen,
  toggle,
}: {
  folder: Folder;
  openDoc: string | undefined;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}) => {
  const { t } = useLingui();
  const expanded = isOpen(folder.path);
  const { name } = folder;
  return (
    <div className="flex flex-col gap-0.5 pt-1">
      <button
        aria-expanded={expanded}
        aria-label={expanded ? t`Close ${name}` : t`Open ${name}`}
        className="hover:bg-accent flex items-center gap-1 rounded-md px-2 py-1 text-left"
        onClick={() => {
          toggle(folder.path);
        }}
        type="button"
      >
        <span className="text-foreground min-w-0 flex-1 truncate text-sm">
          {name}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {countDocuments(folder)}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={
            expanded
              ? "text-muted-foreground size-3.5 transition-transform"
              : "text-muted-foreground size-3.5 -rotate-90 transition-transform"
          }
        />
      </button>
      {expanded ? (
        <>
          {folder.documents.map((document) => (
            <DocumentItem
              active={document.id === openDoc}
              document={document}
              key={document.id}
            />
          ))}
          {folder.folders.map((inner) => (
            <FolderGroup
              folder={inner}
              isOpen={isOpen}
              key={inner.path}
              openDoc={openDoc}
              toggle={toggle}
            />
          ))}
        </>
      ) : null}
    </div>
  );
};

/** A collection's documents at its root, then its folders. */
const Entries = ({
  folder,
  openDoc,
  isOpen,
  toggle,
}: {
  folder: Folder;
  openDoc: string | undefined;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}) => (
  <>
    {folder.documents.map((document) => (
      <DocumentItem
        active={document.id === openDoc}
        document={document}
        key={document.id}
      />
    ))}
    {folder.folders.map((inner) => (
      <FolderGroup
        folder={inner}
        isOpen={isOpen}
        key={inner.path}
        openDoc={openDoc}
        toggle={toggle}
      />
    ))}
  </>
);

/** The set with `key` added when it was missing, removed when it was there. */
const flip = (before: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(before);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
};

/** Search, in the navigation's top row: core's search, on the home page. */
const SearchField = () => {
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const { t } = useLingui();
  return (
    <search>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const q = typed.trim();
          void navigate({ to: "/knowledge", search: q === "" ? {} : { q } });
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t`Search Knowledge`}
            maxLength={searchQueryMaxLength}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
            placeholder={t`Search Knowledge`}
            type="search"
            value={typed}
          />
        </InputGroup>
      </form>
    </search>
  );
};

/** A page of `collection`'s documents after `earlier`, or its first page. */
const readListing = async (
  core: CoreConnection,
  collection: string,
  earlier: readonly DocumentSummary[] = []
): Promise<Listed> => {
  const after = earlier.at(-1)?.path;
  const page = await loadFromCore(
    core,
    async (session) =>
      await session.knowledge.listDocuments(
        collection,
        after === undefined ? {} : { after }
      )
  );
  const extended = earlier.length > 0;
  return page.state === "ready"
    ? {
        documents: [...earlier, ...page.data.documents],
        more: page.data.documents.length === pageMaxLimit,
        extended,
      }
    : { documents: [...earlier], more: false, extended, failure: page };
};

/**
 * The documents of the collections that are open, read when one opens and
 * again whenever the page read its data again; the open collection's first
 * page as the page read it.
 */
const useListed = (
  opened: ReadonlySet<string>,
  at: KnowledgeAt,
  data: KnowledgeNavData
): {
  listed: ReadonlyMap<string, Listed>;
  more: (collection: string) => void;
} => {
  const core = useCore();
  const [listed, setListed] = useState<ReadonlyMap<string, Listed>>(new Map());
  const keep = (collection: string, listing: Listed): void => {
    setListed((before) => new Map([...before, [collection, listing]]));
  };
  const { collection: atCollection, documents: atDocuments } = at;
  const { collections } = data;
  useEffect(() => {
    // Read again whenever the page read the collections again; nothing to
    // read while they failed.
    let current = true;
    const readOpened = async (): Promise<void> => {
      if (collections.state !== "ready") {
        return;
      }
      const toRead = [...opened].filter(
        (collection) => collection !== atCollection || atDocuments === undefined
      );
      const listings = await Promise.all(
        toRead.map(
          async (collection) =>
            [collection, await readListing(core, collection)] as const
        )
      );
      if (current) {
        setListed((before) => new Map([...before, ...listings]));
      }
    };
    void readOpened();
    return () => {
      current = false;
    };
  }, [opened, collections, core, atCollection, atDocuments]);
  // The open collection's first page as the page read it, unless the person
  // asked for more of it here.
  const shown = new Map(listed);
  if (
    atCollection !== undefined &&
    atDocuments !== undefined &&
    listed.get(atCollection)?.extended !== true
  ) {
    shown.set(atCollection, {
      documents: atDocuments,
      more: atDocuments.length === pageMaxLimit,
      extended: false,
    });
  }
  return {
    listed: shown,
    more: (collection) => {
      const readMore = async (): Promise<void> => {
        keep(
          collection,
          await readListing(core, collection, shown.get(collection)?.documents)
        );
      };
      void readMore();
    },
  };
};

/** The navigation itself, open: what the sidebar and the phone's sheet show. */
export const KnowledgeTree = ({
  data,
  at,
  fold,
}: {
  data: KnowledgeNavData;
  at: KnowledgeAt;
  fold?: { label: string; onFold: () => void };
}) => {
  const { t } = useLingui();
  // The collections and folders open: the way to where the person is opens
  // once, and after that closes like anything else.
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(at.collection === undefined ? [] : [at.collection])
  );
  const [folders, setFolders] = useState<ReadonlySet<string>>(
    () => new Set(at.document === undefined ? [] : foldersTo(at.document.path))
  );
  const [revealed, setRevealed] = useState(at.document?.id);
  if (at.document !== undefined && revealed !== at.document.id) {
    setRevealed(at.document.id);
    const { collection } = at;
    if (collection !== undefined) {
      setOpened((before) => new Set([...before, collection]));
    }
    setFolders(
      (before) => new Set([...before, ...foldersTo(at.document?.path ?? "")])
    );
  }
  const { listed, more } = useListed(opened, at, data);
  const openDoc = at.document?.id;
  const memoryFiles =
    data.memory.state === "ready" ? data.memory.data.files : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageSidebarTop fold={fold} joined>
        <SearchField />
      </PageSidebarTop>
      <PageSidebarBody joined>
        <Link
          activeOptions={{ exact: true, includeSearch: false }}
          className="group hover:bg-accent data-[status=active]:bg-accent mt-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm data-[status=active]:font-medium"
          to="/knowledge"
        >
          <LibraryIcon className="text-muted-foreground group-data-[status=active]:text-foreground size-4 flex-none" />
          <span className="min-w-0 flex-1 truncate">{t`Knowledge`}</span>
        </Link>
        {memoryFiles.map((file) => (
          <Link
            aria-current={file.id === openDoc ? "page" : undefined}
            className="group hover:bg-accent aria-[current=page]:bg-accent flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm aria-[current=page]:font-medium"
            key={file.id}
            params={{ collection: file.collectionId }}
            search={{ doc: file.id }}
            to="/knowledge/$collection"
          >
            <NotebookPenIcon className="text-muted-foreground size-4 flex-none" />
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
          </Link>
        ))}
        <span aria-hidden="true" className="bg-border my-2 h-px" />
        <NotLoaded page={data.collections} />
        <NotLoaded page={data.memory} />
        {data.collections.state === "ready"
          ? data.collections.data.map((collection) => {
              const expanded = opened.has(collection.id);
              const current = collection.id === at.collection;
              const { name } = collection;
              const listing = listed.get(collection.id);
              const Icon = collection.access === "me" ? LockIcon : BookIcon;
              return (
                <div className="flex flex-col" key={collection.id}>
                  <div className="hover:bg-accent has-aria-[current=page]:bg-accent flex items-center rounded-md">
                    <Link
                      aria-current={
                        current && openDoc === undefined ? "page" : undefined
                      }
                      className={
                        current
                          ? "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2 text-sm font-medium"
                          : "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2 text-sm"
                      }
                      params={{ collection: collection.id }}
                      search={{}}
                      to="/knowledge/$collection"
                    >
                      <Icon className="text-muted-foreground size-4 flex-none" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                    </Link>
                    <button
                      aria-expanded={expanded}
                      aria-label={expanded ? t`Close ${name}` : t`Open ${name}`}
                      className="flex size-7 flex-none items-center justify-center rounded-md"
                      onClick={() => {
                        setOpened((before) => flip(before, collection.id));
                      }}
                      type="button"
                    >
                      <ChevronDownIcon
                        className={
                          expanded
                            ? "text-muted-foreground size-3.5 transition-transform"
                            : "text-muted-foreground size-3.5 -rotate-90 transition-transform"
                        }
                      />
                    </button>
                  </div>
                  {expanded ? (
                    <div className="my-1 ml-4 flex flex-col gap-0.5 border-l pl-2">
                      {listing === undefined ? null : (
                        <>
                          {listing.documents.length === 0 &&
                          listing.failure === undefined ? (
                            <p className="text-muted-foreground px-2 py-1 text-sm">
                              {t`No files yet.`}
                            </p>
                          ) : null}
                          <Entries
                            folder={folderTree(listing.documents)}
                            isOpen={(key) => folders.has(key)}
                            openDoc={openDoc}
                            toggle={(key) => {
                              setFolders((before) => flip(before, key));
                            }}
                          />
                          {listing.failure === undefined ? null : (
                            <NotLoaded page={listing.failure} />
                          )}
                          {listing.more ? (
                            <Button
                              className="justify-start"
                              onClick={() => {
                                more(collection.id);
                              }}
                              size="xs"
                              variant="ghost"
                            >
                              {t`Show more`}
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          : null}
      </PageSidebarBody>
    </div>
  );
};

/** Knowledge's page sidebar: the tree, or folded, a rail of its collections. */
export const KnowledgeNav = ({
  data,
  at,
}: {
  data: KnowledgeNavData;
  at: KnowledgeAt;
}) => {
  const { t } = useLingui();
  const [folded, setFolded] = usePageSidebarFold("knowledge");
  if (folded) {
    return (
      <PageSidebar folded label={t`Knowledge`}>
        <RailExpand
          label={t`Expand the navigation`}
          onExpand={() => {
            setFolded(false);
          }}
        />
        <RailDivider />
        <RailButton
          active={at.collection === undefined}
          label={t`Knowledge`}
          render={<Link search={{}} to="/knowledge" />}
        >
          <LibraryIcon />
        </RailButton>
        {data.collections.state === "ready"
          ? data.collections.data.map((collection) => (
              <RailButton
                active={collection.id === at.collection}
                key={collection.id}
                label={collection.name}
                render={
                  <Link
                    params={{ collection: collection.id }}
                    search={{}}
                    to="/knowledge/$collection"
                  />
                }
              >
                {collection.access === "me" ? <LockIcon /> : <BookIcon />}
              </RailButton>
            ))
          : null}
      </PageSidebar>
    );
  }
  return (
    <PageSidebar folded={false} label={t`Knowledge`}>
      <KnowledgeTree
        at={at}
        data={data}
        fold={{
          label: t`Fold the navigation`,
          onFold: () => {
            setFolded(true);
          },
        }}
      />
    </PageSidebar>
  );
};
