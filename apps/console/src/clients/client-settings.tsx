/**
 * A client's settings on its page: its ring, feature flags and sign-in,
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
import { Switch } from "@grasp-os/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Link, useRouter } from "@tanstack/react-router";

import { formatTime } from "../releases/format.ts";
import { InvalidFieldError, thenRefresh } from "../use-action.ts";
import { featureNameSchema } from "./feature-name.ts";
import { setFeatureFn, setRingFn, setSignInFn } from "./functions.ts";
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

const Features = ({
  clientId,
  features,
}: {
  clientId: string;
  features: Record<string, boolean>;
}) => {
  const { busy, failure, save } = useSave();
  const set = (feature: string, on: boolean) => {
    save(async () => await setFeatureFn({ data: { clientId, feature, on } }));
  };
  const names = Object.keys(features).toSorted();
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">Feature flags</span>
      {names.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          None set: every feature behind a flag is off.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {names.map((name) => (
            <li key={name} className="flex items-center gap-3 text-sm">
              <Switch
                checked={features[name] === true}
                disabled={busy}
                aria-label={`Feature ${name}`}
                onCheckedChange={(on) => {
                  set(name, on);
                }}
              />
              <span className="font-mono">{name}</span>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const name = textOf(new FormData(event.currentTarget), "feature");
          save(async () => {
            if (!featureNameSchema.safeParse(name).success) {
              throw new InvalidFieldError(
                "A feature's name is lowercase letters, digits and _, as core names it."
              );
            }
            return await setFeatureFn({
              data: { clientId, feature: name, on: true },
            });
          });
        }}
        className="flex flex-wrap items-center gap-4"
      >
        <Input
          name="feature"
          required
          aria-label="Feature to switch on"
          placeholder="feature_name"
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" disabled={busy}>
          Switch on
        </Button>
      </form>
      <Failure failure={failure} />
    </div>
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

/** A rollout's page, when an action names one. */
const rolloutOf = (entry: HistoryEntry): string | null =>
  entry.action.startsWith("rollout.") && entry.target !== null
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
          <p className="text-sm">
            {settings.configPending
              ? "Flags or sign-in changed since its last deploy: the next rollout deploys it, even on the release it runs."
              : "Flags and sign-in reach its core with its next deploy."}
          </p>
          <Ring clientId={clientId} ring={settings.ring} />
          <Features clientId={clientId} features={settings.features} />
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
