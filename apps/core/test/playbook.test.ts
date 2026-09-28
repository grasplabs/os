import {
  knowledgeErrors,
  playbookCollectionId,
} from "@grasp-os/shared/knowledge";
import type {
  DocumentSummary,
  PlaybookRecordType,
} from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { stringify } from "yaml";
import { z } from "zod";

import {
  getDocument,
  restoreVersion,
  saveDocument,
} from "../src/knowledge/documents.ts";
import {
  FrontmatterError,
  parseFrontmatter,
  withFrontmatter,
} from "../src/knowledge/frontmatter.ts";
import { linkWorkflow, saveRecord } from "../src/knowledge/playbook.ts";
import type { LinkInput } from "../src/knowledge/playbook.ts";
import { preparePurge, purge } from "../src/knowledge/purge.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The Playbook's records: typed documents in the Playbook collection.
// These tests start from the ways records can fail: a record that doesn't
// fit its type is saved anyway, or its structure makes its text unreadable
// or breaks out of its frontmatter; a record lands outside the Playbook,
// where code from before record types would read it; a workflow loses its
// history or its link on the way from drawn to designed to built, or a
// save from an old version carries an old link; someone other than an
// admin changes the Playbook; a link names a workflow that isn't there, or
// a snapshot a version that isn't; a link or save runs while the feature
// is off; and a purge can't remove a person's name from their record, or
// rewrites a snapshot's frozen workflow paths, which makes it name a
// workflow version the Playbook doesn't have and fails the purge.

const idp = mockIdp();

/** Signing people in and releasing Apps can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const personOf = async (role: Role) => {
  const person = await signedInApi(idp, role);
  return { ...person, identity: await person.api.whoami() };
};

type Person = Awaited<ReturnType<typeof personOf>>;

/** One record of each type, as the Playbook Apps would write them. */
const records: Record<
  PlaybookRecordType | "decision",
  { record: Record<string, unknown>; body: string }
> = {
  vision: {
    record: { type: "vision", title: "Where we go" },
    body: "# Where we go\n\nNo invoice waits more than a day.",
  },
  team: {
    record: { type: "team", title: "Finance" },
    body: "Pays suppliers and closes the books.",
  },
  person: {
    record: {
      type: "person",
      title: "Anna de Vries",
      role: "Controller",
      team: "teams/finance.md",
    },
    body: "Approves payments; see [[teams/finance.md]].",
  },
  tool: {
    record: { type: "tool", title: "Exact Online", vendor: "Exact" },
    body: "Bookkeeping.",
  },
  source: {
    record: {
      type: "source",
      title: "Interview with Anna",
      medium: "interview",
      date: "2026-09-01",
      person: "people/anna.md",
    },
    body: "Notes from the first interview.",
  },
  statement: {
    record: {
      type: "statement",
      title: "Invoices wait for approval",
      source: "sources/anna.md",
      topic: "time_sink",
    },
    body: "Invoices wait up to a week for a second signature.",
  },
  workflow: {
    record: {
      type: "workflow",
      title: "Pay supplier invoices",
      state: "drawn",
      team: "teams/finance.md",
      steps: [
        {
          name: "Match the invoice",
          who: "Controller",
          tool: "Exact Online",
          handover: true,
          numbers: {
            frequency: { value: 40, basis: "estimated" },
            minutes: { value: 5, basis: "observed" },
            people: { value: 1, basis: "estimated" },
          },
        },
        { name: "Approve", who: "CFO", handover: false },
      ],
      parameters: [{ name: "Approval limit", value: "€ 5,000" }],
      gain: { hoursPerWeek: 3 },
    },
    body: "# Pay supplier invoices\n\nFrom the invoice arriving to it being paid.",
  },
  snapshot: {
    record: {
      type: "snapshot",
      title: "September",
      date: "2026-09-30",
      maturity: 2,
      workflows: [{ path: "workflows/pay.md", version: 1 }],
    },
    body: "Where we stood at the end of September.",
  },
  "plan-item": {
    record: {
      type: "plan-item",
      title: "Automate matching",
      status: "doing",
      due: "2026-10-31",
      workflow: "workflows/pay.md",
    },
    body: "Match invoices to orders automatically.",
  },
  decision: {
    record: { type: "decision", title: "Pay weekly", status: "accepted" },
    body: "We pay suppliers once a week.",
  },
  "rulebook-entry": {
    record: { type: "rulebook-entry", title: "Four eyes over € 5,000" },
    body: "Two people approve every payment over € 5,000.",
  },
};

