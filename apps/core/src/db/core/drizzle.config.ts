import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/core/schema.ts",
  out: "./src/db/core/migrations",
});
