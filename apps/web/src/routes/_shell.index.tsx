import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "../placeholder.tsx";

const Chat = () => <Placeholder title="Chat" />;

export const Route = createFileRoute("/_shell/")({ component: Chat });
