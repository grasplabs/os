import { Button } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import type { ReactElement, ReactNode } from "react";

import { keepFolded, readFolded } from "../fold.ts";

// The column beside a page's content, the same on every page that has one
// (Chat, Knowledge): 288px open, with the page's first choice in its top
// row and the button that folds it beside that; folded, a 48px rail of
// icons as wide as the site header's square for the sidebar trigger, so its
// edge continues the line beside that trigger and nothing moves when it
// folds. On a phone neither shows: the page offers its list in a sheet.
// From the prototype's components/page-sidebar.tsx.

/** From this width the window holds the app's sidebar, a page sidebar and the page side by side; narrower, a page sidebar starts folded. */
const roomyQuery = "(min-width: 1280px)";

const onRoomy = (onChange: () => void): (() => void) => {
  const query = matchMedia(roomyQuery);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
};

const isRoomy = (): boolean => matchMedia(roomyQuery).matches;

/**
 * Whether a page's sidebar is folded, kept as the person left it in this
 * browser (a cookie, `page` naming it, e.g. "chat"). Until they choose, it
 * is open on a roomy window and folded on a narrow one.
 */
export const usePageSidebarFold = (
  page: string
): [boolean, (folded: boolean) => void] => {
  const roomy = useSyncExternalStore(onRoomy, isRoomy);
  const [choice, setChoice] = useState(() => readFolded(page));
  const setFolded = (folded: boolean): void => {
    setChoice(folded);
    void keepFolded(page, folded);
  };
  return [choice ?? !roomy, setFolded];
};

/** The sidebar itself, named `label`: open, or folded to its rail. */
export const PageSidebar = ({
  folded,
  label,
  children,
}: {
  folded: boolean;
  label: string;
  children: ReactNode;
}) => (
  <aside
    aria-label={label}
    className={
      folded
        ? "hidden w-12 flex-none flex-col items-center gap-1 overflow-y-auto border-r py-3 md:flex"
        : "hidden w-72 flex-none flex-col border-r md:flex"
    }
  >
    {children}
  </aside>
);

/** A button named by its tooltip: the fold, and the rail's entries. With `render` it is a link. */
export const RailButton = ({
  label,
  active = false,
  onClick,
  render,
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  render?: ReactElement;
  children: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          aria-current={active ? "page" : undefined}
          aria-label={label}
          nativeButton={render === undefined}
          onClick={onClick}
          render={render}
          size="icon"
          variant={active ? "secondary" : "ghost"}
        />
      }
    >
      {children}
    </TooltipTrigger>
    <TooltipContent className="max-w-64" side="right">
      {label}
    </TooltipContent>
  </Tooltip>
);

/**
 * The top row: the page's first choice or a heading, and the fold beside
 * it, where the rail's first button sits. A line sets it apart from the
 * rest, unless the rest continues it as one list (`joined`).
 */
export const PageSidebarTop = ({
  children,
  fold,
  joined = false,
}: {
  children: ReactNode;
  fold?: { label: string; onFold: () => void };
  joined?: boolean;
}) => (
  <div
    className={
      joined
        ? "flex flex-none items-center gap-1.5 px-3 pt-3"
        : "flex flex-none items-center gap-1.5 border-b p-3"
    }
  >
    <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    {fold === undefined ? null : (
      <RailButton
        label={fold.label}
        onClick={() => {
          fold.onFold();
        }}
      >
        <PanelLeftCloseIcon />
      </RailButton>
    )}
  </div>
);

/** What the open sidebar holds under its top row; it scrolls on its own. */
export const PageSidebarBody = ({
  children,
  joined = false,
}: {
  children: ReactNode;
  joined?: boolean;
}) => (
  <div
    className={
      joined
        ? "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-0.5 pb-3"
        : "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-3"
    }
  >
    {children}
  </div>
);

/** The rail's first button: open the sidebar again. */
export const RailExpand = ({
  label,
  onExpand,
}: {
  label: string;
  onExpand: () => void;
}) => (
  <RailButton label={label} onClick={onExpand}>
    <PanelLeftOpenIcon />
  </RailButton>
);

/** A short line between groups in the rail. */
export const RailDivider = () => (
  <span aria-hidden="true" className="bg-border my-1.5 h-px w-6" />
);
