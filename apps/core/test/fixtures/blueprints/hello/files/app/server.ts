import { DurableObject } from "cloudflare:workers";

interface Caller {
  userId: string;
}

/** The server code of the built-in blueprint core's tests install. */
export class App extends DurableObject {
  /** Greets `name`, and says how many greetings this App has given. */
  hello(caller: Caller, name: string): string {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS greetings (user_id TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO greetings VALUES (?)",
      caller.userId
    );
    const [row] = this.ctx.storage.sql
      .exec("SELECT count(*) AS given FROM greetings")
      .toArray();
    return `Hello, ${name}: greeting ${Number(row?.given)}`;
  }
}
