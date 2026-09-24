import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/db/workspace/schema.ts",
  out: "./src/db/workspace/migrations",
});
