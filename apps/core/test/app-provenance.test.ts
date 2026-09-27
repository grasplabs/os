import { connectionOwnersMax } from "@grasp-os/shared/connect";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { mayRead } from "../src/knowledge/access.ts";
import { outlook, requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { newTeam, readCollection, storedGrant } from "./knowledge.ts";
import { mailConnection } from "./mail-connection.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Provenance on sharing: an App keeps what it reads, so sharing it must
// reach nobody who couldn't read that where it comes from. The ways this
// could go wrong, tried below: sharing an App that read someone's mailbox
// or a sensitive collection with someone who can't read it, directly or
// through a team; the App keeping its data after its grant is revoked;
// someone joining a team after the App was shared with it; and a source
// the App is granted after it was shared.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

const newApp = async (owner: Person): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `Desk ${unique()}` });
  return id;
};

/** A personal connection of `owner`'s, such as their mailbox. */
const mailboxOf = async (owner: Person): Promise<string> => {
  const id = `connection-mailbox-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', ?, ?)"
    )
    .bind(id, owner.userId, now, now)
    .run();
  return id;
};

/** Grants `app` `connectionId`, asked for by `owner`. Returns its ID. */
const grantConnection = async (
  owner: Person,
  app: string,
  connectionId: string
): Promise<string> =>
  await requestGranted(idp, owner, {
    ...outlook(app, `MAIL_${unique().toUpperCase()}`),
    object: { type: "connection", connectionId },
  });

/** A collection for `team`'s people, and `app` granted to read it. */
const collectionFor = async (
  admin: Person,
  owner: Person,
  app: string,
  team: string,
  sensitive = false
): Promise<string> => {
  const { id } = await admin.api.knowledge.createCollection({
    name: `HR ${unique()}`,
    access: "teams",
    teams: [team],
    sensitive,
  });
  await requestGranted(
    idp,
    owner,
    readCollection(
      { type: "app", appId: app },
      id,
      `HR_${unique().toUpperCase()}`
    )
  );
  return id;
};

/**
 * A team as large as a whole department: sharing with it still answers,
 * naming exactly the people who can't read what the App read.
 */
const teamSize = 120;

const refusalSchema = z.object({
  code: z.literal("app.share_unreadable"),
  details: z.object({
    sources: z.array(z.string()),
    people: z.array(z.string()),
  }),
});

/** Why sharing `app` with `member` was refused, or "ok". */
const shareRefusal = async (
  owner: Person,
  app: string,
  member: { type: "person" | "team"; id: string }
) => {
  try {
    await owner.api.apps.members.add(app, { ...member, role: "user" });
    return "ok";
  } catch (error) {
    const { details } = refusalSchema.parse(error);
    return details;
  }
};

/** The same reads, by Knowledge and by `mayRead`. */
const same = (reads: boolean[]) => ({ knowledge: reads, mayRead: reads });

describe("who reads a collection the App read", () => {
  it("is decided just as Knowledge decides who reads it", async () => {
    const admin = await personApi("admin");
    const [member, outsider] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const team = await newTeam(admin, [member]);
    // Everyone's, a team's that its owner isn't in, and someone's own.
    const made = await Promise.all([
      admin.api.knowledge.createCollection({
        name: `All ${unique()}`,
        access: "everyone",
      }),
      admin.api.knowledge.createCollection({
        name: `Team ${unique()}`,
        access: "teams",
        teams: [team],
      }),
      member.api.knowledge.createCollection({
        name: `Mine ${unique()}`,
        access: "me",
      }),
    ]);
    const decided = async (person: Person) => {
      const [listed, { teams }] = await Promise.all([
        person.api.knowledge.listCollections(),
        person.api.whoami(),
      ]);
      const reader = {
        userId: person.userId,
        teamIds: teams.map(({ id }) => id),
      };
      return {
        knowledge: made.map(({ id }) => listed.some((one) => one.id === id)),
        mayRead: made.map(({ access, owner, teams: teamIds }) =>
          mayRead(reader, { access, owner, teamIds })
        ),
      };
    };
    await expect(
      Promise.all([admin, member, outsider].map(decided))
    ).resolves.toStrictEqual([
      same([true, true, false]),
      same([true, true, true]),
      same([true, false, false]),
    ]);
  });
});

describe("sharing an App", () => {
  it("is refused, with why, when the App read a mailbox they can't read, and audited", async () => {
    const owner = await personApi("builder");
    const [anna, admin] = await Promise.all([
      personApi("builder"),
      personApi("admin"),
    ]);
    const app = await newApp(owner);
    const mailbox = await mailboxOf(owner);
    await grantConnection(owner, app, mailbox);

    let refused: unknown;
    const events = await auditedDuring(async () => {
      refused = await shareRefusal(owner, app, {
        type: "person",
        id: anna.userId,
      });
    });
    expect(refused).toStrictEqual({
      sources: [`connection:${mailbox}`],
      people: [anna.userId],
    });
    expect(
      events.map(({ action, provenance, detail }) => ({
        action,
        provenance,
        detail,
      }))
    ).toStrictEqual([
      {
        action: "app.member.refused",
        provenance: [`connection:${mailbox}`],
        detail: {
          memberType: "person",
          member: anna.userId,
          role: "user",
          reason: "app.share_unreadable",
        },
      },
    ]);
    await expect(owner.api.apps.members.list(app)).resolves.toStrictEqual([]);

    // The owner and admins aren't checked: a team of only them is fine.
    const team = await newTeam(admin, [owner, admin]);
    await expect(
      shareRefusal(owner, app, { type: "team", id: team })
    ).resolves.toBe("ok");
  });

  it("is refused for the people of a team who can't read a collection the App read", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [anna, ben] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const hr = await newTeam(admin, [owner, anna]);
    const everyone = await newTeam(admin, [anna, ben]);
    const app = await newApp(owner);
    const collection = await collectionFor(admin, owner, app, hr, true);

    await expect(
      Promise.all([
        shareRefusal(owner, app, { type: "person", id: anna.userId }),
        shareRefusal(owner, app, { type: "team", id: everyone }),
        shareRefusal(owner, app, { type: "person", id: ben.userId }),
      ])
    ).resolves.toStrictEqual([
      "ok",
      { sources: [`collection:${collection}`], people: [ben.userId] },
      { sources: [`collection:${collection}`], people: [ben.userId] },
    ]);
  });

  it("stays refused once the App's grant is revoked: it may still hold what it read", async () => {
    const [owner, anna, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const app = await newApp(owner);
    const mailbox = await mailboxOf(owner);
    const granted = await grantConnection(owner, app, mailbox);
    await admin.api.permissions.revoke(granted);

    await expect(
      shareRefusal(owner, app, { type: "person", id: anna.userId })
    ).resolves.toMatchObject({ people: [anna.userId] });
  });

  it("counts every connection the App was granted, however many, and one connect doesn't know as nobody's", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const app = await newApp(owner);
    const mailbox = await mailboxOf(owner);
    const gone = `connection-gone-${unique()}`;
    // More shared ones than connect answers for at once, which everyone
    // may read, then the mailbox and one connect never had.
    const now = Date.now();
    const shared = Array.from(
      { length: connectionOwnersMax + 1 },
      () => `connection-shared-${unique()}`
    );
    await connectDb().batch(
      shared.map((id) =>
        connectDb()
          .prepare(
            "INSERT INTO connections (id, provider, scope, status, server_kind, server, created_at, updated_at) VALUES (?, 'mail', 'shared', 'active', 'composio', 'https://backend.composio.dev/v3/mcp/none', ?, ?)"
          )
          .bind(id, now, now)
      )
    );
    for (const [index, connectionId] of [...shared, mailbox, gone].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await storedGrant(
        { type: "app", id: app },
        { type: "connection", id: connectionId },
        ["mail.list"],
        `MAIL_${index}`
      );
    }

    await expect(
      shareRefusal(owner, app, { type: "person", id: anna.userId })
    ).resolves.toStrictEqual({
      sources: [`connection:${mailbox}`, `connection:${gone}`],
      people: [anna.userId],
    });
  });

  it("reaches anyone when the App read only what everyone may: a shared connection", async () => {
    const [owner, anna] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    const app = await newApp(owner);
    const mail = await mailConnection();
    await grantConnection(owner, app, mail.id);

    await expect(
      shareRefusal(owner, app, { type: "person", id: anna.userId })
    ).resolves.toBe("ok");
    await expect(anna.api.apps.get(app)).resolves.toMatchObject({ id: app });
  });

  it("stops reaching someone once the App is granted what they can't read, or they join a team it reaches", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [anna, ben] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const hr = await newTeam(admin, [owner, anna]);
    const shared = await newTeam(admin, [anna]);
    const app = await newApp(owner);
    await collectionFor(admin, owner, app, hr, true);
    await owner.api.apps.members.add(app, {
      type: "team",
      id: shared,
      role: "user",
    });
    const opens = async (person: Person) =>
      await outcome(person.api.apps.get(app));

    // Ben joins the team the App is shared with, but can't read HR.
    await env.DB.prepare(
      "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), shared, ben.userId, Date.now())
      .run();
    await expect(Promise.all([opens(anna), opens(ben)])).resolves.toStrictEqual(
      ["ok", "app.unreadable"]
    );

    // Then the App is granted the owner's mailbox, which Anna can't read.
    await grantConnection(owner, app, await mailboxOf(owner));
    await expect(
      Promise.all([
        opens(anna),
        outcome(anna.api.screens.version(app)),
        opens(owner),
        opens(admin),
      ])
    ).resolves.toStrictEqual(["app.unreadable", "app.unreadable", "ok", "ok"]);
  });

  it("stops reaching someone once a collection the App read no longer lets them read it", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const anna = await personApi("user");
    const [readers, others] = await Promise.all([
      newTeam(admin, [anna]),
      newTeam(admin, []),
    ]);
    const app = await newApp(owner);
    // Not sensitive: every collection the App read counts.
    const collection = await collectionFor(admin, owner, app, readers);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: anna.userId,
      role: "user",
    });
    await expect(outcome(anna.api.apps.get(app))).resolves.toBe("ok");

    await env.KNOWLEDGE.prepare(
      "UPDATE collection_teams SET team_id = ? WHERE collection_id = ?"
    )
      .bind(others, collection)
      .run();
    await expect(outcome(anna.api.apps.get(app))).resolves.toBe(
      "app.unreadable"
    );
  });

  it("checks a large team's people at once, but not those no longer in the organization", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const team = await newTeam(admin, []);
    const readers = await newTeam(admin, []);
    const app = await newApp(owner);
    await collectionFor(admin, owner, app, readers);
    const now = Date.now();
    const people = Array.from({ length: teamSize }, () => `member-${unique()}`);
    const [cannot, removed] = people;
    await env.DB.batch(
      people.flatMap((id) => [
        env.DB.prepare(
          "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Member', ?, 1, ?, ?)"
        ).bind(id, `${id}@acme.test`, now, now),
        env.DB.prepare(
          "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'user', ?)"
        ).bind(`membership-${id}`, id, now),
        env.DB.prepare(
          "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
        ).bind(`team-${id}`, team, id, now),
        // All but two of them read the collection too.
        ...(id === cannot || id === removed
          ? []
          : [
              env.DB.prepare(
                "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
              ).bind(`readers-${id}`, readers, id, now),
            ]),
      ])
    );
    const shareWithTeam = async () =>
      await shareRefusal(owner, app, { type: "team", id: team });

    const before = await shareWithTeam();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO member_removals (organization_id, user_id, removed_at) VALUES ('organization', ?, ?)"
      ).bind(removed, now),
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(`readers-${cannot}`, readers, cannot, now),
    ]);
    const after = await shareWithTeam();
    expect({
      before: before === "ok" ? before : new Set(before.people),
      // The one removed can't read it, and reaches nothing anyway.
      after,
    }).toStrictEqual({ before: new Set([cannot, removed]), after: "ok" });
  });
});
