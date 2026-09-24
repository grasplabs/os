import { createFileRoute } from "@tanstack/react-router";

const Clients = () => (
  <main className="p-6">
    <h1 className="text-2xl font-medium">Clients</h1>
  </main>
);

export const Route = createFileRoute("/")({ component: Clients });
