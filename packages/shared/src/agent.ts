import { defineErrorFamily } from "./errors.ts";

/** Why a chat's agent refused a question. */
export const agentErrors = defineErrorFamily({
  "agent.chat_not_found": "There's no such chat.",
  "agent.no_person":
    "This chat belongs to nobody, so its agent can't act for anyone.",
  "agent.busy":
    "The agent is still working in this chat. Wait for it, or stop it.",
  "agent.invalid_question": "That isn't a question the agent can take.",
  "agent.run_ended":
    "This code run has ended, so its APIs don't answer any more.",
});
