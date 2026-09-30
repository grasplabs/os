import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Conversation } from "../chat/conversation.tsx";
import { applyUpdate, emptyView, followChat } from "../chat/follow-chat.ts";
import type { ChatView } from "../chat/follow-chat.ts";
import { HeldWrites } from "../chat/held-writes.tsx";
import { SidePanel } from "../chat/side-panel.tsx";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Chat with the organization's agent: the person's chats beside the one open,
// its messages streaming in as the agent writes them, the changes it holds
// for the person to confirm, and a side panel. Functional only.

interface ChatPage {
  chats: ChatSummary[];
  /** The models a question may name, the default first. */
  models: string[];
  /** The collections' and connections' names, by ID, for provenance. */
  sourceNames: ReadonlyMap<string, string>;
}

/**
 * The names of the collections and connections the person can see, by
 * ID: a list refused only leaves those IDs unnamed.
 */
const readSourceNames = async (
  session: Session
): Promise<ReadonlyMap<string, string>> => {
  const [collections, connections] = await Promise.allSettled([
    session.knowledge.listCollections(),
    session.connections.list(),
  ]);
  const names = new Map<string, string>();
  if (collections.status === "fulfilled") {
    for (const { id, name } of collections.value) {
      names.set(id, name);
    }
  }
  if (connections.status === "fulfilled") {
    for (const { id, provider, accountName } of connections.value) {
      names.set(
        id,
        accountName === null ? provider : `${provider} (${accountName})`
      );
    }
  }
  return names;
};

