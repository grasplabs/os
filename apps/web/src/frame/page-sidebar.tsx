import { Button } from "@grasp-os/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { useIsMobile } from "@grasp-os/ui/hooks/use-mobile";
import { useLingui } from "@lingui/react/macro";
import {
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PanelLeftOpenIcon,
} from "lucide-react";
import {
  createContext,
  use,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactElement, ReactNode } from "react";

import { keepFolded, readFolded } from "../fold.ts";

// The column beside a page's content (Chat's list, Knowledge's tree): open,
// 288px with the page's first choices in its top row and the fold beside
// them; folded, a 48px rail of the same entries as icons, as wide as the
// site header's square for the sidebar trigger, so its edge continues the
// line beside that trigger and nothing moves when it folds. On a phone it
// is a sheet, opened by the page's PageSidebarTrigger.

/** From this width the window holds the app's sidebar, a page sidebar and the page side by side. */
const roomyQuery = "(min-width: 1280px)";

const onRoomy = (onChange: () => void): (() => void) => {
  const query = matchMedia(roomyQuery);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
};

const isRoomy = (): boolean => matchMedia(roomyQuery).matches;

interface PageSidebarState {
  /** Folded to its rail; never on a phone, where it is a sheet. */
  folded: boolean;
  setFolded: (folded: boolean) => void;
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  isMobile: boolean;
}

const PageSidebarContext = createContext<PageSidebarState | null>(null);

const usePageSidebar = (): PageSidebarState => {
  const state = use(PageSidebarContext);
  if (state === null) {
    throw new Error("A page sidebar's part is outside PageSidebarProvider.");
  }
  return state;
};

/**
 * Holds a page sidebar's state for the sidebar and the page's trigger.
 * `name` keeps its fold apart from other pages' (e.g. "chat"): it stays as
 * the person left it in this browser; until they choose, it is open on a
 * roomy window and folded on a narrow one.
 */
export const PageSidebarProvider = ({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) => {
  const roomy = useSyncExternalStore(onRoomy, isRoomy);
  const isMobile = useIsMobile();
  const [choice, setChoice] = useState(() => readFolded(name));
  const [sheetOpen, setSheetOpen] = useState(false);
  const state: PageSidebarState = {
    folded: !isMobile && (choice ?? !roomy),
    setFolded: (folded) => {
      setChoice(folded);
      void keepFolded(name, folded);
    },
    sheetOpen,
    setSheetOpen,
    isMobile,
  };
  return (
    // The React Compiler memoizes the value; nothing here does by hand (AGENTS.md).
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <PageSidebarContext value={state}>
      <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
    </PageSidebarContext>
  );
};

/** A button named by its tooltip: the rail's entries and the fold. */
const IconButton = ({
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
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
);

/** The sidebar, named `label`: its top row and sections are its children. */
export const PageSidebar = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => {
  const { folded, isMobile, sheetOpen, setSheetOpen } = usePageSidebar();
  const { t } = useLingui();
  if (isMobile) {
    return (
      <Sheet onOpenChange={setSheetOpen} open={sheetOpen}>
        <SheetContent closeLabel={t`Close`} side="left">
          <SheetHeader className="sr-only">
            <SheetTitle>{label}</SheetTitle>
          </SheetHeader>
          <nav aria-label={label} className="flex min-h-0 flex-1 flex-col">
            {children}
          </nav>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <nav
      aria-label={label}
      className={
        folded
          ? "flex w-12 flex-none flex-col items-center gap-1 overflow-y-auto border-r py-2"
          : "flex w-72 flex-none flex-col overflow-y-auto border-r"
      }
    >
      {children}
    </nav>
  );
};

/**
 * The top row: the page's first choices (entries) and the fold beside
 * them. Folded, the rail starts with the button that opens it again, then
 * those choices.
 */
export const PageSidebarTop = ({ children }: { children: ReactNode }) => {
  const { folded, setFolded, isMobile } = usePageSidebar();
  const { t } = useLingui();
  if (folded) {
    return (
      <>
        <IconButton
          label={t`Open the sidebar`}
          onClick={() => {
            setFolded(false);
          }}
        >
          <PanelLeftOpenIcon />
        </IconButton>
        <ul className="flex flex-col items-center gap-1">{children}</ul>
      </>
    );
  }
  return (
    <div className="flex flex-none items-center gap-1.5 border-b p-2">
      <ul className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</ul>
      {isMobile ? null : (
        <IconButton
          label={t`Fold the sidebar`}
          onClick={() => {
            setFolded(true);
          }}
        >
          <PanelLeftCloseIcon />
        </IconButton>
      )}
    </div>
  );
};

/** A group of entries; folded, a short line sets it apart. */
export const PageSidebarSection = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => {
  const { folded } = usePageSidebar();
  const id = useId();
  if (folded) {
    return (
      <>
        <span aria-hidden="true" className="bg-border my-1.5 h-px w-6" />
        <ul aria-label={label} className="flex flex-col items-center gap-1">
          {children}
        </ul>
      </>
    );
  }
  return (
    <section aria-labelledby={id} className="flex flex-col gap-0.5 p-2">
      <h2
        className="text-muted-foreground px-2 py-1.5 text-xs font-medium"
        id={id}
      >
        {label}
      </h2>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
};

/**
 * One entry: its icon and label, or folded only its icon, named by its
 * tooltip. With `render` it is a link, e.g. `render={<Link to="/" />}`.
 * Choosing one on a phone closes the sheet.
 */
export const PageSidebarEntry = ({
  icon,
  label,
  active = false,
  onClick,
  render,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  render?: ReactElement;
}) => {
  const { folded, setSheetOpen } = usePageSidebar();
  const choose = (): void => {
    setSheetOpen(false);
    onClick?.();
  };
  if (folded) {
    return (
      <li>
        <IconButton
          active={active}
          label={label}
          onClick={choose}
          render={render}
        >
          {icon}
        </IconButton>
      </li>
    );
  }
  return (
    <li>
      <Button
        aria-current={active ? "page" : undefined}
        className="w-full justify-start"
        nativeButton={render === undefined}
        onClick={choose}
        render={render}
        variant={active ? "secondary" : "ghost"}
      >
        {icon}
        <span className="truncate">{label}</span>
      </Button>
    </li>
  );
};

/** On a phone, opens the page's sidebar; elsewhere it isn't shown. */
export const PageSidebarTrigger = ({ label }: { label: string }) => {
  const { isMobile, setSheetOpen } = usePageSidebar();
  if (!isMobile) {
    return null;
  }
  return (
    <IconButton
      label={label}
      onClick={() => {
        setSheetOpen(true);
      }}
    >
      <PanelLeftIcon />
    </IconButton>
  );
};
