import { DurableObject } from "cloudflare:workers";

/** Where the App keeps its restricted mode (see restricted.ts). */
const restrictedKey = "restricted";

/** One App: its own SQLite data, sandboxed server code and live updates. */
export class App extends DurableObject<Env> {
  /** Whether the App has read restricted data. */
  async isRestricted(): Promise<boolean> {
    return (await this.ctx.storage.get(restrictedKey)) === true;
  }

  /** Puts the App in restricted mode, for good. */
  async restrict(): Promise<void> {
    await this.ctx.storage.put(restrictedKey, true);
  }
}
