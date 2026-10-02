import type { ChatSummary } from "@grasp-os/shared/chat";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { PanelLeftIcon, PanelRightIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { GraspBuddy } from "../buddy/grasp-buddy.tsx";
import { ChatList, ChatSidebar } from "../chat/chat-list.tsx";
import { Composer } from "../chat/composer.tsx";
import { applyUpdate, emptyView, followChat } from "../chat/follow-chat.ts";
import type { ChatView } from "../chat/follow-chat.ts";
import { HeldWrites } from "../chat/held-writes.tsx";
import { SidePanel } from "../chat/side-panel.tsx";
import { ChatSources } from "../chat/sources.tsx";
import type { SourceName } from "../chat/sources.tsx";
import { ChatThread } from "../chat/thread.tsx";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Chat with the organization's agent, in the prototype's layout
// (grasplabs/prototype `routes/index.tsx`): the person's chats in the page
// sidebar, and the open one beside them, its answers streaming in as the
// agent writes them, the changes it holds for the person to confirm, and a
// side panel with the Apps it builds. A new chat starts on Grasp's buddy
// and the question "What should we look at today?".

interface ChatPage {
  chats: ChatSummary[];
  /** The models a question may name, the default first. */
  models: string[];
  /** The collections' and connections' names, by ID, for provenance. */
  sourceNames: ReadonlyMap<string, SourceName>;
}

/**
 * The names of the collections and connections the person can see, by
 * ID: a list refused only leaves those IDs unnamed.
 */
const readSourceNames = async (
  session: Session
): Promise<ReadonlyMap<string, SourceName>> => {
  const [collections, connections] = await Promise.allSettled([
    session.knowledge.listCollections(),
    session.connections.list(),
  ]);
  const names = new Map<string, SourceName>();
  if (collections.status === "fulfilled") {
    for (const { id, name } of collections.value) {
      names.set(id, { name, kind: "collection" });
    }
  }
  if (connections.status === "fulfilled") {
    for (const { id, provider, accountName } of connections.value) {
      names.set(id, {
        name: accountName === null ? provider : `${provider} (${accountName})`,
        kind: "connection",
      });
    }
  }
  return names;
};

/** A new chat's title: the start of its first question. */
const titleOf = (question: string): string => {
  const line = question.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * What the box to ask in needs: the text and model, and asking in
 * `chatId`, or in a new chat named after the question.
 */
const useAsk = (chatId: string | undefined, models: readonly string[]) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState("");
  const [model, setModel] = useState(models[0] ?? "");
  const ask = async (question: string): Promise<void> => {
    let created: string | undefined;
    const sent = await run(async (session) => {
      let id = chatId;
      if (id === undefined) {
        ({ id } = await session.chats.create(titleOf(question)));
        created = id;
      }
      await session.chats.send(id, { text: question, model });
      return id;
    });
    if (sent === undefined) {
      // A new chat the question didn't go into is in the list, to ask again.
      if (created !== undefined) {
        await router.invalidate();
      }
      return;
    }
    setText("");
    if (chatId === undefined) {
      await navigate({ to: "/", search: { chat: sent } });
    }
    await router.invalidate();
  };
  const stop = async (): Promise<void> => {
    if (chatId !== undefined) {
      await run(async (session) => await session.chats.cancel(chatId));
    }
  };
  return {
    composer: {
      text,
      onText: setText,
      models,
      model,
      onModel: setModel,
      busy,
      failure,
      onSend: () => {
        void ask(text);
      },
      onStop: () => {
        void stop();
      },
    },
    ask,
  };
};

/** A new chat: Grasp's buddy, the question, and the box to ask in. */
const NewChat = ({ models }: { models: string[] }) => {
  const { composer } = useAsk(undefined, models);
  return (
    <section
      aria-labelledby="new-chat"
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-3xl flex-col gap-8 pb-10">
          <div className="flex flex-col gap-6">
            <GraspBuddy aligned />
            <h1 className="text-2xl font-medium tracking-tight" id="new-chat">
              <Trans>What should we look at today?</Trans>
            </h1>
          </div>
          <Composer running={false} {...composer} />
          <p className="text-muted-foreground text-sm">
            <Trans>
              Describe what you want. The agent answers from what it can read,
              and holds every change to an outside system until you confirm it.
            </Trans>
          </p>
        </div>
      </div>
    </section>
  );
};

/** One chat, followed as it streams, with the side panel beside it. */
const OpenChat = ({
  chat,
  models,
  sourceNames,
  panel,
  onPanel,
}: {
  chat: ChatSummary;
  models: string[];
  sourceNames: ReadonlyMap<string, SourceName>;
  panel: boolean;
  onPanel: (open: boolean) => void;
}) => {
  const [view, setView] = useState<ChatView>(emptyView);
  const [failure, setFailure] = useState<string>();
  const core = useCore();
  const { t } = useLingui();
  const { composer, ask } = useAsk(chat.id, models);
  useEffect(
    () =>
      followChat(
        core,
        chat.id,
        (update) => {
          setView((before) => applyUpdate(before, update));
        },
        setFailure
      ),
    [core, chat.id]
  );
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section aria-label={chat.title} className="flex min-w-0 flex-1 flex-col">
        <h1 className="sr-only">{chat.title}</h1>
        <ChatThread
          messages={view.messages}
          onRetry={() => {
            if (lastQuestion?.role === "user") {
              void ask(lastQuestion.text);
            }
          }}
          partial={view.partial}
          running={view.running}
        >
          {failure === undefined && view.stopped === null ? null : (
            <div className="flex flex-col gap-2">
              <ErrorText>{failure}</ErrorText>
              <ErrorText>{view.stopped ?? undefined}</ErrorText>
            </div>
          )}
          <HeldWrites chatId={chat.id} version={view.held} />
        </ChatThread>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-4 md:px-6">
          <ChatSources names={sourceNames} provenance={view.provenance} />
          <Composer running={view.running} {...composer} />
          <p className="text-muted-foreground text-center text-xs">
            <Trans>
              Grasp holds every change to an outside system until you confirm
              it.
            </Trans>
          </p>
        </div>
      </section>
      {/* Over the chat, as a drawer, on narrow screens; beside it on wide ones. */}
      {panel ? (
        <aside
          aria-label={t`Side panel`}
          className="bg-background fixed inset-0 z-50 flex flex-col overflow-y-auto lg:static lg:z-auto lg:w-96 lg:shrink-0 lg:border-l"
        >
          <div className="flex flex-none items-center gap-1.5 border-b p-3 lg:hidden">
            <h2 className="flex-1 text-sm font-medium">
              <Trans>Side panel</Trans>
            </h2>
            <Button
              aria-label={t`Close`}
              onClick={() => {
                onPanel(false);
              }}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </div>
          <div className="flex flex-1 flex-col p-4">
            <SidePanel
              chatId={chat.id}
              drafts={view.drafts}
              running={view.running}
            />
          </div>
        </aside>
      ) : null}
    </div>
  );
};