/** A new chat's title: the start of its first question. */
const titleOf = (question: string): string => {
  const line = question.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/** Asks a question: in `chatId`, or in a new chat named after it. */
const Composer = ({
  chatId,
  models,
  running,
}: {
  chatId?: string;
  models: string[];
  running: boolean;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState("");
  const [model, setModel] = useState(models[0] ?? "");
  const items = models.map((value) => ({ value, label: value }));
  const send = async (): Promise<void> => {
    const question = text;
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
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="sr-only" htmlFor="chat-question">
        Your question
      </label>
      <Textarea
        id="chat-question"
        onChange={(event) => {
          setText(event.target.value);
        }}
        placeholder="Describe what you want"
        value={text}
      />
      <div className="flex items-center gap-2">
        <Select
          items={items}
          onValueChange={(value: string | null) => {
            if (value !== null) {
              setModel(value);
            }
          }}
          value={model}
        >
          <SelectTrigger aria-label="Model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {running ? (
          <Button
            disabled={busy}
            onClick={() => {
              void stop();
            }}
            type="button"
            variant="outline"
          >
            Stop
          </Button>
        ) : (
          <Button
            disabled={busy || text.trim() === "" || model === ""}
            type="submit"
          >
            Send
          </Button>
        )}
      </div>
      {models.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No model is set up for this deployment yet.
        </p>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

/** Renames the chat. */
const RenameChat = ({ chat }: { chat: ChatSummary }) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const valid = chatTitleSchema.safeParse(title).success;
  const save = async (): Promise<void> => {
    const saved = await run(async (session) => {
      await session.chats.rename(chat.id, title);
      return true;
    });
    if (saved === true) {
      setOpen(false);
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="ghost" />}>
        Rename
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename this chat</DialogTitle>
        </DialogHeader>
        <label className="text-sm" htmlFor="chat-title">
          Title
        </label>
        <Input
          id="chat-title"
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          value={title}
        />
        <ErrorText>{failure}</ErrorText>
        <DialogFooter showCloseButton>
          <Button
            disabled={busy || !valid}
            onClick={() => {
              void save();
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Deletes the chat, once the person confirms. */
const DeleteChat = ({ chat }: { chat: ChatSummary }) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const remove = async (): Promise<void> => {
    const removed = await run(async (session) => {
      await session.chats.remove(chat.id);
      return true;
    });
    if (removed === true) {
      setOpen(false);
      await navigate({ to: "/", search: {} });
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="ghost" />}>
        Delete
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{chat.title}”?</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          Its messages are deleted for good, and every change its agent holds
          for you is rejected. What the agent did stays in the audit log.
        </p>
        <ErrorText>{failure}</ErrorText>
        <DialogFooter showCloseButton>
          <Button
            disabled={busy}
            onClick={() => {
              void remove();
            }}
            variant="destructive"
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** What the chat's answers may hold, as a label. */
const Provenance = ({
  view,
  names,
}: {
  view: ChatView;
  names: ReadonlyMap<string, string>;
}) => {
  const { sources, restricted } = view.provenance;
  if (sources.length === 0 && !restricted) {
    return null;
  }
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
      {restricted ? <Badge variant="destructive">Restricted</Badge> : null}
      {sources.length === 0 ? null : (
        <span>
          Answers may hold data from:{" "}
          {sources.map((id) => names.get(id) ?? id).join(", ")}
        </span>
      )}
    </p>
  );
};

/** One chat, followed as it streams. */
const OpenChat = ({
  chat,
  models,
  sourceNames,
}: {
  chat: ChatSummary;
  models: string[];
  sourceNames: ReadonlyMap<string, string>;
}) => {
  const [view, setView] = useState<ChatView>(emptyView);
  const [failure, setFailure] = useState<string>();
  const [panel, setPanel] = useState(false);
  const core = useCore();
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
  return (
    <div className="flex min-h-0 flex-1">
      <section
        aria-label={chat.title}
        className="flex min-w-0 flex-1 flex-col gap-3 p-4"
      >
        <header className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-medium">{chat.title}</h1>
            <RenameChat chat={chat} />
            <DeleteChat chat={chat} />
            <Button
              aria-pressed={panel}
              className="ml-auto"
              onClick={() => {
                setPanel(!panel);
              }}
              size="sm"
              variant="outline"
            >
              Side panel
            </Button>
          </div>
          <Provenance names={sourceNames} view={view} />
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <ErrorText>{failure}</ErrorText>
          <Conversation
            messages={view.messages}
            partial={view.partial}
            running={view.running}
          />
          {view.running && view.partial === null ? (
            <output className="text-muted-foreground text-sm">Working…</output>
          ) : null}
          <ErrorText>{view.stopped ?? undefined}</ErrorText>
          <HeldWrites chatId={chat.id} version={view.held} />
        </div>
        <Composer chatId={chat.id} models={models} running={view.running} />
      </section>
      {/* Over the chat, as a drawer, on narrow screens; beside it on wide ones. */}
      {panel ? (
        <aside
          aria-label="Side panel"
          className="bg-background fixed inset-0 z-50 flex flex-col gap-2 overflow-y-auto p-4 lg:static lg:z-auto lg:w-96 lg:shrink-0 lg:border-l"
        >
          <Button
            className="self-end lg:hidden"
            onClick={() => {
              setPanel(false);
            }}
            size="sm"
            variant="outline"
          >
            Close
          </Button>
          <SidePanel
            chatId={chat.id}
            drafts={view.drafts}
            running={view.running}
          />
        </aside>
      ) : null}
    </div>
  );
};

const Chat = () => {
  const page = Route.useLoaderData();
  const { chat: open } = Route.useSearch();
  if (page.state !== "ready") {
    return (
      <main className="p-6">
        <NotLoaded page={page} />
      </main>
    );
  }
  const { chats, models, sourceNames } = page.data;
  // One past the list's newest opens too, as core finds it (or says why not).
  const chat =
    chats.find(({ id }) => id === open) ??
    (open === undefined
      ? undefined
      : { id: open, title: "Chat", createdAt: "", running: false });
  return (
    <main className="flex h-full min-h-0">
      <nav
        aria-label="Chats"
        className="flex w-60 shrink-0 flex-col gap-2 border-r p-3"
      >
        <Link
          className={buttonVariants({ variant: "outline" })}
          search={{}}
          to="/"
        >
          New chat
        </Link>
        <ul className="flex flex-col gap-1 overflow-y-auto">
          {chats.map(({ id, title }) => (
            <li key={id}>
              <Link
                activeOptions={{ includeSearch: true }}
                activeProps={{ className: "bg-muted" }}
                className={buttonVariants({
                  variant: "ghost",
                  className: "w-full justify-start truncate",
                })}
                search={{ chat: id }}
                to="/"
              >
                {title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {chat === undefined ? (
        <section
          aria-labelledby="new-chat"
          className="flex flex-1 flex-col gap-3 p-4"
        >
          <h1 className="text-lg font-medium" id="new-chat">
            New chat
          </h1>
          <p className="text-muted-foreground mt-auto text-sm">
            Describe what you want. The agent answers from what it can read, and
            holds every change to an outside system until you confirm it.
          </p>
          <Composer models={models} running={false} />
        </section>
      ) : (
        <OpenChat
          chat={chat}
          key={chat.id}
          models={models}
          sourceNames={sourceNames}
        />
      )}
    </main>
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
