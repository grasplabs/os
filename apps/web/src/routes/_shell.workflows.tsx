import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "../placeholder.tsx";

const Workflows = () => <Placeholder title="Workflows" />;

export const Route = createFileRoute("/_shell/workflows")({
  component: Workflows,
});
