import { Button } from "@grasp-os/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";

import { loadCoreStatus, signOut } from "../core.ts";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { SignInOptions } from "../sign-in-options.tsx";

const Chat = () => {
  const { connected, signInOptions, identity } = Route.useLoaderData();
  const { error } = Route.useSearch();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-medium">Grasp</h1>
      <p className="text-muted-foreground text-sm">
        {connected ? "Connected" : "Not connected"}
      </p>
      {identity ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm">
            Signed in as {identity.name} ({identity.role}
            {identity.staff ? ", Grasp staff" : ""})
          </p>
          {identity.role === "admin" && !identity.staff ? (
            <Link className="text-sm underline" to="/members">
              Members
            </Link>
          ) : null}
          <Button
            variant="outline"
            onClick={() => {
              void signOut();
            }}
          >
            Sign out
          </Button>
        </div>
      ) : (
        <SignInOptions options={signInOptions} error={error} />
      )}
    </main>
  );
};

export const Route = createFileRoute("/")({
  component: Chat,
  // A refused sign-in comes back as `?error=<code>`.
  validateSearch: signInErrorSearch,
  loader: loadCoreStatus,
});
