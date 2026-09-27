import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "../placeholder.tsx";

const Models = () => <Placeholder title="Models" />;

export const Route = createFileRoute("/_shell/models")({ component: Models });
