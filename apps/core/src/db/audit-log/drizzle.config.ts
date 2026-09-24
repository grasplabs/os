import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/db/audit-log/schema.ts",
  out: "./src/db/audit-log/migrations",
});
