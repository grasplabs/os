import { startScreenCompiler } from "@grasp-os/compiler";
import type { Diagnostic, AppSource } from "@grasp-os/compiler";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { buildScreens } from "../src/screens.ts";

/** A typical screen: a list with a filter, on the kit, with its own component. */
const typicalApp: Record<string, string> = {
  "screens/tickets.tsx": `import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { Status } from "../components/status";
import type { Ticket } from "../server";

const tickets: Ticket[] = [
  { id: "T-1", title: "Printer on fire", status: "open", assignee: "Ada" },
  { id: "T-2", title: "VPN drops at noon", status: "waiting", assignee: null },
  { id: "T-3", title: "New laptop", status: "closed", assignee: "Grace" },
];

export default function Tickets() {
  const [query, setQuery] = useState("");
  const shown = tickets.filter((ticket) =>
    ticket.title.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <main className="flex flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Tickets</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <SearchIcon aria-hidden />
            <Input
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button size="sm">
              <PlusIcon aria-hidden /> New
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticket</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assignee</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((ticket) => (
                <TableRow key={ticket.id}>
                  <TableCell>{ticket.title}</TableCell>
                  <TableCell>
                    <Status status={ticket.status} />
                  </TableCell>
                  <TableCell>
                    {ticket.assignee ?? <Badge variant="outline">Unassigned</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
`,
  "components/status.tsx": `import { Badge } from "@grasp-os/ui/components/badge";

import type { Ticket } from "../server";

const variants = {
  open: "default",
  waiting: "secondary",
  closed: "outline",
} as const;

export function Status({ status }: { status: Ticket["status"] }) {
  return <Badge variant={variants[status]}>{status}</Badge>;
}
`,
  // The App's server types, which screens use but don't compile.
  "server.d.ts": `export type { ReactNode } from "react";

export interface Ticket {
  id: string;
  title: string;
  status: "open" | "waiting" | "closed";
  assignee: string | null;
}
`,
};

const app = (files: Record<string, string>): AppSource => ({
  app: "tickets",
  version: crypto.randomUUID(),
  files: { ...typicalApp, ...files },
});

/** Where a diagnostic is, what found it and what it says, on one line. */
const summary = ({ file, line, column, rule, severity, message }: Diagnostic) =>
  `${file}:${line}:${column} ${rule} ${severity}: ${message}`;

/** The typical screen, with one line of it changed. */
const withLine = (from: string, to: string): Record<string, string> => {
  const screen = typicalApp["screens/tickets.tsx"] ?? "";
  if (!screen.includes(from)) {
    throw new Error(`The screen has no ${from}`);
  }
  return { "screens/tickets.tsx": screen.replace(from, to) };
};

// Every build starts an isolate with the compiler in it.
describe("screen checks", { timeout: 60_000 }, () => {
  it("passes a clean screen, with the App's server types", async () => {
    const built = await buildScreens(env, app({}));

    expect(built).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("fails a type error, saying where", async () => {
    const built = await buildScreens(
      env,
      app(
        withLine(
          `{ id: "T-2", title: "VPN drops at noon", status: "waiting", assignee: null },`,
          `{ id: "T-2", title: "VPN drops at noon", status: "stuck", assignee: null },`
        )
      )
    );

    expect(built).toStrictEqual({
      ok: false,
      diagnostics: [
        {
          file: "screens/tickets.tsx",
          line: 21,
          column: 44,
          rule: "TS2322",
          severity: "error",
          message: `Type '"stuck"' is not assignable to type '"open" | "waiting" | "closed"'.`,
        },
      ],
    });
  });

  it("fails a type error in the App's server types", async () => {
    const built = await buildScreens(
      env,
      app({
        "server.d.ts": `export interface Ticket {
  id: string;
  title: string;
  status: "open" | "waiting" | "closed";
  assignee: Person | null;
}
`,
      })
    );

    expect(built).toStrictEqual({
      ok: false,
      diagnostics: [
        {
          file: "server.d.ts",
          line: 5,
          column: 13,
          rule: "TS2304",
          severity: "error",
          message: "Cannot find name 'Person'.",
        },
      ],
    });
  });

  it("fails a syntax error, saying where", async () => {
    const built = await buildScreens(
      env,
      app(
        withLine(
          `const [query, setQuery] = useState("");`,
          'const [query, setQuery = useState("");'
        )
      )
    );

    expect(built.ok).toBeFalsy();
    expect(
      built.diagnostics.map((diagnostic) => summary(diagnostic))
    ).toStrictEqual([
      expect.stringMatching(
        /^screens\/tickets\.tsx:26:40 compile error: Unexpected token/u
      ),
    ]);
    expect(built.diagnostics[0]?.rule).toBe("compile");
  });

  it("fails a restyled component, naming its variants and sizes", async () => {
    const built = await buildScreens(
      env,
      app(
        withLine(
          `<Button size="sm">`,
          `<Button size="sm" className="rounded-full px-8">`
        )
      )
    );

    expect(built.ok).toBeFalsy();
    expect(
      built.diagnostics.map((diagnostic) => summary(diagnostic))
    ).toStrictEqual([
      expect.stringContaining(
        'screens/tickets.tsx:44:41 shadcn/no-restyle error: "rounded-full" is not allowed on <Button>: <Button> owns its shape. Use a variant: default, outline, secondary, ghost, destructive, link.'
      ),
      expect.stringContaining(
        'screens/tickets.tsx:44:41 shadcn/no-restyle error: "px-8" is not allowed on <Button>: <Button> owns its spacing. Use a size (default, xs, sm, lg, icon, icon-xs, icon-sm, icon-lg)'
      ),
    ]);
  });

  it("fails a raw colour, naming the theme token to use", async () => {
    const built = await buildScreens(
      env,
      app(
        withLine(
          `<main className="flex flex-col gap-4 p-6">`,
          `<main className="flex flex-col gap-4 bg-red-500 p-6">`
        )
      )
    );

    expect(built.ok).toBeFalsy();
    expect(
      built.diagnostics.map((diagnostic) => summary(diagnostic))
    ).toStrictEqual([
      expect.stringContaining(
        'screens/tickets.tsx:31:21 shadcn/no-raw-colors error: "bg-red-500" uses the raw Tailwind palette. Nearest theme tokens: bg-destructive'
      ),
    ]);
    expect(built.diagnostics[0]?.fix).toBe('Replace with "bg-destructive".');
  });

  it("checks a typical screen quickly once the isolate is warm", async () => {
    const compiler = startScreenCompiler(env.LOADER, env.ASSETS, "timing");
    // The first check parses the kit's declarations; later ones reuse them.
    await expect(compiler.check(typicalApp)).resolves.toStrictEqual([]);

    // The fastest of a few runs: a shared runner's pauses (other jobs,
    // garbage collection) only ever add time. A warm check takes about
    // 50 ms on a laptop, well inside the 1 s the checks may add to a build;
    // the bound here is looser, 5 s, so that a slow or busy CI runner can't
    // fail it, while a check gone badly wrong (runaway work) still does.
    // The test's clock only moves on I/O;
    // each RPC to the compiler is I/O, so the times are real.
    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- runs are timed one at a time
      await compiler.check(typicalApp);
      timings.push(performance.now() - started);
    }

    expect(Math.min(...timings)).toBeLessThan(5000);
  });
});
