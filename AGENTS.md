# Grasp OS

One codebase, deployed once per client into the client's own Cloudflare account in the EU. Clients customise Grasp through configuration and in-product content (Apps, workflows, templates), never through code in this repo. If a template needs a platform code change, the platform is missing a capability: fix the platform, not the template.

## Layout

| Path | What it is |
| --- | --- |
| `apps/core` | Core Worker: sign-in, knowledge, Apps, workflows, model gateway, audit |
| `apps/connect` | Connector Worker: the connector layer, the only place OAuth tokens live |
| `apps/web` | Grasp OS frontend: React SPA, served as static files by core |
| `apps/console` | Staff console (TanStack Start); production runs in grasp-os-ops |
| `apps/router` | Stateless router: `*.<domain>` to each client's core; production runs in grasp-os-ops |
| `packages/sdk` | `@grasp-os/sdk`: workflow SDK and screen hooks, the only API App code sees |
| `packages/ui` | `@grasp-os/ui`: shadcn on Base UI, Tailwind v4, shared with App screens |
| `packages/compiler` | `@grasp-os/compiler`: the screen compiler |
| `packages/connectors/*` | Native MCP servers, loaded by connect |
| `packages/shared` | `@grasp-os/shared`: types and Zod schemas |
| `scripts` | Repo tooling, run by Node directly (TypeScript, no build step) |

Each app keeps its own Drizzle schemas and migrations in `src/db`, one folder per database (`src/db/<name>/` in core). Workspace packages export TypeScript source; there is no library build step.

## Commands

Vite+ (`vp`) is the toolchain. Run from the repo root:

- `vp install`: install dependencies (also installs the git hooks)
- `vp check`: format, lint (Ultracite + @shadcn/lint) and type-check (tsgo)
- `vp check --fix`: auto-fix
- `vp test`: all tests; Worker tests run in workerd
- `vp run -r build`: build everything
- `vp run e2e`: Playwright end-to-end tests (`*.e2e.ts` in `e2e/`)
- `vp run smoke:workerd`: boot core on plain workerd (on-prem readiness)
- `vp run dev`: run the frontend (localhost:5173) with core and connect behind it (localhost:8787); `vp -C apps/console dev` for the console
- `vp run -r typegen`: regenerate `worker-configuration.d.ts` after changing a `wrangler.jsonc`
- `vp run -r db:generate`: generate migrations after changing a schema

CI fails when generated files (Worker types, route trees, migrations) are not committed.

Vite+ docs: `node_modules/vite-plus/docs`.

## Conventions

