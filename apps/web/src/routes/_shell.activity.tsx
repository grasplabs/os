import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "../placeholder.tsx";

const Activity = () => <Placeholder title="Activity" />;

export const Route = createFileRoute("/_shell/activity")({
  component: Activity,
});
