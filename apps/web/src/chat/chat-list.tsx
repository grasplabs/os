import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Input } from "@grasp-os/ui/components/input";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  EllipsisIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import {
  PageSidebar,
  PageSidebarTop,
  RailButton,
  RailDivider,
  RailExpand,
  usePageSidebarFold,
} from "../frame/page-sidebar.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The person's chats beside the open one, in the page sidebar
// (grasplabs/prototype `components/chat/chat-list.tsx`): a new chat with
// the fold beside it, then the past ones by when they were started;
// folded, a rail of icons. Each chat's menu renames or deletes it. Read
// from core alone: nothing about them is kept in the browser.

type Period = "today" | "week" | "earlier";

const periodLabel: Record<Period, MessageDescriptor> = {
  today: msg({ message: "Today", context: "chats from today" }),
  week: msg({ message: "Last 7 days", context: "chats from the past week" }),
  earlier: msg({ message: "Earlier", context: "older chats" }),
};

/** How many recent chats the folded rail shows as icons. */
const onRail = 6;

const aDay = 24 * 60 * 60 * 1000;

/** When the day `date` falls on began, here. */
const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Whole days between the day `iso` fell on and today, here. */
const daysAgo = (iso: string, now: Date): number =>
  Math.round((startOfDay(now) - startOfDay(new Date(iso))) / aDay);

const periodOf = (days: number): Period => {
  if (days <= 0) {
    return "today";
  }
  return days < 7 ? "week" : "earlier";
};

/** The chats by period, each newest first, in the order core lists them. */
const groupChats = (
  chats: readonly ChatSummary[],
  now: Date
): { period: Period; chats: ChatSummary[] }[] => {
  const groups = new Map<Period, ChatSummary[]>();
  for (const chat of chats) {
    const period = periodOf(daysAgo(chat.createdAt, now));
    groups.set(period, [...(groups.get(period) ?? []), chat]);
  }
  return (["today", "week", "earlier"] as const).flatMap((period) => {
    const inPeriod = groups.get(period);
    return inPeriod === undefined ? [] : [{ period, chats: inPeriod }];
  });
};

