import { createFileRoute } from "@tanstack/react-router";

import { pingCore } from "../core.ts";

const Chat = () => {
  const connected = Route.useLoaderData();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2">
      <h1 className="text-2xl font-medium">Grasp</h1>
      <p className="text-muted-foreground text-sm">
        {connected ? "Connected" : "Not connected"}
      </p>
    </main>
  );
};

export const Route = createFileRoute("/")({
  component: Chat,
  loader: pingCore,
});