/** A record's text, as it is saved: its frontmatter, then its body. */
const textOf = ({
  record,
  body,
}: {
  record: Record<string, unknown>;
  body: string;
}): string => `---\n${stringify(record)}---\n${body}`;

/** The problems a record's frontmatter was refused for, or "ok". */
const problems = (record: Record<string, unknown>): string[] | "ok" => {
  try {
    parseFrontmatter("record.md", textOf({ record, body: "" }));
    return "ok";
  } catch (error) {
    if (error instanceof FrontmatterError) {
      return error.issues;
    }
    throw error;
  }
};

const detailsSchema = z.object({
  details: z.record(z.string(), z.unknown()).default({}),
});

/** The code and details a promise was refused with. */
const refusal = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    const { details } = detailsSchema.parse(error);
    return { code: knowledgeErrors.codeOf(error) ?? String(error), ...details };
  }
  throw new Error("Expected a refusal");
};

const save = async (
  by: Person,
  input: {
    path: string;
    record: Record<string, unknown>;
    body: string;
    ifVersion?: number;
    message?: string;
  }
) => await saveRecord(env, by.identity, { ifVersion: 0, ...input });

const link = async (by: Person, input: LinkInput) =>
  await linkWorkflow(env, by.identity, input);

const workflowFile = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "pay",
  { input: z.unknown(), params: {} },
  async (step) => await step.do("count", { description: "Count" }, async () => 1)
);
`;

const workflowTestsFile = `import { workflowTests } from "@grasp-os/sdk/testing";

import pay from "./pay.ts";