/** When a chat was started, as short as the list has room for. */
const useWhen = (): ((iso: string) => string) => {
  const { t, i18n } = useLingui();
  const now = new Date();
  return (iso) => {
    const days = daysAgo(iso, now);
    if (days <= 0) {
      return new Date(iso).toLocaleTimeString(i18n.locale, {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    if (days === 1) {
      return t({ message: "Yesterday", context: "when a chat was started" });
    }
    return new Date(iso).toLocaleDateString(i18n.locale, {
      day: "numeric",
      month: "short",
    });
  };
};

/** Renames a chat, in a dialog. */
const RenameDialog = ({
  chat,
  open,
  onOpenChange,
}: {
  chat: ChatSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [title, setTitle] = useState(chat.title);
  const valid = chatTitleSchema.safeParse(title).success;
  const save = async (): Promise<void> => {
    const saved = await run(async (session) => {
      await session.chats.rename(chat.id, title);
      return true;
    });
    if (saved === true) {
      onOpenChange(false);
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Rename this chat</Trans>
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          id={`rename-${chat.id}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !busy) {
              void save();
            }
          }}
        >
          <label className="text-sm" htmlFor={`chat-title-${chat.id}`}>
            <Trans>Title</Trans>
          </label>
          <Input
            id={`chat-title-${chat.id}`}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            value={title}
          />
          <ErrorText>{failure}</ErrorText>
        </form>
        <DialogFooter showCloseButton>
          <Button
            disabled={busy || !valid}
            form={`rename-${chat.id}`}
            type="submit"
          >
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Deletes a chat, once the person confirms. */
const DeleteDialog = ({
  chat,
  open,
  onOpenChange,
}: {
  chat: ChatSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const { title } = chat;
  const remove = async (): Promise<void> => {
    const removed = await run(async (session) => {
      await session.chats.remove(chat.id);
      return true;
    });
    if (removed === true) {
      onOpenChange(false);
      await navigate({ to: "/", search: {} });
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Delete “{title}”?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          <Trans>
            Its messages are deleted for good, and every change its agent holds
            for you is rejected. What the agent did stays in the audit log.
          </Trans>
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
            <Trans>Delete</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** One chat in the list: its title, when it was started, and its menu. */
const ChatItem = ({
  chat,
  active,
  when,
  onPick,
}: {
  chat: ChatSummary;
  active: boolean;
  when: string;
  onPick?: () => void;
}) => {
  const { t } = useLingui();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { title } = chat;
  return (
    <li className="group/chat relative">
      <Link
        aria-current={active ? "page" : undefined}
        className={
          active
            ? "bg-accent focus-visible:ring-ring flex w-full items-start gap-2.5 rounded-lg px-2 py-2 pr-9 text-left outline-none focus-visible:ring-2"
            : "hover:bg-muted focus-visible:ring-ring flex w-full items-start gap-2.5 rounded-lg px-2 py-2 pr-9 text-left outline-none focus-visible:ring-2"
        }
        onClick={onPick}
        search={{ chat: chat.id }}
        to="/"
      >
        <MessageSquareIcon
          aria-hidden="true"
          className="text-muted-foreground mt-0.5 size-4 flex-none"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{title}</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {when}
          </span>
        </span>
      </Link>
      <span className="absolute top-1.5 right-1.5 opacity-0 group-hover/chat:opacity-100 focus-within:opacity-100 has-aria-expanded:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t`More for ${title}`}
            render={<Button size="icon-xs" variant="ghost" />}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setRenaming(true);
              }}
            >
              <PencilIcon />
              <Trans>Rename</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setDeleting(true);
              }}
              variant="destructive"
            >
              <Trash2Icon />
              <Trans>Delete</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {renaming ? (
        <RenameDialog chat={chat} onOpenChange={setRenaming} open={renaming} />
      ) : null}
      {deleting ? (
        <DeleteDialog chat={chat} onOpenChange={setDeleting} open={deleting} />
      ) : null}
    </li>
  );
};

/**
 * The list itself: a new chat with the fold beside it, then the chats by
 * when they were started. In the sheet on a narrow screen there is no
 * fold, and a pick closes the sheet.
 */
export const ChatList = ({
  chats,
  activeId,
  fold,
  onPick,
}: {
  chats: readonly ChatSummary[];
  activeId: string | undefined;
  fold?: { label: string; onFold: () => void };
  onPick?: () => void;
}) => {
  const { t, i18n } = useLingui();
  const when = useWhen();
  const groups = groupChats(chats, new Date());
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <PageSidebarTop fold={fold}>
        <Link
          className={buttonVariants({ variant: "outline" })}
          onClick={onPick}
          search={{}}
          to="/"
        >
          <PlusIcon data-icon="inline-start" />
          <Trans>New chat</Trans>
        </Link>
      </PageSidebarTop>
      <nav
        aria-label={t`Recent chats`}
        className="min-h-0 flex-1 overflow-auto p-3"
      >
        {groups.length === 0 ? (
          <p className="text-muted-foreground px-1 py-2">
            <Trans>Your chats show up here.</Trans>
          </p>
        ) : (
          groups.map((group) => (
            <section
              aria-label={i18n._(periodLabel[group.period])}
              className="flex flex-col gap-0.5 pt-3 first:pt-0"
              key={group.period}
            >
              <h3 className="text-muted-foreground px-2 pb-1 text-xs">
                {i18n._(periodLabel[group.period])}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {group.chats.map((chat) => (
                  <ChatItem
                    active={chat.id === activeId}
                    chat={chat}
                    key={chat.id}
                    onPick={onPick}
                    when={when(chat.createdAt)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>
    </div>
  );
};

/** The chats in the page sidebar, open or folded to its rail. */
export const ChatSidebar = ({
  chats,
  activeId,
}: {
  chats: readonly ChatSummary[];
  activeId: string | undefined;
}) => {
  const { t } = useLingui();
  const [folded, setFolded] = usePageSidebarFold("chat");
  if (folded) {
    return (
      <PageSidebar folded label={t`Recent chats`}>
        <RailExpand
          label={t`Expand the chats`}
          onExpand={() => {
            setFolded(false);
          }}
        />
        <RailButton label={t`New chat`} render={<Link search={{}} to="/" />}>
          <PlusIcon />
        </RailButton>
        <RailDivider />
        {chats.slice(0, onRail).map((chat) => (
          <RailButton
            active={chat.id === activeId}
            key={chat.id}
            label={chat.title}
            render={<Link search={{ chat: chat.id }} to="/" />}
          >
            <MessageSquareIcon />
          </RailButton>
        ))}
      </PageSidebar>
    );
  }
  return (
    <PageSidebar folded={false} label={t`Recent chats`}>
      <ChatList
        activeId={activeId}
        chats={chats}
        fold={{
          label: t`Fold the chats`,
          onFold: () => {
            setFolded(true);
          },
        }}
      />
    </PageSidebar>
  );
};
