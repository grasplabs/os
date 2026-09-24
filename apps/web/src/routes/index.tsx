import { createFileRoute } from "@tanstack/react-router";

const Chat = () => (
  <main className="flex min-h-svh items-center justify-center">
    <h1 className="text-2xl font-medium">Grasp</h1>
  </main>
);

export const Route = createFileRoute("/")({ component: Chat });
