import { DurableObject } from "cloudflare:workers";

/** One App: its own SQLite data, sandboxed server code and live updates. */
export class App extends DurableObject<Env> {}
