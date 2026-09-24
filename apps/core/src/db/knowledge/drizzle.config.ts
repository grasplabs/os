import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/knowledge/schema.ts",
  out: "./src/db/knowledge/migrations",
});