- **Commits and PR titles** follow [Conventional Commits](https://www.conventionalcommits.org): `feat(core): …`, `fix(connect): …`, `chore(deps): …`. Scope is the app or package name. PRs are squash-merged, so the PR title is the commit on `main` and the release note. A `commit-msg` hook and CI enforce it.
- **Dependencies**: versions live in the `catalog` in `pnpm-workspace.yaml`, pinned exactly; packages reference them as `catalog:`. New versions wait 3 days (pnpm and Renovate). Only packages listed under `allowBuilds` may run install scripts.
- **No docs in the repo**: plans, ADRs, design notes and research live outside it. The only Markdown allowed is `README.md`, this file, `.github/` templates and skills; CI enforces it. Put the why in code comments where the decision sits, and in PR descriptions.
- **Secrets**: never commit secrets, client names or client configuration; secretlint checks every commit and CI. Local secrets go in `.dev.vars` (see `.dev.vars.example`). Authenticate Wrangler through the 1Password shell plugin.
- **Schemas** follow expand, then contract: add first, remove in a later release. Code must work against both the old and the new schema.
- **Features** ship switched off behind a flag; risky changes get a kill switch.

## Branches and pull requests

Trunk-based: `main` is the only long-lived branch; every merge deploys all apps to grasp-os-staging. The console and router reach grasp-os-ops only through the manual Deploy grasp-os-ops workflow. Releases reach clients through the console, ring by ring, and risky work ships behind a feature flag.

1. Branch from `main` as `<type>/<kebab-description>`, e.g. `feat/audit-export`, using the commit types. A pre-push hook and CI check the name.
2. Open a pull request into `main`. CI runs.
3. Nick or Jakob approves (CODEOWNERS); pushing after an approval needs a new one.
4. Add it to the merge queue, which tests it on top of the latest `main` and squash-merges it. No need to keep the branch up to date by hand.

Nobody pushes to `main` directly. In an emergency, organisation owners can merge a pull request without a second review or passing checks; GitHub records every bypass. Use it only when waiting would do more harm. The rules live in `.github/rulesets/`; apply changes with `vp run github:setup`.

Conflicts: rebase your branch on `main`. For generated files (lockfile, Worker types, route trees, migrations) take either side and regenerate (`vp install`, `vp run -r typegen`, `vp run -r build`, `vp run -r db:generate`) instead of merging by hand.

## Working from Linear

Work is planned in Linear (team Grasp OS), not in this repo.

- Only pick up issues in **Todo**; their blockers are done. Parent issues are containers; never pick one up.
- Move the issue to **In Progress** when you start and to **In Review** when the pull request is ready. Branch names and PR titles don't carry the issue ID, so move issues by hand.
- When your issue is **Done**, move any issue it blocked to **Todo** once all of that issue's blockers are done.
- Issues labelled **Security** are reviewed by a person before merge.
- Don't follow an issue blindly: if its scope conflicts with this file or the code, raise it in the issue.

## Architecture rules

- Every external call goes through connect; every model call through the model gateway in core.
- Agents and Apps start with access to nothing; every resource needs an explicit permission.
- Anything that runs on its own is a workflow. Screens never run in the background or register hooks.
- Workflow code imports only `@grasp-os/sdk`, never the engine.
- Only use platform APIs that also run on workerd. Platform services sit behind adapter interfaces so the on-prem profile can swap them.
- EU jurisdiction is set when a resource is created (R2 `jurisdiction`, Durable Object `jurisdiction("eu")`, D1 location).
- All React is compiled by the React Compiler, and the build fails on anything it can't compile. Don't write `useMemo`, `useCallback` or `memo` by hand; if the compiler rejects a component, fix the component.
- UI uses `@grasp-os/ui` components and theme tokens: no raw colours, arbitrary values or inline styles. `@shadcn/lint` names the component, variant or token to use instead.

## Testing

Test what the code does, at real boundaries, never how it does it.

- **Integration tests in workerd are the default.** Go in through public interfaces: a Worker request, an RPC call, a Durable Object, a workflow run. Mock only outside systems (model providers, Microsoft Graph, Composio), never our own modules.
- **Playwright for critical user journeys only**, end to end, with a trace as the artifact.
- **Isolated unit tests only for pure logic**: permission evaluation, the audit hash chain, parsers.
- **Security-critical code starts from its threat model.** For the sandbox, permissions and connectors, write the ways it can fail first, including deliberate attacks, then the code.
- **Durability is tested by breaking things**: kill a run mid-step, restart the engine, replay events, retry with the same idempotency key.
- **No tautological tests.** Asserting what a mock was told to return, or re-implementing the code under test, proves nothing.
- **No change-detector tests.** Don't assert call order, internal structure or implementation snapshots; a refactor that keeps behaviour must keep tests green.
- **Bug fixes close a behaviour gap.** Find the behaviour test that should have caught the bug and fix or extend it. Add a new test only for behaviour nothing covers; never a test named after a bug.
- Keep suites flat, use async/await, and never commit `.only` or `.skip`.

<!-- ultracite:start — generated by `ultracite init --agents universal` (Ultracite 7.12.0); commands adapted to Vite+, testing rules moved to Testing above -->

## Code standards (Ultracite)

This project uses **Ultracite** presets for Oxlint and Oxfmt, loaded through Vite+ in `vite.config.ts`. Run `vp check --fix` to format and fix; most issues are fixed automatically. Full reference: `node_modules/ultracite/skills/ultracite/references/code-standards.md`.

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type safety and explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers; extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async and promises

- Always `await` promises in async functions; don't forget to use the return value
- Use `async/await` syntax instead of promise chains
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React and JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use ref as a prop instead of `React.forwardRef` (React 19)
- Use semantic HTML and ARIA attributes for accessibility: meaningful alt text, proper heading hierarchy, labels for form inputs, keyboard handlers alongside mouse events, semantic elements (`<button>`, `<nav>`) instead of divs with roles

### Error handling and debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully; don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)

### When the linter can't help

Focus your attention on business logic correctness, meaningful naming, architecture decisions (component structure, data flow, API design), edge cases and error states, user experience (accessibility, performance, usability), and documentation (comment complex logic, but prefer self-documenting code).

<!-- ultracite:end -->
