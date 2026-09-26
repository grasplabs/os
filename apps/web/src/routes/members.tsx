import { messageOf } from "@grasp-os/shared/errors";
import type { Member } from "@grasp-os/shared/members";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import type { SignInOption } from "@grasp-os/shared/rpc";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { loadCoreStatus, withSession } from "../core.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { SignInOptions } from "../sign-in-options.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Offboarding, for admins: the organization's members, each with their
// role, a way to end their sessions, and a way to remove them for good.
// Core checks the role on every call; anyone else sees why they can't.
// The admin's own row has no actions: core refuses removing yourself or
// ending your own sessions, and demoting yourself (which core allows while
// another admin exists) is left out so nobody loses this page by accident.

type MembersView =
  | { state: "offline" }
  | { state: "signed-out"; signInOptions: SignInOption[] }
  | { state: "refused"; message: string }
  | { state: "ready"; members: Member[]; me: string };

const roles = roleSchema.options.map((role) => ({ label: role, value: role }));

const loadMembers = async (): Promise<MembersView> => {
  const { connected, signInOptions, identity } = await loadCoreStatus();
  if (!connected) {
    return { state: "offline" };
  }
  if (identity === undefined) {
    return { state: "signed-out", signInOptions };
  }
  try {
    const members = await withSession(
      async (session) => await session.members.list()
    );
    return { state: "ready", members, me: identity.userId };
  } catch (error) {
    return { state: "refused", message: messageOf(error) };
  }
};

type Change = (members: Session["members"]) => Promise<unknown>;

/** Shows why a change failed, or clears it when given nothing. */
type Report = (failure?: string) => void;

const MemberActions = ({
  member,
  onNotice,
}: {
  member: Member;
  onNotice: Report;
}) => {
  const router = useRouter();
  const { busy, failure, run: runAction } = useCoreAction();
  const [confirming, setConfirming] = useState(false);
  const [promoting, setPromoting] = useState(false);
  // Names needn't be unique; with the email, each row's controls are.
  const who = `${member.name} (${member.email})`;
  const run = async (change: Change, report?: Report): Promise<void> => {
    onNotice();
    setConfirming(false);
    setPromoting(false);
    await runAction(async (session) => {
      await change(session.members);
    }, report);
    // Even a failed change may have changed something (a removal whose
    // disconnect is still pending), so the list is read again.
    await router.invalidate();
  };
  const setRole = (role: Role): void => {
    void run(async (members) => {
      await members.setRole(member.userId, role);
    });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Select
          items={roles}
          value={member.role}
          disabled={busy}
          onValueChange={(role: Role | null) => {
            if (role === "admin") {
              setPromoting(true);
            } else if (role !== null) {
              setRole(role);
            }
          }}
        >
          <SelectTrigger aria-label={`Role of ${who}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((role) => (
              <SelectItem key={role.value} value={role.value}>
                {role.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Dialog open={promoting} onOpenChange={setPromoting}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Make {member.name} an admin?</DialogTitle>
              <DialogDescription>
                Admins can change anyone&apos;s role, end their sessions and
                remove them, other admins included.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button
                disabled={busy}
                onClick={() => {
                  setRole("admin");
                }}
              >
                Make admin
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button
          variant="outline"
          disabled={busy}
          aria-label={`End sessions for ${who}`}
          onClick={() => {
            void run(async (members) => {
              await members.revokeSessions(member.userId);
            });
          }}
        >
          End sessions
        </Button>
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogTrigger
            render={
              <Button
                variant="destructive"
                disabled={busy}
                aria-label={`Remove ${who}`}
              />
            }
          >
            Remove
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove {member.name}?</DialogTitle>
              <DialogDescription>
                They are signed out everywhere, their personal connections are
                disconnected, and they cannot sign in again.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  // Shown on the page: a removal that went through takes
                  // this row with it, even when it failed to disconnect
                  // everything (`member.connections_pending`).
                  void run(async (members) => {
                    await members.remove(member.userId);
                  }, onNotice);
                }}
              >
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

const MembersTable = ({ members, me }: { members: Member[]; me: string }) => {
  const [notice, setNotice] = useState<string>();
  return (
    <>
      <ErrorText>{notice}</ErrorText>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow key={member.userId}>
              <TableCell>{member.name}</TableCell>
              <TableCell>{member.email}</TableCell>
              <TableCell>
                {member.userId === me ? (
                  member.role
                ) : (
                  <MemberActions member={member} onNotice={setNotice} />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
};

const Members = () => {
  const page = Route.useLoaderData();
  const { error } = Route.useSearch();
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">Members</h1>
      {page.state === "offline" ? (
        <ErrorText>
          Grasp can&apos;t be reached right now. Try again in a moment.
        </ErrorText>
      ) : null}
      {page.state === "signed-out" ? (
        <>
          <p className="text-muted-foreground text-sm">
            Sign in to see your organization&apos;s members.
          </p>
          <SignInOptions
            options={page.signInOptions}
            error={error}
            returnTo="/members"
          />
        </>
      ) : null}
      {page.state === "refused" ? <ErrorText>{page.message}</ErrorText> : null}
      {page.state === "ready" ? (
        <MembersTable members={page.members} me={page.me} />
      ) : null}
    </main>
  );
};

export const Route = createFileRoute("/members")({
  component: Members,
  // A refused sign-in comes back as `?error=<code>`.
  validateSearch: signInErrorSearch,
  loader: loadMembers,
});
