/**
 * A live client's release, on its page: the release it's pinned to, if
 * any, pinning and unpinning it, and its drift, read from its account
 * when staff ask (src/rollout/drift.ts).
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
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { thenRefresh } from "../use-action.ts";
import type { ClientDriftState } from "./drift.ts";
import type { DriftCheck } from "./functions.ts";
import { fetchDrift, pinClientFn } from "./functions.ts";
import { useRolloutAction } from "./use-action.ts";

/** A drift state, in words. */
const driftWords: Readonly<Record<ClientDriftState, string>> = {
  in_sync: "runs what the console made live",
  drifted: "changed outside the console",
  split: "traffic split between versions",
  off_pin: "doesn't run the release it's pinned to",
  unknown: "can't be told: nothing made live yet, or the account didn't answer",
};

/** Whether it runs the shared secrets in Secrets Store now, in words. */
const sharedSecretsWords = (current: boolean | null): string => {
  if (current === null) {
    return "Whether it runs the shared secrets in Secrets Store now can't be told: the store can't be read.";
  }
  return current
    ? "It runs the shared secrets in Secrets Store now."
    : "It doesn't run the shared secrets in Secrets Store now: a secrets rollout brings it up to date.";
};

/** A version's id, short, as the table shows it. */
const shortVersion = (id: string | null): string => id?.slice(0, 8) ?? "";

/** Client `clientId`'s drift, or `failed` when it couldn't be read. Never throws. */
const readDrift = async (
  clientId: string
): Promise<DriftCheck | "failed" | null> => {
  try {
    return await fetchDrift({ data: { clientId } });
  } catch {
    return "failed";
  }
};

/** The client's drift, read when staff ask, and what it says. */
const Drift = ({ clientId }: { clientId: string }) => {
  const [drift, setDrift] = useState<DriftCheck | null>(null);
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState(false);
  const check = async () => {
    setReading(true);
    setFailed(false);
    const read = await readDrift(clientId);
    setReading(false);
    setFailed(read === "failed");
    setDrift(read === "failed" ? null : read);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <Button
          variant="outline"
          disabled={reading}
          onClick={() => {
            void check();
          }}
        >
          Check drift
        </Button>
        {drift === null ? null : (
          <p className="text-sm">{`It ${driftWords[drift.state]}.`}</p>
        )}
        {drift === null ? null : (
          <p className="text-sm">
            {sharedSecretsWords(drift.sharedSecretsCurrent)}
          </p>
        )}
        {failed ? (
          <p role="alert" className="text-destructive text-sm">
            That did not work. Try again.
          </p>
        ) : null}
      </div>
      {drift === null ? null : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Worker</TableHead>
              <TableHead>Made live</TableHead>
              <TableHead>Running</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drift.workers.map((worker) => (
              <TableRow key={worker.worker}>
                <TableCell>{worker.worker}</TableCell>
                <TableCell>
                  <span className="font-mono">
                    {shortVersion(worker.recorded)}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="font-mono">
                    {(worker.live ?? [])
                      .map(
                        ({ version_id, percentage }) =>
                          `${shortVersion(version_id)} ${percentage}%`
                      )
                      .join(", ")}
                  </span>
                </TableCell>
                <TableCell>{driftWords[worker.state]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
};

/** The form's text field `name`, trimmed. */
const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** A live client's release: its pin, and its drift. */
export const ClientRelease = ({
  clientId,
  pinnedReleaseId,
  releases,
}: {
  clientId: string;
  pinnedReleaseId: string | null;
  /** The imported releases, newest first, to pin it to. */
  releases: { id: string; notes: string }[];
}) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  const pin = (releaseId: string | null) => {
    void run(
      async () =>
        await thenRefresh(
          async () => await pinClientFn({ data: { clientId, releaseId } }),
          async () => {
            await router.invalidate({ sync: true });
          }
        )
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Release</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              {pinnedReleaseId === null
                ? "Not pinned: every rollout reaches it."
                : `Pinned to ${pinnedReleaseId}: rollouts of any other release skip it.`}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                pin(textOf(new FormData(event.currentTarget), "releaseId"));
              }}
              className="flex flex-wrap items-center gap-4"
            >
              <Input
                // Keyed by the pin: the field starts again from the pin
                // loaded after each change, not the one it showed first.
                key={pinnedReleaseId ?? ""}
                name="releaseId"
                list="pin-release-ids"
                required
                aria-label="Release to pin it to"
                defaultValue={pinnedReleaseId ?? releases[0]?.id ?? ""}
                className="max-w-xs"
              />
              <datalist id="pin-release-ids">
                {releases.map((release) => (
                  <option key={release.id} value={release.id}>
                    {release.notes}
                  </option>
                ))}
              </datalist>
              <Button type="submit" disabled={busy}>
                Pin
              </Button>
              {pinnedReleaseId === null ? null : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    pin(null);
                  }}
                >
                  Unpin
                </Button>
              )}
            </form>
            {failure === null ? null : (
              <p role="alert" className="text-destructive text-sm">
                {failure}
              </p>
            )}
          </div>
          <Drift clientId={clientId} />
        </div>
      </CardContent>
    </Card>
  );
};
