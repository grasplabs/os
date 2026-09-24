import { DurableObject } from "cloudflare:workers";

/** A person's or team's workspace: chats and the Code Mode agent on Pi. */
export class Workspace extends DurableObject<Env> {}
