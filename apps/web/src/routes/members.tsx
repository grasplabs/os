import { messageOf } from "@grasp-os/shared/errors";
import type { Member } from "@grasp-os/shared/members";
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
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { withSession } from "../core.ts";

// Offboarding, for admins: the organization's members, each with a way to
// end their sessions or remove them for good. Core checks the role on
// every call; anyone else sees why they can't.

type MembersView =
  | { members: Member[]; error?: undefined }
  | { members?: undefined; error: string };

const loadMembers = async (): Promise<MembersView> => {
  try {
    return {
      members: await withSession(
        async (session) => await session.members.list()
      ),
    };
  } catch (error) {
    return { error: messageOf(error) };
  }
};

const MemberActions = ({ member }: { member: Member }) => {
  const router = useRouter();
  const [failure, setFailure] = useState<string>();
  const run = async (action: "remove" | "revokeSessions"): Promise<void> => {
    setFailure(undefined);
    try {
      await withSession(async (session) => {
        await session.members[action](member.userId);
      });
      await router.invalidate();
    } catch (error) {
      setFailure(messageOf(error));
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void run("revokeSessions");
          }}
        >
          Sign out
        </Button>
        <Dialog>
          <DialogTrigger render={<Button variant="destructive" />}>
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
                onClick={() => {
                  void run("remove");
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
  const { members, error } = Route.useLoaderData();
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
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
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.userId}>
                <TableCell>{member.name}</TableCell>
                <TableCell>{member.email}</TableCell>
                <TableCell>{member.role}</TableCell>
                <TableCell>
                  <MemberActions member={member} />
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
