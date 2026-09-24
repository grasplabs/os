/**
 * Branch names are `<type>/<kebab-description>`, with the same types as
 * Conventional Commits: `feat/audit-export`, `fix/connect-token-refresh`.
 * Checks the branch in `GITHUB_HEAD_REF` (CI) or the current branch.
 */
import { execFileSync } from "node:child_process";

const TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];
const PATTERN = new RegExp(
  `^(?:${TYPES.join("|")})/[a-z0-9]+(?:-[a-z0-9]+)*$`,
  "u"
);
// main itself, and branches opened by Renovate.
const EXEMPT = /^(?:main|renovate\/.+)$/u;

const headRef = process.env.GITHUB_HEAD_REF ?? "";
const branch =
  headRef === ""
    ? execFileSync("git", ["branch", "--show-current"], {
        encoding: "utf-8",
      }).trim()
    : headRef;

if (!(EXEMPT.test(branch) || PATTERN.test(branch))) {
  console.error(
    `Branch "${branch}" should be <type>/<kebab-description>, e.g. feat/audit-export.\nTypes: ${TYPES.join(", ")}.\nRename it with: git branch -m <new-name>`
  );
  process.exit(1);
}
