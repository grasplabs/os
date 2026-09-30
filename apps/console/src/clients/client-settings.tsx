/**
 * A client's settings on its page: its ring and sign-in,
 * each saved on its own and audited, and its latest console actions.
 */
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Link, useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { formatTime } from "../releases/format.ts";
import { thenRefresh } from "../use-action.ts";
import { applySettingsFn, setRingFn, setSignInFn } from "./functions.ts";
import type { SettingsChange } from "./functions.ts";
import type { ClientSettingsView, HistoryEntry } from "./queries.ts";
import { Field, SignInFields, signInOf, textOf } from "./sign-in-fields.tsx";
import { useSettingsAction } from "./use-action.ts";

/** Runs `change`, then loads the page again, whether it worked or not. */
const useSave = () => {
  const router = useRouter();
  const { busy, failure, run } = useSettingsAction();
  const save = (change: () => Promise<SettingsChange>) => {
    void run(
      async () =>
        await thenRefresh(change, async () => {
          await router.invalidate({ sync: true });
        })
    );
  };
  return { busy, failure, save };
};

const Failure = ({ failure }: { failure: string | null }) =>
  failure === null ? null : (
    <p role="alert" className="text-destructive text-sm">
      {failure}
    </p>
  );

const Ring = ({ clientId, ring }: { clientId: string; ring: number }) => {
  const { busy, failure, save } = useSave();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const next = Number(textOf(new FormData(event.currentTarget), "ring"));
        save(async () => await setRingFn({ data: { clientId, ring: next } }));
      }}
      className="flex flex-col gap-2"
    >
      <Field
        label="Ring"
        hint="When rollouts reach it: ring 0 first. Rollouts started from now on use it."
      >
        <Input
          // Keyed by the ring: the field starts again from the one loaded
          // after each change.
          key={ring}
          name="ring"
          type="number"
          min={0}
          required
          defaultValue={ring}
          className="max-w-32"
        />
      </Field>
      <div className="flex items-center gap-4">
        <Button type="submit" variant="outline" disabled={busy}>
          Save ring
        </Button>
        <Failure failure={failure} />
      </div>
    </form>
  );
};

const SignIn = ({
  clientId,
  settings,
}: {
  clientId: string;
  settings: ClientSettingsView;
}) => {
  const { busy, failure, save } = useSave();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        save(
          async () =>
            await setSignInFn({ data: { clientId, signIn: signInOf(form) } })
        );
      }}
      className="flex flex-col gap-4"
    >
      <span className="text-sm font-medium">Sign-in</span>
      {settings.signInOverridden ? (
        <p className="text-sm">
          A SIGN_IN setting replaces this on deploy, until it is removed.
        </p>
      ) : null}
      {/* Keyed by what was loaded: the fields start again from it after a save. */}
      <div
        key={JSON.stringify(settings.signIn)}
        className="flex flex-col gap-4"
      >
        <SignInFields current={settings.signIn} />
      </div>
      <div className="flex items-center gap-4">
        <Button type="submit" variant="outline" disabled={busy}>
          Save sign-in
        </Button>
        <Failure failure={failure} />
      </div>
    </form>
  );
};

/**
 * The client's actions whose target is a rollout's id (src/rollout/): the
 * others name a version, a release or nothing.
 */
const rolloutActions: ReadonlySet<string> = new Set([
  "rollout.client_start",
  "rollout.client_done",
  "rollout.client_skip",
  "rollout.client_stop",
  "rollout.rollback",
  "rollout.client_rolled_back",
]);

/** The rollout an action names, to link its page; null for any other. */
const rolloutOf = (entry: HistoryEntry): string | null =>
  rolloutActions.has(entry.action) && z.uuid().safeParse(entry.target).success
    ? entry.target
    : null;

const History = ({ history }: { history: HistoryEntry[] }) =>
  history.length === 0 ? (
    <p className="text-muted-foreground text-sm">Nothing yet.</p>
  ) : (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When (UTC)</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>By</TableHead>
          <TableHead>On</TableHead>
          <TableHead>Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {history.map((entry) => {
          const rolloutId = rolloutOf(entry);
          return (
            <TableRow key={entry.id}>
              <TableCell>{formatTime(entry.at)}</TableCell>
              <TableCell>
                <span className="font-mono">{entry.action}</span>
              </TableCell>
              <TableCell>{entry.actor}</TableCell>
              <TableCell>
                {rolloutId === null ? (
                  <span className="font-mono">{entry.target ?? ""}</span>
                ) : (
                  <Link
                    to="/rollouts/$rolloutId"
                    params={{ rolloutId }}
                    className="font-mono underline-offset-4 hover:underline"
                  >
                    {rolloutId.slice(0, 8)}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <span className="font-mono break-all">
                  {entry.detail ?? ""}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );

/** What waits for the client's next deploy, in words. */
const pendingWords = (settings: ClientSettingsView): string => {
  if (!settings.configPending) {
    return "Its core runs its sign-in as it is. A change reaches it with its next deploy: apply it now, or a rollout that reaches it deploys it.";
  }
  if (settings.pinnedReleaseId !== null) {
    return `Sign-in changed since its last deploy. It's pinned to ${settings.pinnedReleaseId}, so only a rollout of that release reaches it: apply it now.`;
  }
  return "Sign-in changed since its last deploy: apply it now, or the next rollout that reaches it deploys it, even on the release it runs.";
};

/** What waits for the client's next deploy, and applying it now. */
const Apply = ({
  clientId,
  settings,
}: {
  clientId: string;
  settings: ClientSettingsView;
}) => {
  const { busy, failure, save } = useSave();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{pendingWords(settings)}</p>
      {settings.active ? (
        <div className="flex items-center gap-4">
          <Button
            variant={settings.configPending ? "default" : "outline"}
            disabled={busy}
            onClick={() => {
              save(async () => await applySettingsFn({ data: { clientId } }));
            }}
          >
            Apply settings now
          </Button>
          <span className="text-muted-foreground text-sm">
            Deploys the release it runs, live at once. Its deploy shows in
            History.
          </span>
          <Failure failure={failure} />
        </div>
      ) : null}
    </div>
  );
};

/** A client's settings and history, on its page. */
export const ClientSettings = ({
  clientId,
  settings,
  history,
}: {
  clientId: string;
  settings: ClientSettingsView;
  history: HistoryEntry[];
}) => (
  <>
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-8">
          <Apply clientId={clientId} settings={settings} />
          <Ring clientId={clientId} ring={settings.ring} />
          <SignIn clientId={clientId} settings={settings} />
        </div>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
      </CardHeader>
      <CardContent>
        <History history={history} />
      </CardContent>
    </Card>
  </>
);
