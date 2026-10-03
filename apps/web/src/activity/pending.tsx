import { appErrors, builtinOwner } from "@grasp-os/shared/apps";
import type { AppExports } from "@grasp-os/shared/apps";
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
import { i18n } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
import { formatList } from "../format.ts";
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
  /**
   * The exports of each App a request asks to call, as they are now: what
   * granting it lets the asking App call. Missing for one that couldn't
   * be read.
   */
  exports: ReadonlyMap<string, AppExports>;
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
  const called = [
    ...new Set(
      requests.flatMap(({ object }) =>
        object.type === "app" ? [object.appId] : []
      )
    ),
  ];
  // Each App's exports on their own: one that can't be read is shown as
  // such, and the requests are still there to decide.
  const read = await Promise.allSettled(
    called.map(async (app) => await session.apps.exports(app))
  );
  const exports = new Map<string, AppExports>();
  for (const [index, app] of called.entries()) {
    const result = read[index];
    if (result?.status === "fulfilled") {
      exports.set(app, result.value.exports);
    }
  }
  return { requests, directory, exports };
};

/** Who asks: the App or agent the permission is for. */
const subjectOf = ({ subject }: Permission, directory: Directory): string =>
  subject.type === "app"
    ? appName(directory, subject.appId)
    : i18n._(msg`Agent ${ph({ agent: subject.agentId })}`);

/**
 * The exports of another App a request's actions cover, as they are now:
 * all those marked `read` or `write`, and each named.
 */
const coveredExports = (
  actions: readonly string[],
  exported: AppExports | undefined
): string => {
  if (exported === undefined) {
    return i18n._(msg`couldn't be read`);
  }
  const covered = Object.entries(exported).flatMap(([name, { access }]) =>
    actions.includes(name) || actions.includes(access)
      ? [`${name} (${access})`]
      : []
  );
  return covered.length === 0 ? i18n._(msg`none now`) : formatList(covered);
};

/** What it asks for, by ID: connections and collections have no names here. */
const objectOf = (
  { object, actions }: Permission,
  directory: Directory,
  exports: PendingRequests["exports"]
): string => {
  if (object.type === "connection") {
    const { connectionId, resource } = object;
    return resource === undefined
      ? i18n._(msg`Connection ${connectionId}`)
      : i18n._(msg`Connection ${connectionId}, ${resource}`);
  }
  if (object.type === "collection") {
    const { collectionId } = object;
    return i18n._(msg`Collection ${collectionId}`);
  }
  if (object.type === "app") {
    const app = appName(directory, object.appId);
    const covered = coveredExports(actions, exports.get(object.appId));
    return i18n._(msg`Exports of ${app}: ${covered}`);
  }
  if (object.type === "platform" && actions.includes("guests")) {
    // Consent in plain words: who reaches what, and at whose cost.
    return i18n._(
      msg`Guest chats. This App can invite people who aren't members to a short chat with a model through a link, and read back what they write. Guests reach nothing else; their chats spend the model budget of whoever invites them`
    );
  }
  if (object.type === "platform") {
    // Consent in plain words: what the App reads is published company-wide
    // on purpose (counts only, never a run), and it may show it to anyone.
    return i18n._(
      msg`Platform statistics. This App can read run and signal counts for every App, and may show them to anyone who uses it`
    );
  }
  const { workflowId } = object;
  const app = appName(directory, object.appId);
  return i18n._(msg`Workflow ${workflowId} of ${app}`);
};

/**
 * The record types a request to write a collection would claim there, and
 * those another App keeps there already, which this App wouldn't get:
 * named, for an admin to grant the one they want.
 */
const RecordTypeClaims = ({
  request,
  directory,
}: {
  request: Permission;
  directory: Directory;
}) => {
  const { recordTypes } = request;
  const { t } = useLingui();
  if (recordTypes === undefined) {
    return null;
  }
  const claimed = formatList(recordTypes.claims);
  return (
    <>
      {recordTypes.claims.length === 0 ? null : (
        <span className="text-muted-foreground block text-xs">
          <Trans>Would keep {claimed} records here</Trans>
        </span>
      )}
      {recordTypes.taken.map(({ type, owner }) => (
        <span key={type} className="text-destructive block text-xs">
          {owner === null
            ? t`Another App already keeps ${type} records here: this App's won't apply.`
            : t`${ph({ app: appName(directory, owner) })} already keeps ${type} records here: this App's won't apply.`}
        </span>
      ))}
    </>
  );
};

/**
 * The version of the App an admin reviews as they decide: the one current
 * as the list was read, whose code the grant trusts. Null for an agent's
 * permission, an App with none current, or one the list doesn't have:
 * core then grants only if the App still has none current.
 */
const reviewedVersion = (
  { subject }: Permission,
  directory: Directory
): number | null =>
  subject.type === "app"
    ? (directory.apps.get(subject.appId)?.currentVersion ?? null)
    : null;

/** The version to review, as the row shows it. */
const reviewedVersionText = (
  request: Permission,
  directory: Directory
): string => {
  const { subject } = request;
  if (subject.type !== "app") {
    return "–";
  }
  if (!directory.apps.has(subject.appId)) {
    return i18n._(msg`Unknown`);
  }
  const version = reviewedVersion(request, directory);
  return version === null ? i18n._(msg`None current`) : String(version);
};

