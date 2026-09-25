/**
 * Keeps migrations safe to apply. A migration that main already has is
 * applied somewhere, so it must never change: fix it with a new migration.
 * And each journal lists its migrations in order (index 0, 1, 2, … with
 * rising timestamps), so a migration regenerated on a branch can't land
 * behind one main already shipped.
 *
 * Compares with `origin/main`; CI fetches it first.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf-8" });

interface Journal {
  entries: { idx: number; when: number }[];
}

const isJournal = (value: unknown): value is Journal =>
  typeof value === "object" &&
  value !== null &&
  "entries" in value &&
  Array.isArray(value.entries);

const errors: string[] = [];

const changed = git(
  "diff",
  "--name-status",
  "--diff-filter=MDR",
  "origin/main",
  "--",
  "*/migrations/*.sql"
)
  .split("\n")
  .filter(Boolean);
for (const line of changed) {
  errors.push(
    `${line.split("\t").at(-1)} is on main already: add a new migration instead of changing it.`
  );
}

const journals = git("ls-files", "*/migrations/meta/_journal.json")
  .split("\n")
  .filter(Boolean);
for (const file of journals) {
  const journal: unknown = JSON.parse(readFileSync(file, "utf-8"));
  if (!isJournal(journal)) {
    throw new Error(`${file} is not a drizzle-kit journal`);
  }
  const { entries } = journal;
  for (const [position, entry] of entries.entries()) {
    const previous = entries[position - 1];
    if (entry.idx !== position) {
      errors.push(`${file}: entry ${position} has index ${entry.idx}.`);
    }
    if (previous !== undefined && entry.when <= previous.when) {
      errors.push(
        `${file}: migration ${entry.idx} is older than the one before it; rebase on main and generate it again.`
      );
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
