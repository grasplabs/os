import { defineErrorFamily } from "./errors.ts";

/** Why a chat's agent refused a question. */
export const agentErrors = defineErrorFamily({
  "agent.chat_not_found": "There's no such chat.",
  "agent.no_person":
    "This chat belongs to nobody, so its agent can't act for anyone.",
  "agent.busy":
    "The agent is still working in this chat. Wait for it, or stop it.",
  "agent.invalid_question": "That isn't a question the agent can take.",
  "agent.invalid_request": "That isn't a valid request for a chat.",
  "agent.invalid_title": "A chat's title is 1 to 200 characters.",
  "agent.too_many_chats":
    "You have 500 chats, the most a person keeps. Delete one to start another.",
  "agent.too_many_watches":
    "Too many of your pages follow chats at once. Close some, then try again.",
  "agent.chat_full":
    "This chat is too long to go on. Start a new chat to ask more.",
  "agent.run_ended":
    "This code run has ended, so its APIs don't answer any more.",
  "agent.run_calls_spent":
    "This code run has made all the API calls one run may. Run the rest in another code step.",
});
