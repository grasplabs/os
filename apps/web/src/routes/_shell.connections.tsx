import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "../placeholder.tsx";

const Connections = () => <Placeholder title="Connections" />;

export const Route = createFileRoute("/_shell/connections")({
  component: Connections,
});
