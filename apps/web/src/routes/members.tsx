import { messageOf } from "@grasp-os/shared/errors";
import type { Member } from "@grasp-os/shared/members";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
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

import { withSession } from "../core.ts";
import type { Session } from "../core.ts";

// Offboarding, for admins: the organization's members, each with their
// role, a way to end their sessions, and a way to remove them for good.
// Core checks the role on every call; anyone else sees why they can't.
// The admin's own row has no actions: core refuses them anyway.

type MembersView =
  | { members: Member[]; me: string; error?: undefined }
  | { members?: undefined; me?: undefined; error: string };

const roles = roleSchema.options.map((role) => ({ label: role, value: role }));

const loadMembers = async (): Promise<MembersView> => {
  try {
    return await withSession(async (session) => {
      const [members, me] = await Promise.all([
        session.members.list(),
        session.whoami(),
      ]);
      return { members, me: me.userId };
    });
  } catch (error) {
    return { error: messageOf(error) };
  }
};

type Change = (members: Session["members"]) => Promise<unknown>;

const MemberActions = ({ member }: { member: Member }) => {
  const router = useRouter();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const run = async (change: Change): Promise<void> => {
    setFailure(undefined);
    setBusy(true);
    setConfirming(false);
    try {
      await withSession(async (session) => {
        await change(session.members);
      });
    } catch (error) {
      setFailure(messageOf(error));
    }
    setBusy(false);
    // Even a failed change may have changed something (a removal whose
    // disconnect is still pending), so the list is read again.
    await router.invalidate();
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Select
          items={roles}
          value={member.role}
          disabled={busy}
          onValueChange={(role: Role | null) => {
            if (role !== null) {
              void run(async (members) => {
                await members.setRole(member.userId, role);
              });
            }
          }}
        >
          <SelectTrigger aria-label={`Role of ${member.name}`}>
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
        <Button
          variant="outline"
          disabled={busy}
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
            render={<Button variant="destructive" disabled={busy} />}
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
                  void run(async (members) => {
                    await members.remove(member.userId);
                  });
                }}
              >
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {failure === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
};

const Members = () => {
  const { members, me, error } = Route.useLoaderData();
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">Members</h1>
      {members === undefined ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : (
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
                    <MemberActions member={member} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
};

export const Route = createFileRoute("/members")({
  component: Members,
  loader: loadMembers,
});
