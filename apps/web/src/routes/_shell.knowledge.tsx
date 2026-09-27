import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "../placeholder.tsx";

const Knowledge = () => <Placeholder title="Knowledge" />;

export const Route = createFileRoute("/_shell/knowledge")({
  component: Knowledge,
});
