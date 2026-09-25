import { Button } from "@grasp-os/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";

import { loadCoreStatus, signIn, signOut } from "../core.ts";
import { signInErrorMessage } from "../sign-in-errors.ts";

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
        <div className="flex flex-col items-center gap-2">
          {error === undefined ? null : (
            <p className="text-destructive text-sm" role="alert">
              {signInErrorMessage(error)}
            </p>
          )}
          {signInOptions.map(({ providerId, label }) => (
            <Button
              key={providerId}
              onClick={() => {
                void signIn(providerId);
              }}
            >
              Sign in with {label}
            </Button>
          ))}
        </div>
      )}
    </main>
  );
};

export const Route = createFileRoute("/")({
  component: Chat,
  // A refused sign-in comes back as `?error=<code>`.
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  loader: loadCoreStatus,
});