/**
 * Why a request is asked for again, if it is: it was granted before, and
 * making another version of its App current asked for it again.
 */
const askedAgain = (
  request: Permission,
  directory: Directory
): string | undefined => {
  const { grantedBy, grantedAt } = request;
  if (grantedBy === null || grantedAt === null) {
    return undefined;
  }
  const version = reviewedVersion(request, directory);
  const person = personName(directory, grantedBy);
  const date = formatTime(grantedAt);
  return version === null
    ? i18n._(msg`Asked again (previously granted by ${person} on ${date})`)
    : i18n._(
        msg`Asked again after version ${version} was made current (previously granted by ${person} on ${date})`
      );
};

const versionChanged = msg`Another version of this App was made current since this list was read. The list now shows it: review that version, then approve again.`;

/**
 * Grants `request` for `version`, the one the admin reviewed. Core refuses
 * with `app.conflict` once another version is current: that is said
 * plainly. Outside components, as the React Compiler can't compile `try`.
 */
const grantReviewed = async (
  permissions: Session["permissions"],
  request: Permission,
  version: number | null
): Promise<Permission> => {
  try {
    return await permissions.grant(request.id, { version });
  } catch (error) {
    if (appErrors.codeOf(error) === "app.conflict") {
      throw new Error(i18n._(versionChanged), { cause: error });
    }
    throw error;
  }
};

/** What a decision did, with a way to find it in the log. */
interface Decided {
  message: string;
  permission: string;
}

const RequestActions = ({
  request,
  version,
  who,
  onDecided,
}: {
  request: Permission;
  /** The version of its App the row shows for review. */
  version: number | null;
  who: string;
  /** Says what a decision did; clears what the last one said when given nothing. */
  onDecided: (decided?: Decided) => void;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [confirming, setConfirming] = useState(false);
  const { t } = useLingui();
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
          aria-label={t`Approve ${who}`}
          onClick={() => {
            void decide(
              async (permissions) =>
                await grantReviewed(permissions, request, version),
              t`Approved: ${who}.`
            );
          }}
        >
          <Trans>Approve</Trans>
        </Button>
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogTrigger
            render={
              <Button
                variant="destructive"
                disabled={busy}
                aria-label={t`Reject ${who}`}
              />
            }
          >
            <Trans>Reject</Trans>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                <Trans>Reject this request?</Trans>
              </DialogTitle>
              <DialogDescription>
                <Trans>
                  {who} can&apos;t be granted later: it has to ask again.
                </Trans>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  void decide(
                    async (permissions) => await permissions.revoke(request.id),
                    t`Rejected: ${who}.`
                  );
                }}
              >
                <Trans>Reject</Trans>
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
  pending: { requests, directory, exports },
  decides,
}: {
  pending: PendingRequests;
  /** Whether core lets this person decide: an admin, not Grasp staff. */
  decides: boolean;
}) => {
  const [decided, setDecided] = useState<Decided>();
  const { t } = useLingui();
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
            <Trans>See it in the log</Trans>
          </Link>
        </output>
      )}
      {decides ? null : (
        <p className="text-muted-foreground text-sm">
          <Trans>
            Only the organization&apos;s own admins decide permissions.
          </Trans>
        </p>
      )}
      {requests.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Nothing is waiting for approval.</Trans>
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>For</Trans>
              </TableHead>
              <TableHead>
                <Trans>Asks for</Trans>
              </TableHead>
              <TableHead>
                <Trans>Actions</Trans>
              </TableHead>
              <TableHead>
                <Trans>Version to review</Trans>
              </TableHead>
              <TableHead>
                <Trans>Asked by</Trans>
              </TableHead>
              <TableHead>
                <Trans>Asked</Trans>
              </TableHead>
              {decides ? (
                <TableHead>
                  <Trans>Decision</Trans>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => {
              const subject = subjectOf(request, directory);
              const object = objectOf(request, directory, exports);
              const again = askedAgain(request, directory);
              const { binding } = request;
              const actions = formatList(request.actions);
              return (
                <TableRow key={request.id}>
                  <TableCell>{subject}</TableCell>
                  <TableCell>
                    {object}
                    <span className="text-muted-foreground block text-xs">
                      <Trans>as {binding}</Trans>
                    </span>
                    <RecordTypeClaims request={request} directory={directory} />
                  </TableCell>
                  <TableCell>{formatList(request.actions)}</TableCell>
                  <TableCell>
                    {reviewedVersionText(request, directory)}
                  </TableCell>
                  <TableCell>
                    {personName(directory, request.requestedBy)}
                    {request.requestedVia === null ? null : (
                      <span className="text-muted-foreground block text-xs">
                        <Trans>asked for by the agent, in their chat</Trans>
                      </span>
                    )}
                    {again === undefined ? null : (
                      <span className="text-muted-foreground block text-xs">
                        {again}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{formatTime(request.requestedAt)}</TableCell>
                  {decides ? (
                    <TableCell>
                      <RequestActions
                        request={request}
                        version={reviewedVersion(request, directory)}
                        who={t`${subject}: ${actions} on ${object}`}
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