const Chat = () => {
  const page = Route.useLoaderData();
  const { chat: open } = Route.useSearch();
  const { t } = useLingui();
  const [listOpen, setListOpen] = useState(false);
  const [panel, setPanel] = useState(false);
  if (page.state !== "ready") {
    return (
      <>
        <SiteHeader crumbs={[{ label: t`Chat` }]} />
        <div className="p-6">
          <NotLoaded page={page} />
        </div>
      </>
    );
  }
  const { chats, models, sourceNames } = page.data;
  // One past the list's newest opens too, as core finds it (or says why not).
  const chat =
    chats.find(({ id }) => id === open) ??
    (open === undefined
      ? undefined
      : { id: open, title: t`Chat`, createdAt: "", running: false });
  return (
    <>
      <SiteHeader
        actions={
          <>
            <Button
              className="md:hidden"
              onClick={() => {
                setListOpen(true);
              }}
              size="sm"
              variant="outline"
            >
              <PanelLeftIcon data-icon="inline-start" />
              <Trans>Chats</Trans>
            </Button>
            {chat === undefined ? null : (
              <>
                <Button
                  aria-pressed={panel}
                  onClick={() => {
                    setPanel(!panel);
                  }}
                  size="sm"
                  variant="outline"
                >
                  <PanelRightIcon data-icon="inline-start" />
                  {/* On a phone the icon alone, so where the chat is stays in view. */}
                  <span className="max-sm:sr-only">
                    <Trans>Side panel</Trans>
                  </span>
                </Button>
                <Link
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                  search={{}}
                  to="/"
                >
                  <PlusIcon data-icon="inline-start" />
                  {/* On a phone the icon alone, so where the chat is stays in view. */}
                  <span className="max-sm:sr-only">
                    <Trans>New chat</Trans>
                  </span>
                </Link>
              </>
            )}
          </>
        }
        crumbs={
          chat === undefined
            ? [{ label: t`Chat` }]
            : [{ label: t`Chat`, to: "/" }, { label: chat.title }]
        }
      />
      {/* Held to the window, so a tall box at the bottom makes the thread shorter, never the page longer. */}
      <div className="flex min-h-0 flex-1 text-sm">
        <ChatSidebar activeId={chat?.id} chats={chats} />
        {chat === undefined ? (
          <NewChat models={models} />
        ) : (
          <OpenChat
            chat={chat}
            key={chat.id}
            models={models}
            onPanel={setPanel}
            panel={panel}
            sourceNames={sourceNames}
          />
        )}
      </div>
      <Sheet onOpenChange={setListOpen} open={listOpen}>
        <SheetContent closeLabel={t`Close`} side="left">
          <SheetTitle className="sr-only">
            <Trans>Recent chats</Trans>
          </SheetTitle>
          <ChatList
            activeId={chat?.id}
            chats={chats}
            onPick={() => {
              setListOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
};

export const Route = createFileRoute("/_shell/")({
  validateSearch: (search: Record<string, unknown>): { chat?: string } =>
    typeof search.chat === "string" ? { chat: search.chat } : {},
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session): Promise<ChatPage> => {
      const [chats, models, sourceNames] = await Promise.all([
        session.chats.list(),
        session.chats.models(),
        readSourceNames(session),
      ]);
      return { chats, models, sourceNames };
    }),
  component: Chat,
});
