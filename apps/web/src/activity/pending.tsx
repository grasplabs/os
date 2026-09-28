import { builtinOwner } from "@grasp-os/shared/apps";
import type { Permission } from "@grasp-os/shared/permissions";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import {
  appName,
  appsById,
  formatTime,
  personName,
  readPeople,
} from "../directory.ts";
import type { Directory } from "../directory.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Pending approvals: the permissions Apps and agents asked for, which an
// admin grants or rejects. Core checks the role on every call; the page
// offers the decision only to those core lets decide (the organization's
// own admins, never Grasp staff), and leaves out the built-in blueprints'
// requests, which say what the Apps created from them ask for and are
// decided on those Apps.

/** The requests an admin decides, oldest first, with the names to show. */
export interface PendingRequests {
  requests: Permission[];
  directory: Directory;
}

/** Whether a request is a built-in blueprint's own, decided on its copies. */
const isBuiltins = ({ subject }: Permission, directory: Directory): boolean =>
  subject.type === "app" &&
  directory.apps.get(subject.appId)?.owner === builtinOwner;

/**
 * Every request waiting for an admin, oldest first as core lists them. The
 * Apps are read in full, not only for names: they say which requests are
 * the built-ins' and which version an admin reviews, so the tab fails
 * without them rather than offer the wrong decisions.
 */
export const readPendingRequests = async (
  session: Session
): Promise<PendingRequests> => {
  const [requested, apps, people] = await Promise.all([
    session.permissions.list(undefined, "requested"),
    session.apps.list(),
    readPeople(session),
  ]);
  const directory = { people, apps: appsById(apps) };
  const requests = requested.filter(
    (permission) => !isBuiltins(permission, directory)
  );
  return { requests, directory };
};

/** Who asks: the App or agent the permission is for. */
const subjectOf = ({ subject }: Permission, directory: Directory): string =>
  subject.type === "app"
    ? appName(directory, subject.appId)
    : `Agent ${subject.agentId}`;

/** What it asks for, by ID: connections and collections have no names here. */
const objectOf = ({ object }: Permission, directory: Directory): string => {
  if (object.type === "connection") {
    const within = object.resource === undefined ? "" : `, ${object.resource}`;
    const masked =
      object.mask === undefined ? "" : ` (hides ${object.mask.join(", ")})`;
    return `Connection ${object.connectionId}${within}${masked}`;
  }
  if (object.type === "collection") {
    return `Collection ${object.collectionId}`;
  }
  return `Workflow ${object.workflowId} of ${appName(directory, object.appId)}`;
};

/**
 * The version of the App an admin reviews as they decide: the one current
 * now, whose code the grant trusts.
 */
const reviewedVersion = (
  { subject }: Permission,
  directory: Directory
): string => {
  if (subject.type !== "app") {
    return "–";
  }
  const app = directory.apps.get(subject.appId);
  if (app === undefined) {
    return "Unknown";
  }
  return app.currentVersion === null
    ? "None current"
    : String(app.currentVersion);
};

/** What a decision did, with a way to find it in the log. */
interface Decided {
  message: string;
  permission: string;
}

const RequestActions = ({
  request,
  who,
  onDecided,
}: {
  request: Permission;
  who: string;
  /** Says what a decision did; clears what the last one said when given nothing. */
  onDecided: (decided?: Decided) => void;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [confirming, setConfirming] = useState(false);
  const decide = async (
    change: (permissions: Session["permissions"]) => Promise<unknown>,
    message: string
  ): Promise<void> => {
    setConfirming(false);
    onDecided();
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await change(session.permissions);
          onDecided({ message, permission: request.id });
        },
        async () => {
          // `sync` waits for the loader, so the controls stay off until
          // the list is back.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button
          disabled={busy}
          aria-label={`Approve ${who}`}
          onClick={() => {
            void decide(
              async (permissions) => await permissions.grant(request.id),
              `Approved: ${who}.`
            );
          }}
        >
          Approve
        </Button>
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogTrigger
            render={
              <Button
                variant="destructive"
                disabled={busy}
                aria-label={`Reject ${who}`}
              />
            }
          >
            Reject
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reject this request?</DialogTitle>
              <DialogDescription>
                {who} can&apos;t be granted later: it has to ask again.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  void decide(
                    async (permissions) => await permissions.revoke(request.id),
                    `Rejected: ${who}.`
                  );
                }}
              >
                Reject
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** The requests waiting for an admin, with the decision where it's theirs. */
export const PendingApprovals = ({
  pending: { requests, directory },
  decides,
}: {
  pending: PendingRequests;
  /** Whether core lets this person decide: an admin, not Grasp staff. */
  decides: boolean;
}) => {
  const [decided, setDecided] = useState<Decided>();
  return (
    <div className="flex flex-col gap-3">
      {decided === undefined ? null : (
        <output className="text-sm">
          {decided.message}{" "}
          <Link
            className="underline"
            search={{ target: decided.permission }}
            to="/activity"
          >
            See it in the log
          </Link>
        </output>
      )}
      {decides ? null : (
        <p className="text-muted-foreground text-sm">
          Only the organization&apos;s own admins decide permissions.
        </p>
      )}
      {requests.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing is waiting for approval.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>For</TableHead>
              <TableHead>Asks for</TableHead>
              <TableHead>Actions</TableHead>
              <TableHead>Version to review</TableHead>
              <TableHead>Asked by</TableHead>
              <TableHead>Asked</TableHead>
              {decides ? <TableHead>Decision</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => {
              const subject = subjectOf(request, directory);
              const object = objectOf(request, directory);
              return (
                <TableRow key={request.id}>
                  <TableCell>{subject}</TableCell>
                  <TableCell>
                    {object}
                    <span className="text-muted-foreground block text-xs">
                      as {request.binding}
                    </span>
                  </TableCell>
                  <TableCell>{request.actions.join(", ")}</TableCell>
                  <TableCell>{reviewedVersion(request, directory)}</TableCell>
                  <TableCell>
                    {personName(directory, request.requestedBy)}
                  </TableCell>
                  <TableCell>{formatTime(request.requestedAt)}</TableCell>
                  {decides ? (
                    <TableCell>
                      <RequestActions
                        request={request}
                        who={`${subject}: ${request.actions.join(", ")} on ${object}`}
                        onDecided={setDecided}
                      />
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
};