export default workflowTests(pay, [{ name: "counts", mocks: { count: 1 }, expect: { output: 1 } }]);
`;

/** An App whose running version has the workflow `pay`; returns its ID. */
const appWithWorkflow = async (builder: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({
    name: `Payables ${unique()}`,
  });
  await release(builder, id, {
    "app/server.ts": "export class App {}\n",
    "workflows/pay.ts": workflowFile,
    "workflows/pay.workflow-tests.ts": workflowTestsFile,
  });
  return id;
};

describe("Playbook record schemas", () => {
  it("accept one record of each type", () => {
    const results = Object.fromEntries(
      Object.entries(records).map(([type, { record }]) => [
        type,
        problems(record),
      ])
    );
    expect(
      Object.values(results).every((result) => result === "ok")
    ).toBeTruthy();
    expect(Object.keys(results).toSorted()).toStrictEqual(
      Object.keys(records).toSorted()
    );
  });

  it("refuse what doesn't fit each type, naming the problem", () => {
    const workflow = records.workflow.record;
    expect({
      person: problems({ type: "person", role: "" }),
      tool: problems({ type: "tool", vendor: "x".repeat(201) }),
      source: problems({ type: "source", date: "last week" }),
      statement: problems({ type: "statement", topic: "gossip" }),
      workflowState: problems({ ...workflow, state: "sketched" }),
      workflowStep: problems({
        ...workflow,
        steps: [
          {
            name: "Match",
            numbers: { minutes: { value: -1, basis: "guessed" } },
            minuts: 5,
          },
        ],
      }),
      drawnWithApp: problems({
        ...workflow,
        app: { appId: "app-1", workflowId: "pay" },
      }),
      snapshot: problems({ type: "snapshot", maturity: 6 }),
      planItem: problems({ type: "plan-item", status: "later" }),
      path: problems({ type: "person", team: "../finance.md" }),
    }).toStrictEqual({
      person: [
        "frontmatter.role: Too small: expected string to have >=1 characters",
      ],
      tool: [
        "frontmatter.vendor: Too big: expected string to have <=200 characters",
      ],
      source: ["frontmatter.date: Invalid ISO date"],
      statement: [
        "frontmatter.source: Invalid input: expected string, received undefined",
        'frontmatter.topic: Invalid option: expected one of "goal"|"blocker"|"time_sink"|"handover"|"tool"|"rule"',
      ],
      workflowState: [
        'frontmatter.state: Invalid option: expected one of "drawn"|"designed"',
      ],
      workflowStep: [
        "frontmatter.steps.0.numbers.minutes.value: Too small: expected number to be >=0",
        'frontmatter.steps.0.numbers.minutes.basis: Invalid option: expected one of "estimated"|"observed"',
        'frontmatter.steps.0: Unrecognized key: "minuts"',
      ],
      drawnWithApp: [
        "frontmatter.app: Only a designed workflow links to an App workflow",
      ],
      snapshot: [
        "frontmatter.date: Invalid input: expected string, received undefined",
        "frontmatter.maturity: Too big: expected number to be <=5",
      ],
      planItem: [
        'frontmatter.status: Invalid option: expected one of "planned"|"doing"|"done"|"dropped"',
      ],
      path: [
        "frontmatter.team: A path has no empty, blank, '.' or '..' folders and doesn't start or end with /",
      ],
    });
  });

  it("set a field and keep the rest of the text as it was", () => {
    const text =
      "---\n# Drawn with Anna\ntype: workflow\nstate: designed\nextra: kept\n---\n# Pay\n\nBody.";
    const linked = withFrontmatter(text, {
      app: { appId: "app-1", workflowId: "pay" },
    });
    expect({
      text: linked,
      parsed: parseFrontmatter("pay.md", linked).frontmatter,
    }).toMatchObject({
      text: "---\n# Drawn with Anna\ntype: workflow\nstate: designed\nextra: kept\napp:\n  appId: app-1\n  workflowId: pay\n---\n# Pay\n\nBody.",
      parsed: { state: "designed", app: { appId: "app-1", workflowId: "pay" } },
    });
  });
});

describe("Playbook records", () => {
  it(
    "save every type as a readable document in the Playbook",
    setUpTime,
    async () => {
      const admin = await personOf("admin");
      const folder = unique();
      // The workflow the snapshot freezes.
      await save(admin, { path: "workflows/pay.md", ...records.workflow });
      const saved = [];
      for (const [type, sample] of Object.entries(records)) {
        // oxlint-disable-next-line no-await-in-loop -- one record at a time
        const summary = await save(admin, {
          path: `${folder}/${type}.md`,
          ...sample,
        });
        // oxlint-disable-next-line no-await-in-loop -- one record at a time
        const read = await admin.api.knowledge.getDocument(summary.id);
        const { frontmatter } = parseFrontmatter(
          summary.path,
          read.version.text
        );
        saved.push({
          type,
          summary: {
            collectionId: summary.collectionId,
            type: summary.type,
            title: summary.title,
          },
          body: read.version.text.endsWith(`---\n${sample.body}`),
          // What was saved of each field, read back.
          fields: Object.fromEntries(
            Object.entries(frontmatter).filter(([key]) => key in sample.record)
          ),
        });
      }
      expect(saved).toStrictEqual(
        Object.entries(records).map(([type, { record }]) => ({
          type,
          summary: {
            collectionId: playbookCollectionId,
            type,
            title: record.title,
          },
          body: true,
          fields: Object.fromEntries(
            Object.entries(record).filter(([key]) => key !== "type")
          ),
        }))
      );
      // The body is what search finds.
      const { hits } = await admin.api.knowledge.search("signature", {
        collectionId: playbookCollectionId,
        type: "statement",
      });
      expect(hits.map(({ path }) => path)).toContain(`${folder}/statement.md`);
    }
  );

  it(
    "keep YAML in values from breaking out of the frontmatter",
    setUpTime,
    async () => {
      const admin = await personOf("admin");
      const sneaky = "Anna\n---\ntype: skill\nname: evil\n---";
      const summary = await save(admin, {
        path: `${unique()}/person.md`,
        record: { type: "person", title: "Anna", role: sneaky },
        body: "Body.",
      });
      const read = await admin.api.knowledge.getDocument(summary.id);
      expect({
        type: summary.type,
        parsed: parseFrontmatter(summary.path, read.version.text),
      }).toMatchObject({
        type: "person",
        parsed: { type: "person", frontmatter: { role: sneaky } },
      });
    }
  );

  it(
    "refuse a record that doesn't fit its type, and save nothing",
    setUpTime,
    async () => {
      const admin = await personOf("admin");
      const path = `${unique()}/pay.md`;
      const result = await refusal(
        save(admin, {
          path,
          record: { ...records.workflow.record, state: "sketched" },
          body: "Body.",
        })
      );
      const { documents } =
        await admin.api.knowledge.listDocuments(playbookCollectionId);
      expect({
        result,
        saved: documents.some((document) => document.path === path),
        notARecord: await refusal(
          save(admin, { path, record: { type: "doc" }, body: "Body." })
        ),
        withApp: await refusal(
          save(admin, {
            path,
            record: {
              ...records.workflow.record,
              state: "designed",
              app: { appId: "app-1", workflowId: "pay" },
            },
            body: "Body.",
          })
        ),
      }).toMatchObject({
        result: {
          code: "knowledge.invalid",
          issues: [
            'frontmatter.state: Invalid option: expected one of "drawn"|"designed"',
          ],
        },
        saved: false,
        notARecord: { code: "knowledge.invalid" },
        withApp: {
          code: "knowledge.invalid",
          issues: [
            "record.app: Link a workflow to an App workflow with linkWorkflow",
          ],
        },
      });
    }
  );

  it(
    "stay in the Playbook: a record elsewhere is refused",
    setUpTime,
    async () => {
      const user = await personOf("user");
      const { id: collectionId } = await user.api.knowledge.createCollection({
        name: `Notes ${unique()}`,
        access: "me",
      });
      await expect(
        refusal(
          user.api.knowledge.saveDocument({
            collectionId,
            path: "anna.md",
            text: textOf(records.person),
            ifVersion: 0,
          })
        )
      ).resolves.toStrictEqual({
        code: "knowledge.invalid",
        issues: [
          "frontmatter.type: a person record belongs in the Playbook collection",
        ],
      });
    }
  );

  it(
    "are written only by those who may change the Playbook, while the feature is on",
    setUpTime,
    async () => {
      const admin = await personOf("admin");
      const user = await personOf("user");
      const input = {
        path: `${unique()}/team.md`,
        ...records.team,
      };
      const name = `Nowak${unique()}`;
      // The admin's first save creates the collection.
      const saved = await save(admin, {
        path: `${unique()}/team.md`,
        record: { type: "team", title: `Finance of ${name}` },
        body: "Body.",
      });
      const off: Env = {
        ...env,
        FEATURES: { knowledge: true, knowledge_purge: true },
      };
      const purgeInput = {
        type: "content",
        documentIds: [saved.id],
        terms: [name],
        reason: "erasure_request",
      };
      expect({
        user: await outcome(save(user, input)),
        off: await outcome(
          saveRecord(off, admin.identity, { ...input, ifVersion: 0 })
        ),
        linkOff: await outcome(
          linkWorkflow(off, admin.identity, {
            documentId: saved.id,
            ifVersion: 1,
            appId: "any",
            workflowId: "pay",
          })
        ),
        // Nor any other save, while the flag is off.
        saveDocumentOff: await outcome(
          saveDocument(off, admin.identity, {
            collectionId: playbookCollectionId,
            path: input.path,
            text: textOf(records.team),
            ifVersion: 0,
          })
        ),
        restoreOff: await outcome(
          restoreVersion(off, admin.identity, {
            documentId: saved.id,
            version: 1,
            ifVersion: 1,
          })
        ),
        // What it holds is still read and purged.
        readOff: await outcome(
          getDocument(off, { type: "person", person: admin.identity }, saved.id)
        ),
        purgeOff: await outcome(
          (async () => {
            const { token } = await preparePurge(
              off,
              admin.identity,
              purgeInput
            );
            await purge(off, admin.identity, purgeInput, token);
          })()
        ),
      }).toStrictEqual({
        user: "knowledge.forbidden",
        off: "feature.disabled",
        linkOff: "feature.disabled",
        saveDocumentOff: "feature.disabled",
        restoreOff: "feature.disabled",
        readOff: "ok",
        purgeOff: "ok",
      });
      const purged = await admin.api.knowledge.getDocument(saved.id);
      expect(purged.title).toBe("Finance of (removed)");
    }
  );

  it(
    "move a workflow from drawn to designed to linked, keeping its history",
    setUpTime,
    async () => {
      const admin = await personOf("admin");
      const appId = await appWithWorkflow(admin);
      const path = `${unique()}/pay.md`;
      const drawn = await save(admin, { path, ...records.workflow });
      const designedRecord = {
        ...records.workflow.record,
        state: "designed",
        steps: [{ name: "Match the invoice", kind: "automated" }],
      };
      await save(admin, {
        path,
        ifVersion: 1,
        record: designedRecord,
        body: records.workflow.body,
        message: "Designed",
      });
      let linked: DocumentSummary | undefined;
      const events = await auditedDuring(async () => {
        linked = await link(admin, {
          documentId: drawn.id,
          ifVersion: 2,
          appId,
          workflowId: "pay",
        });
      });
      // A later edit keeps the link.
      await save(admin, {
        path,
        ifVersion: 3,
        record: { ...designedRecord, gain: { hoursPerWeek: 4 } },
        body: records.workflow.body,
      });
      const { versions } = await admin.api.knowledge.history(drawn.id);
      const at = async (version: number) => {
        const read = await admin.api.knowledge.getDocument(drawn.id, version);
        return parseFrontmatter(path, read.version.text).frontmatter;
      };
      expect({
        linked,
        events: events
          .filter(({ action }) => action === "knowledge.workflow.linked")
          .map(({ action, target, detail }) => ({ action, target, detail })),
        history: versions.map(({ number, message }) => ({ number, message })),
        drawn: await at(1),
        designed: await at(2),
        linkedVersion: await at(3),
        edited: await at(4),
      }).toMatchObject({
        linked: { id: drawn.id, currentVersion: 3 },
        events: [
          {
            action: "knowledge.workflow.linked",
            target: { type: "document", id: drawn.id },
            detail: { version: 3, appId, workflowId: "pay" },
          },
        ],
        history: [
          { number: 4, message: null },
          { number: 3, message: "Linked to its App workflow" },
          { number: 2, message: "Designed" },
          { number: 1, message: null },
        ],
        drawn: { state: "drawn", steps: records.workflow.record.steps },
        designed: { state: "designed" },
        linkedVersion: {
          state: "designed",
          app: { appId, workflowId: "pay" },
        },
        edited: {
          gain: { hoursPerWeek: 4 },
          app: { appId, workflowId: "pay" },
        },
      });
      await expect(at(2)).resolves.not.toHaveProperty("app");
      // A save from an earlier version writes nothing, whatever it links to.
      await expect(
        refusal(
          save(admin, {
            path,
            ifVersion: 3,
            record: designedRecord,
            body: "From version 3.",
          })
        )
      ).resolves.toMatchObject({
        code: "knowledge.conflict",
        documentId: drawn.id,
        latestVersion: 4,
      });
      // Linked, it can't go back to drawn: the link is a designed one's.
      await expect(
        refusal(
          save(admin, {
            path,
            ifVersion: 4,
            record: { ...designedRecord, state: "drawn" },
            body: records.workflow.body,
          })
        )
      ).resolves.toMatchObject({
        code: "knowledge.invalid",
        issues: [
          "frontmatter.app: Only a designed workflow links to an App workflow",
        ],
      });
    }
  );

  it(
    "link only a designed workflow, from its current version, by an admin, to a workflow the App runs",
    setUpTime,
    async () => {
      const admin = await personOf("admin");
      const builder = await personOf("builder");
      const appId = await appWithWorkflow(admin);
      const folder = unique();
      const drawn = await save(admin, {
        path: `${folder}/drawn.md`,
        ...records.workflow,
      });
      const designed = await save(admin, {
        path: `${folder}/designed.md`,
        record: { ...records.workflow.record, state: "designed" },
        body: "Designed.",
      });
      const team = await save(admin, {
        path: `${folder}/team.md`,
        ...records.team,
      });
      const notes = await admin.api.knowledge.createCollection({
        name: `Notes ${unique()}`,
        access: "me",
      });
      const { id: elsewhere } = await admin.api.knowledge.saveDocument({
        collectionId: notes.id,
        path: "note.md",
        text: "# Note",
        ifVersion: 0,
      });
      const linkAs = async (
        by: Person,
        changes: Partial<LinkInput>
      ): Promise<string> =>
        await outcome(
          link(by, {
            documentId: designed.id,
            ifVersion: 1,
            appId,
            workflowId: "pay",
            ...changes,
          })
        );
      // An owner of the Playbook who is no longer an admin changes it no
      // more.
      await env.KNOWLEDGE.prepare(
        "UPDATE collections SET owner = ? WHERE id = ?"
      )
        .bind(builder.userId, playbookCollectionId)
        .run();
      const demotedOwner = await linkAs(builder, {});
      await env.KNOWLEDGE.prepare(
        "UPDATE collections SET owner = ? WHERE id = ?"
      )
        .bind(admin.userId, playbookCollectionId)
        .run();
      expect({
        drawn: await refusal(
          link(admin, {
            documentId: drawn.id,
            ifVersion: 1,
            appId,
            workflowId: "pay",
          })
        ),
        notAWorkflow: await linkAs(admin, { documentId: team.id }),
        notInThePlaybook: await linkAs(admin, { documentId: elsewhere }),
        noSuchApp: await linkAs(admin, { appId: "no-such-app" }),
        noSuchWorkflow: await refusal(
          link(admin, {
            documentId: designed.id,
            ifVersion: 1,
            appId,
            workflowId: "refund",
          })
        ),
        notCurrent: await linkAs(admin, { ifVersion: 2 }),
        demotedOwner,
        user: await linkAs(await personOf("user"), {}),
        linked: await linkAs(admin, {}),
        stale: await linkAs(admin, {}),
      }).toMatchObject({
        drawn: {
          code: "knowledge.invalid",
          issues: [
            "documentId: only a designed workflow links to an App workflow",
          ],
        },
        notAWorkflow: "knowledge.invalid",
        notInThePlaybook: "knowledge.not_found",
        noSuchApp: "app.not_found",
        noSuchWorkflow: {
          code: "knowledge.invalid",
          issues: [
            `workflowId: the version of App ${appId} that runs has no workflow refund`,
          ],
        },
        notCurrent: "knowledge.conflict",
        demotedOwner: "knowledge.forbidden",
        user: "knowledge.forbidden",
        linked: "ok",
        // Linked from version 1 again, now that it is at 2.
        stale: "knowledge.conflict",
      });
    }
  );

  it(
    "freeze in a snapshot only versions that were workflow records, however they are saved",
    setUpTime,
    async () => {
      const admin = await personOf("admin");
      const folder = unique();
      // A workflow that later became a team, and a team that later became
      // a workflow: each version is judged by its own type.
      const becameTeam = `${folder}/became-team.md`;
      await save(admin, { path: becameTeam, ...records.workflow });
      await save(admin, { path: becameTeam, ifVersion: 1, ...records.team });
      const becameWorkflow = `${folder}/became-workflow.md`;
      await save(admin, { path: becameWorkflow, ...records.team });
      await save(admin, {
        path: becameWorkflow,
        ifVersion: 1,
        ...records.workflow,
      });
      const snapshotText = (workflows: { path: string; version: number }[]) =>
        textOf({
          record: { ...records.snapshot.record, workflows },
          body: "Snapshot.",
        });
      const snapshot = async (workflows: { path: string; version: number }[]) =>
        await save(admin, {
          path: `${folder}/snapshot-${unique()}.md`,
          record: { ...records.snapshot.record, workflows },
          body: "Snapshot.",
        });
      const valid = [
        { path: becameTeam, version: 1 },
        { path: becameWorkflow, version: 2 },
      ];
      const invalid = [
        { path: becameTeam, version: 2 },
        { path: becameWorkflow, version: 1 },
        { path: becameWorkflow, version: 3 },
        { path: `${folder}/refund.md`, version: 1 },
      ];
      const issues = [
        `frontmatter.workflows.0: version 2 of ${becameTeam} isn't a workflow record`,
        `frontmatter.workflows.1: version 1 of ${becameWorkflow} isn't a workflow record`,
        `frontmatter.workflows.2: the Playbook has no version 3 of ${becameWorkflow}`,
        `frontmatter.workflows.3: the Playbook has no version 1 of ${folder}/refund.md`,
      ];
      // Saved as a document, not through saveRecord.
      const raw = await refusal(
        admin.api.knowledge.saveDocument({
          collectionId: playbookCollectionId,
          path: `${folder}/raw.md`,
          text: snapshotText(invalid),
          ifVersion: 0,
        })
      );
      // Restored: an old snapshot that was valid still is. One stored with
      // references to versions that aren't there (as a bug could leave it)
      // isn't; the types of what it froze were checked when it was saved.
      const frozen = await snapshot(valid);
      await save(admin, {
        path: frozen.path,
        ifVersion: 1,
        record: { ...records.snapshot.record, workflows: [] },
        body: "Emptied.",
      });
      const restored = await outcome(
        admin.api.knowledge.restoreVersion({
          documentId: frozen.id,
          version: 1,
          ifVersion: 2,
        })
      );
      await env.KNOWLEDGE.prepare(
        "UPDATE versions SET text = ? WHERE document_id = ? AND number = 1"
      )
        .bind(snapshotText(invalid), frozen.id)
        .run();
      const badRestore = await refusal(
        admin.api.knowledge.restoreVersion({
          documentId: frozen.id,
          version: 1,
          ifVersion: 3,
        })
      );
      // A frozen version whose text no longer reads as a record isn't one.
      const unreadable = `${folder}/unreadable.md`;
      const stored = await save(admin, {
        path: unreadable,
        ...records.workflow,
      });
      await env.KNOWLEDGE.prepare(
        "UPDATE versions SET text = ? WHERE document_id = ? AND number = 1"
      )
        .bind("---\ntype: [unclosed\n---\nBody.", stored.id)
        .run();
      expect({
        saveRecord: await refusal(snapshot(invalid)),
        raw,
        valid: restored,
        badRestore,
        unreadable: await refusal(snapshot([{ path: unreadable, version: 1 }])),
      }).toStrictEqual({
        saveRecord: { code: "knowledge.invalid", issues },
        raw: { code: "knowledge.invalid", issues },
        valid: "ok",
        badRestore: { code: "knowledge.invalid", issues: issues.slice(2) },
        unreadable: {
          code: "knowledge.invalid",
          issues: [
            `frontmatter.workflows.0: version 1 of ${unreadable} isn't a workflow record`,
          ],
        },
      });
    }
  );

  it(
    "keep a snapshot valid after a purge rewrites what it froze, reading only entries it adds",
    setUpTime,
    async () => {
      const admin = await personOf("admin");
      const folder = unique();
      const purgeAs = async (documentId: string, term: string) => {
        const input = {
          type: "content" as const,
          documentIds: [documentId],
          terms: [term],
          reason: "erasure_request" as const,
        };
        const { token } = await admin.api.knowledge.preparePurge(input);
        await admin.api.knowledge.purge(input, token);
      };
      // Version 1 has a step of kind "automated"; purging that word from
      // the workflow rewrites the kind to "(removed)", which no longer fits
      // its type. The current version has no such step, so it still saves.
      const workflow = `${folder}/pay.md`;
      const pay = await save(admin, {
        path: workflow,
        record: {
          ...records.workflow.record,
          steps: [{ name: "Match", kind: "automated" }],
        },
        body: "Drawn.",
      });
      await save(admin, { path: workflow, ifVersion: 1, ...records.workflow });
      const snapshot = await save(admin, {
        path: `${folder}/snapshot.md`,
        record: {
          ...records.snapshot.record,
          workflows: [{ path: workflow, version: 1 }],
        },
        body: `Taken with Zed${folder}.`,
      });
      await purgeAs(pay.id, "automated");
      const frozenNow = await admin.api.knowledge.getDocument(pay.id, 1);
      expect(frozenNow.version.text).toContain("kind: (removed)");
      const resaved = await outcome(
        save(admin, {
          path: snapshot.path,
          ifVersion: 1,
          record: {
            ...records.snapshot.record,
            workflows: [{ path: workflow, version: 1 }],
          },
          body: `Taken with Zed${folder}, again.`,
        })
      );
      const restored = await outcome(
        admin.api.knowledge.restoreVersion({
          documentId: snapshot.id,
          version: 1,
          ifVersion: 2,
        })
      );
      const purged = await outcome(purgeAs(snapshot.id, `Zed${folder}`));
      // Added anew, the rewritten version is read, and refused.
      const added = await refusal(
        save(admin, {
          path: `${folder}/new-snapshot.md`,
          record: {
            ...records.snapshot.record,
            workflows: [{ path: workflow, version: 1 }],
          },
          body: "New.",
        })
      );

      // A large snapshot, one entry added: only that entry is read. Every
      // version it froze before is made unreadable first; were any read,
      // the save would be refused.
      const many = `${folder}/many.md`;
      await save(admin, { path: many, ...records.workflow });
      const frozenCount = 12;
      for (let version = 1; version < frozenCount; version += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one version at a time
        await save(admin, {
          path: many,
          ifVersion: version,
          ...records.workflow,
        });
      }
      const entries = (upTo: number) =>
        Array.from({ length: upTo }, (_, index) => ({
          path: many,
          version: index + 1,
        }));
      const large = await save(admin, {
        path: `${folder}/large.md`,
        record: {
          ...records.snapshot.record,
          workflows: entries(frozenCount - 1),
        },
        body: "Large.",
      });
      const largeNow = await admin.api.knowledge.getDocument(large.id);
      await env.KNOWLEDGE.prepare(
        `UPDATE versions SET text = ? WHERE number < ? AND document_id =
          (SELECT id FROM documents WHERE collection_id = ? AND path = ?)`
      )
        .bind(
          "---\ntype: [unclosed\n---",
          frozenCount,
          playbookCollectionId,
          many
        )
        .run();
      const grown = await outcome(
        save(admin, {
          path: large.path,
          ifVersion: largeNow.currentVersion,
          record: {
            ...records.snapshot.record,
            workflows: entries(frozenCount),
          },
          body: "Large, one more.",
        })
      );
      expect({ resaved, restored, purged, added, grown }).toStrictEqual({
        resaved: "ok",
        restored: "ok",
        purged: "ok",
        added: {
          code: "knowledge.invalid",
          issues: [
            `frontmatter.workflows.0: version 1 of ${workflow} isn't a workflow record`,
          ],
        },
        grown: "ok",
      });
    }
  );

  it(
    "hold personal data a content purge removes from every version, paths too, but for a snapshot's frozen ones",
    setUpTime,
    async () => {
      const admin = await personOf("admin");
      const name = `Kowalczyk${unique()}`;
      const folder = unique();
      // A path is text a person writes, a name and more (`[[Anna Visser]]`):
      // links and record fields naming a document lose the name like any
      // text. Only a snapshot's frozen workflow path is left, name and
      // longer forms of it alike, uncounted: rewritten, it would name a
      // workflow the Playbook doesn't have, and the purge would fail.
      const onboarding = `${folder}/${name}/${name}s-onboarding.md`;
      const path = `${folder}/person.md`;
      const person = await save(admin, {
        path,
        record: {
          ...records.person.record,
          title: `Anna ${name}`,
          team: `teams/${name}/finance.md`,
        },
        body: `${name} approves payments.`,
      });
      await save(admin, {
        path,
        ifVersion: 1,
        record: {
          ...records.person.record,
          title: `Anna ${name}`,
          role: `Controller, reports to ${name} senior`,
          team: `teams/${name}/finance.md`,
        },
        body: `${name} approves payments; see [[${name} Visser, Keizersgracht 12]] and [[people/${name}|${name}]].`,
      });
      const source = await save(admin, {
        path: `${folder}/source.md`,
        record: {
          ...records.source.record,
          title: `Interview with ${name}`,
          person: `${name} Visser`,
        },
        body: `Notes from ${name}.`,
      });
      await save(admin, { path: onboarding, ...records.workflow });
      const snapshot = await save(admin, {
        path: `${folder}/snapshot.md`,
        record: {
          ...records.snapshot.record,
          title: `Onboarding ${name}`,
          workflows: [{ path: onboarding, version: 1 }],
        },
        body: `Taken with ${name}.`,
      });
      const input = {
        type: "content" as const,
        documentIds: [person.id, source.id, snapshot.id],
        terms: [name],
        reason: "erasure_request" as const,
      };
      const plan = await admin.api.knowledge.preparePurge(input);
      await admin.api.knowledge.purge(input, plan.token);
      const { results } = await env.KNOWLEDGE.prepare(
        "SELECT text FROM versions WHERE document_id IN (?, ?, ?)"
      )
        .bind(person.id, source.id, snapshot.id)
        .all<{ text: string }>();
      const read = async (id: string) => {
        const current = await admin.api.knowledge.getDocument(id);
        const { frontmatter, body } = parseFrontmatter(
          current.path,
          current.version.text
        );
        return { type: current.type, title: current.title, frontmatter, body };
      };
      expect({
        plan: plan.versions,
        inLongerWords: plan.inLongerWords,
        holding: results.filter(({ text }) =>
          text.replaceAll(onboarding, "").includes(name)
        ).length,
        person: await read(person.id),
        source: await read(source.id),
        snapshot: await read(snapshot.id),
      }).toMatchObject({
        plan: 4,
        inLongerWords: 0,
        holding: 0,
        person: {
          type: "person",
          title: "Anna (removed)",
          frontmatter: {
            role: "Controller, reports to (removed) senior",
            team: "teams/(removed)/finance.md",
          },
          body: "(removed) approves payments; see [[(removed) Visser, Keizersgracht 12]] and [[people/(removed)|(removed)]].",
        },
        source: {
          title: "Interview with (removed)",
          frontmatter: { person: "(removed) Visser" },
          body: "Notes from (removed).",
        },
        snapshot: {
          title: "Onboarding (removed)",
          frontmatter: { workflows: [{ path: onboarding, version: 1 }] },
          body: "Taken with (removed).",
        },
      });
    }
  );
});
