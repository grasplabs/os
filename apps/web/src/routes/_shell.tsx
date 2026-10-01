import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { loadCoreStatus, signOut } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import { LanguagePicker } from "../language-picker.tsx";
import { NotificationsLink } from "../notifications/nav-link.tsx";
import { RouteError } from "../route-error.tsx";
import { signInErrorSearch } from "../sign-in-errors.ts";

// The signed-in product: a nav of its sections beside the page. Everyone
// else goes to the sign-in page, which sends them back here once they're
// in. The nav only leaves out what a role can't use; core checks the role
// on every call whatever the nav shows.

interface Section {
  to:
    | "/"
    | "/knowledge"
    | "/apps"
    | "/workflows"
    | "/connections"
    | "/activity"
    | "/models"
    | "/members";
  label: MessageDescriptor;
  /** Whether the section is in `person`'s nav. */
  shows: (person: Identity) => boolean;
}

const everyone = (): boolean => true;
const admins = ({ role }: Identity): boolean => isAdmin(role);

const sections: readonly Section[] = [
  { to: "/", label: msg`Chat`, shows: everyone },
  { to: "/knowledge", label: msg`Knowledge`, shows: everyone },
  { to: "/apps", label: msg`Apps`, shows: everyone },
  { to: "/workflows", label: msg`Workflows`, shows: everyone },
  { to: "/connections", label: msg`Connections`, shows: everyone },
  { to: "/activity", label: msg`Activity`, shows: admins },
  { to: "/models", label: msg`Models`, shows: admins },
  // Members are for the organization's own admins, never Grasp staff.
  {
    to: "/members",
    label: msg`Members`,
    shows: (person) => admins(person) && !person.staff,
  },
];

const Shell = () => {
  const { core, identity } = Route.useRouteContext();
  const { t, i18n } = useLingui();
  const role = roleLabel(identity.role);
  return (
    <div className="flex h-svh">
      <nav
        aria-label={t`Main`}
        className="flex w-56 shrink-0 flex-col gap-4 border-r p-3"
      >
        <ul className="flex flex-col gap-1">
          {sections
            .filter(({ shows }) => shows(identity))
            .map(({ to, label }) => (
              <li key={to}>
                <Link
                  to={to}
                  activeOptions={{ exact: to === "/" }}
                  activeProps={{ className: "bg-muted" }}
                  className={buttonVariants({
                    variant: "ghost",
                    className: "w-full justify-start",
                  })}
                >
                  {i18n._(label)}
                </Link>
              </li>
            ))}
          <NotificationsLink />
        </ul>
        <div className="mt-auto flex flex-col gap-2">
          <LanguagePicker />
          <p className="text-sm">
            {identity.name}
            <span className="text-muted-foreground block text-xs">
              {identity.staff
                ? t`${role}, Grasp staff`
                : roleLabel(identity.role)}
            </span>
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void signOut(core);
            }}
          >
            <Trans>Sign out</Trans>
          </Button>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
};

/** Core failed or stayed out of reach while the shell asked who is in. */
class CoreUnreachableError extends Error {
  constructor() {
    // Not shown: ShellError says it in the page's language.
    super("Grasp can't be reached right now.");
    this.name = "CoreUnreachableError";
  }
}

/**
 * Says core can't be reached, with a way to ask again (not a fault, so
 * not reported); any other error as every page shows it.
 */
const ShellError = ({ error, reset, info }: ErrorComponentProps) => {
  const router = useRouter();
  const trying = useRouterState({ select: (state) => state.isLoading });
  const { t } = useLingui();
  if (!(error instanceof CoreUnreachableError)) {
    return <RouteError error={error} reset={reset} info={info} />;
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-medium">Grasp</h1>
      {/* Gone while trying, so the alert is announced again if it fails. */}
      {trying ? null : (
        <ErrorText>
          {t`Grasp can't be reached right now. Try again in a moment.`}
        </ErrorText>
      )}
      <Button
        variant="outline"
        disabled={trying}
        onClick={() => {
          void router.invalidate();
        }}
      >
        {trying ? t`Trying again…` : t`Try again`}
      </Button>
    </main>
  );
};

export const Route = createFileRoute("/_shell")({
  // Before any page's loader, so each runs for someone signed in, with
  // their identity in its context.
  beforeLoad: async ({ context: { core }, location }) => {
    const { connected, identity } = await loadCoreStatus(core);
    if (!connected) {
      // Nobody can tell who is signed in: sending them to sign in again
      // would say they were signed out.
      throw new CoreUnreachableError();
    }
    if (identity === undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({
        to: "/sign-in",
        search: {
          returnTo: location.pathname,
          // A refused sign-in comes back here, as `error=<code>`.
          ...signInErrorSearch(location.search),
        },
      });
    }
    return { identity };
  },
  component: Shell,
  errorComponent: ShellError,
});
