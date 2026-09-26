import { auditIdentifierMaxLength } from "@grasp-os/shared/audit";
import { oauthProviderSchema } from "@grasp-os/shared/connect";
import {
  maskFieldSchema,
  permissionActionSchema,
} from "@grasp-os/shared/permissions";
import { z } from "zod";

// A native connector's manifest: what connect knows of it without running
// it. Connect's build reads it from the connector's module and ships it
// next to the module's code, so connect decides by the manifest alone which
// provider's token a call gets, and where that call may go (threat model
// R9, Q11): the connector's code can't widen either.

/**
 * Tool `_meta` key: the name of the one input property that selects the
 * resource (a mailbox, a calendar) a call of the tool acts on.
 */
export const resourceMetaKey = "grasp-os/resource";

/** Result `_meta` key: the IDs of the resources the call read. */
export const provenanceMetaKey = "grasp-os/provenance";

/**
 * Result `_meta` key: `true` on an error result (`isError`) says the tool
 * did nothing at all, so trying again can't do anything twice: its
 * provider rate limited it, say, before it sent any write. A connector
 * sets it with `new ToolError(message, { notPerformed: true })`. Connect
 * then frees the call's idempotency key and answers
 * `connect.server_unavailable`, which a workflow step retries. Without it,
 * a tool's error is final: the tool may have acted before it failed, so
 * its answer is kept for the key.
 *
 * Connect takes this only from native connectors, whose code is ours and
 * reviewed. A Composio or other remote server setting it is ignored: its
 * tools are code we don't review, and a tool that acted and then claimed
 * it hadn't would get its side effect run twice. Nor does connect take a
 * remote server's HTTP 429 as "nothing done": a server of its own making
 * may send one for its provider's 429 after a first write.
 */
export const notPerformedMetaKey = "grasp-os/not-performed";

/**
 * Tool `_meta` key: the paths of the output fields that may be masked, such
 * as a message's body where a permission covers only its metadata.
 */
export const maskMetaKey = "grasp-os/mask";

/**
 * Response header on the answers connect's egress gives itself: `refused`
 * (the request never left), `failed` (it left, but its answer is
 * withheld: a redirect, too large, unreachable) or `downloads-off` (a
 * download's redirect, while the deployment names no download hosts).
 * Never on a provider's: the egress drops it from theirs.
 */
export const egressHeader = "grasp-egress";

/** The kinds of answer connect's egress gives itself, as `egressHeader` says. */
export const egressKind = {
  refused: "refused",
  failed: "failed",
  downloadsOff: "downloads-off",
} as const;
export type EgressKind = (typeof egressKind)[keyof typeof egressKind];

/** Most resource IDs one call may report reading. */
export const maxProvenanceItems = 1000;

/** The IDs of the resources a call read, as a tool reports them. */
export const provenanceSchema = z
  .array(z.string().min(1).max(auditIdentifierMaxLength))
  .max(maxProvenanceItems);

/** The MCP revision connect and the connectors speak. */
export const mcpProtocolVersion = "2025-06-18";

/** Longest wait a throttled answer passes on, in seconds. */
export const maxRetryAfterSeconds = 3600;

/** The methods an action may declare. */
export const httpMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

/**
 * A provider host, as the egress handler compares it: a lowercase DNS name
 * with at least two labels and a top-level label that starts with a letter,
 * so never an IP address, a port or userinfo.
 */
const hostPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** A path segment an action names as it is, such as `v1.0` or `$value`. */
const literalSegment = /^[\w.~$:@()'-]+$/u;

/**
 * A path segment an action leaves open, such as `{mailbox}`, maybe inside
 * literal text: a suffix after a colon, as Google's custom methods have it
 * (`{id}:batchUpdate`), or an OData function call around it, as Graph's
 * search has it (`search(q='{query}')`). One parameter per segment.
 */
const parameterSegment =
  /^(?<prefix>[\w.~$@()'=-]*)\{(?<name>[A-Za-z_]\w*)\}(?<suffix>[\w.~$:@()'=-]*)$/u;

/**
 * Batch endpoints (Graph's `/$batch`, Google's `/batch/...`) carry any
 * number of requests to any path in one body, past the path allowlist:
 * never declared.
 */
const isBatchSegment = (segment: string): boolean => {
  const lower = segment.toLowerCase();
  return lower === "batch" || lower.startsWith("$batch");
};

/** Whether a path template has a `{name}` segment (maybe with a suffix). */
const namesParameter = (path: string, name: string): boolean =>
  path
    .split("/")
    .some((segment) => parameterSegment.exec(segment)?.groups?.name === name);

/** A query parameter's value an action leaves open: `{name}`, all of it. */
const queryParameter = /^\{(?<name>[A-Za-z_]\w*)\}$/u;

/** A query parameter's value an action names as it is, such as `drive`. */
const literalQueryValue = /^[\w.~:@$-]{1,256}$/u;

/** A query parameter's name, as a route declares one. */
const queryKeySchema = z.string().regex(/^[A-Za-z_$][\w.$-]{0,63}$/u);

/** The names of a path template's parameters. */
const parametersOf = (path: string): string[] =>
  path
    .split("/")
    .flatMap((segment) => parameterSegment.exec(segment)?.groups?.name ?? []);

/** Whether a route names `name` as a parameter, in its path or its query. */
const routeNames = (
  { path, query = {} }: { path: string; query?: Record<string, string> },
  name: string
): boolean =>
  namesParameter(path, name) ||
  Object.values(query).some(
    (value) => queryParameter.exec(value)?.groups?.name === name
  );

/** Whether `path` is a path template: `/` and one or more segments. */
const isPathTemplate = (path: string): boolean => {
  const [empty, ...segments] = path.split("/");
  return (
    empty === "" &&
    segments.length > 0 &&
    segments.every((segment) => {
      const parameter = parameterSegment.exec(segment);
      // A parameter's literal text is never a batch endpoint's either.
      return parameter === null
        ? literalSegment.test(segment) &&
            segment !== "." &&
            segment !== ".." &&
            !isBatchSegment(segment)
        : !isBatchSegment(parameter.groups?.prefix ?? "");
    })
  );
};

export const hostSchema = z.string().regex(hostPattern);

/**
 * Hosts a redirect may lead to, as `*.<host>`: the `*` stands for exactly
 * one DNS label, such as a SharePoint tenant's `contoso` in
 * `contoso.sharepoint.com`.
 */
const redirectHostSchema = z
  .string()
  .refine(
    (pattern) => pattern.startsWith("*.") && hostPattern.test(pattern.slice(2)),
    "Not a redirect host: *.<host>"
  );

/** One DNS label, as a redirect host's `*` stands for. */
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** Whether `hostname` (lowercase, as a URL has it) is one `pattern` allows. */
export const redirectHostMatches = (
  pattern: string,
  hostname: string
): boolean => {
  const base = `.${pattern.slice(2)}`;
  return (
    pattern.startsWith("*.") &&
    hostname.endsWith(base) &&
    dnsLabel.test(hostname.slice(0, -base.length))
  );
};

/**
 * One request an action may send: its method, host and path, where a
 * `{name}` segment stands for any one segment. The query string is the
 * action's own, but for the parameters `query` names: each must be sent
 * exactly once, with the literal value given, or any one value for a
 * `{name}` (bound, as a path's is, where the call binds `name`). That is
 * how a route names its resource where the provider takes it in the query
 * (Google Drive's `driveId`).
 *
 * A GET of a resource-scoped action may declare a `check` instead of
 * naming the resource, where the provider's API has no place for it in
 * the request (Google Drive addresses a file by its ID alone). Before
 * the egress sends such a request, it sends the check itself: a GET on
 * the same host to `check.path`, with the route's parameters as the
 * request has them and the check's own query, with the token and nothing
 * of the connector's. It sends the request only if the check's JSON
 * answer has `check.field` equal to the resource the call is bound to
 * (`check.equals`, `{resource}`), and refuses it otherwise.
 *
 * A GET may name `redirects`: the hosts connect's egress follows one
 * redirect of its answer to, itself, without the token or any of the
 * connector's headers, and never a second one. That is how a download
 * works where the provider answers with a redirect to a pre-authenticated
 * URL on its storage hosts (Graph to SharePoint). Every other redirect is
 * refused.
 */
export const routeSchema = z
  .strictObject({
    method: z.enum(httpMethods),
    host: hostSchema,
    path: z.string().max(512).refine(isPathTemplate, "Not a path template"),
    redirects: z.array(redirectHostSchema).min(1).max(4).optional(),
    query: z
      .record(
        queryKeySchema,
        z
          .string()
          .refine(
            (value) =>
              queryParameter.test(value) || literalQueryValue.test(value),
            "Not a query value: a literal or {name}"
          )
      )
      .refine((query) => Object.keys(query).length <= 8, "Too many")
      .optional(),
    check: z
      .strictObject({
        path: z.string().max(512).refine(isPathTemplate, "Not a path template"),
        query: z
          .record(queryKeySchema, z.string().regex(literalQueryValue))
          .optional(),
        field: z.string().regex(/^[A-Za-z_]\w{0,63}$/u),
        equals: z.string().regex(queryParameter),
      })
      .optional(),
  })
  .refine(
    ({ method, redirects }) => redirects === undefined || method === "GET",
    "Only a GET may follow a redirect"
  )
  .refine(
    ({ method, check }) => check === undefined || method === "GET",
    "Only a GET may declare a check"
  )
  .refine(
    ({ path, check }) =>
      check === undefined ||
      parametersOf(check.path).every((name) =>
        parametersOf(path).includes(name)
      ),
    "A check may use only its route's own path parameters"
  );
export type Route = z.infer<typeof routeSchema>;

/** Most requests one action may declare. */
const maxRoutes = 32;

/**
 * What connect knows of one action (tool) before running it, and decides
 * by before it reads a token: whether it is read-only, the input property
 * that selects its resource, its input properties, and the only requests
 * it may send.
 */
const actionManifestSchema = z.strictObject({
  routes: z.array(routeSchema).max(maxRoutes),
  readOnly: z.boolean(),
  resource: z
    .string()
    .regex(/^[A-Za-z_]\w*$/u)
    .nullable(),
  input: z.array(z.string().min(1).max(128)).max(128),
  /**
   * The output fields (dotted paths, through arrays) that may be masked. A
   * permission masks fields by name: each of these whose last segment is
   * one of its names.
   */
  mask: z.array(z.string().min(1).max(256)).max(64).default([]),
  /**
   * Inputs that search through fields that may be masked, each with those
   * fields' names, such as `{ search: ["body"] }`: a search's hits would
   * tell what a masked field holds, so connect refuses a call that uses
   * one while its permission masks any of them.
   */
  searches: z
    .record(z.string().min(1).max(128), z.array(maskFieldSchema).max(16))
    .default({}),
});
export type ActionManifest = z.infer<typeof actionManifestSchema>;

/** Most hosts one connector may reach. */
const maxHosts = 16;

const connectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);

export const connectorManifestSchema = z
  .strictObject({
    name: connectorNameSchema,
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u),
    /** Whose OAuth token a call gets: a connection with this provider's. */
    provider: oauthProviderSchema,
    /** The OAuth scopes its actions need, all among those connect asks for. */
    scopes: z.array(z.string().min(1).max(256)).max(64),
    /** Every host it may reach, exactly. */
    hosts: z.array(hostSchema).min(1).max(maxHosts),
    /** Each action (tool) by name, and the only requests it may send. */
    actions: z.record(permissionActionSchema, actionManifestSchema),
  })
  .refine(
    ({ hosts, actions }) =>
      Object.values(actions).every(({ routes }) =>
        routes.every(({ host }) => hosts.includes(host))
      ),
    "Every route's host must be one of the connector's hosts"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ resource, input }) => resource === null || input.includes(resource)
      ),
    "An action's resource must be one of its input properties"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(({ searches, input }) =>
        Object.keys(searches).every((name) => input.includes(name))
      ),
    "An action's searches must be among its input properties"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ resource, routes }) =>
          resource === null ||
          routes.every(
            (route) =>
              routeNames(route, resource) ||
              route.check?.equals === `{${resource}}`
          )
      ),
    // So the egress always binds it to the resource a capability names,
    // or checks it with the provider where the request can't name it.
    "Every route of an action with a resource must name it as a {segment}, in its path or its query, or check it"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ resource, routes }) =>
          resource !== null || routes.every(({ check }) => check === undefined)
      ),
    "Only an action with a resource may check it"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ routes }) =>
          routes.filter(({ method }) => method !== "GET" && method !== "HEAD")
            .length <= 1
      ),
    // A tool writes at most once, as its last request, so a provider's
    // "nothing done" (429) for the call holds for all of it (R7): a tool
    // with two write routes could have written with the first.
    "An action may declare at most one write (a method other than GET or HEAD)"
  );
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

const decodedSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/**
 * The characters a parameter's value may not decode to, as a regex
 * character class's contents: path and query delimiters, matrix and
 * custom-method separators (`;`, `:`), a percent sign (so it isn't decoded
 * a second time), a backslash, and controls.
 */
export const forbiddenInValue = String.raw`/\\?#%;:\u0000-\u001F\u007F`;

/**
 * A parameter's value, decoded: text with none of `forbiddenInValue`. A
 * connector checks its path inputs by it, so a bad value is refused with a
 * clear message before anything goes out.
 */
export const segmentValuePattern = new RegExp(`^[^${forbiddenInValue}]+$`, "u");

/** A run of quotes of odd length: one that ends a quoted literal. */
const unpairedQuote = /(?<!')(?:'')*'(?!')/u;

/**
 * Whether a parameter's decoded value is plain text where it stands. On
 * its own in a segment, the value is the segment, so it may not be a dot
 * segment or a batch endpoint; inside literal text it is neither. Inside
 * quotes (OData's `'...'`), a quote may only come doubled, as OData
 * escapes it, so the value can't end the literal early.
 */
const isValueAllowed = (
  decoded: string,
  prefix: string,
  suffix: string
): boolean => {
  if (!segmentValuePattern.test(decoded)) {
    return false;
  }
  if (prefix === "" && suffix === "") {
    return decoded !== "." && decoded !== ".." && !isBatchSegment(decoded);
  }
  const quoted = prefix.endsWith("'") && suffix.startsWith("'");
  return !(quoted && unpairedQuote.test(decoded));
};

/**
 * Whether a URL's path (as `URL.pathname` gives it: dot segments resolved,
 * still percent-encoded) is one the template allows. A `{name}` segment
 * takes one non-empty value that decodes to plain text: no path of its own
 * (`..`, a slash), nothing a server could read as a delimiter, and no
 * percent sign to decode again. Where `values` names a parameter, its
 * value must decode to exactly that (the resource a capability names).
 */
export const pathMatches = (
  template: string,
  pathname: string,
  values: Readonly<Record<string, string>> = {}
): boolean => {
  const expected = template.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => {
      const given = actual[index] ?? "";
      const parameter = parameterSegment.exec(segment);
      if (parameter === null) {
        return given === segment;
      }
      const { prefix = "", name = "", suffix = "" } = parameter.groups ?? {};
      if (
        given.length < prefix.length + suffix.length ||
        !given.startsWith(prefix) ||
        !given.endsWith(suffix)
      ) {
        return false;
      }
      const decoded = decodedSegment(
        given.slice(prefix.length, given.length - suffix.length)
      );
      const bound = Object.hasOwn(values, name) ? values[name] : undefined;
      return (
        decoded !== undefined &&
        isValueAllowed(decoded, prefix, suffix) &&
        (bound === undefined || decoded === bound)
      );
    })
  );
};

// oxlint-disable-next-line no-control-regex -- control characters are the point
const controlCharacter = /[\u0000-\u001F\u007F]/u;

/**
 * A query parameter's name as a provider may also read it: Google takes
 * `drive_id` for `driveId`, and ignores case and punctuation elsewhere.
 */
const spellingOf = (key: string): string =>
  key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");

/** Letters a provider's alias of a parameter shares with its name (Drive's `corpus` for `corpora`). */
const stemLength = 4;

/**
 * Whether another parameter of a query could be read as `key`: the same
 * name in any spelling (`drive_id`, `driveId[]`, ` driveId`), one that
 * contains it (Drive's `teamDriveId` for `driveId`), or one with its stem
 * (Drive's `corpus` for `corpora`).
 */
const couldBeReadAs = (other: string, key: string): boolean => {
  const spelled = spellingOf(other);
  const name = spellingOf(key);
  return (
    spelled.includes(name) ||
    (spelled.length >= stemLength &&
      spelled.slice(0, stemLength) === name.slice(0, stemLength))
  );
};

/**
 * Whether a URL's query (`search`, as `URL.search` gives it) has each
 * parameter the route's `query` names exactly once, and no other
 * parameter a provider could read as it (see `couldBeReadAs`), with its
 * literal value, or, for a `{name}`, a non-empty value without control
 * characters, equal to `values[name]` where that is given. A query that
 * names parameters has no raw `;`, which some servers split pairs at.
 * Other parameters are the connector's own.
 */
export const queryMatches = (
  query: Readonly<Record<string, string>> | undefined,
  search: string,
  values: Readonly<Record<string, string>> = {}
): boolean => {
  const entries = Object.entries(query ?? {});
  if (entries.length === 0) {
    return true;
  }
  if (search.includes(";")) {
    return false;
  }
  const searchParams = new URLSearchParams(search);
  const keys = [...searchParams.keys()];
  return entries.every(([key, expected]) => {
    const value = searchParams.get(key);
    const readable = keys.filter((each) => couldBeReadAs(each, key));
    if (readable.length !== 1 || readable[0] !== key || value === null) {
      return false;
    }
    const name = queryParameter.exec(expected)?.groups?.name;
    if (name === undefined) {
      return value === expected;
    }
    const bound = Object.hasOwn(values, name) ? values[name] : undefined;
    return (
      value !== "" &&
      !controlCharacter.test(value) &&
      (bound === undefined || value === bound)
    );
  });
};

/** A route's check, as the egress sends it before the route's request. */
export interface ResourceCheck {
  url: URL;
  field: string;
  /** The value the check's answer must name: the bound resource. */
  expected: string;
}

/**
 * The check `route` declares for a request to `url` (which matched the
 * route's path), with the request's own path parameters; `undefined` when
 * it declares none, or the call binds no resource to check against (as a
 * path parameter isn't bound then); `null` when the check's URL isn't one
 * its template allows (a value that becomes a dot segment there, say), so
 * the request must be refused.
 */
export const resourceCheckFor = (
  route: Route,
  url: URL,
  values: Readonly<Record<string, string>>
): ResourceCheck | undefined | null => {
  const { check } = route;
  const name =
    check === undefined
      ? undefined
      : queryParameter.exec(check.equals)?.groups?.name;
  if (
    check === undefined ||
    name === undefined ||
    !Object.hasOwn(values, name)
  ) {
    return undefined;
  }
  const given = new Map<string, string>();
  const actual = url.pathname.split("/");
  for (const [index, segment] of route.path.split("/").entries()) {
    const parameter = parameterSegment.exec(segment)?.groups;
    const raw = actual[index] ?? "";
    if (parameter?.name !== undefined) {
      given.set(
        parameter.name,
        raw.slice(
          (parameter.prefix ?? "").length,
          raw.length - (parameter.suffix ?? "").length
        )
      );
    }
  }
  const path = check.path
    .split("/")
    .map((segment) => {
      const parameter = parameterSegment.exec(segment)?.groups;
      return parameter?.name === undefined
        ? segment
        : `${parameter.prefix ?? ""}${given.get(parameter.name) ?? ""}${parameter.suffix ?? ""}`;
    })
    .join("/");
  const checkUrl = new URL(`https://${route.host}${path}`);
  for (const [key, value] of Object.entries(check.query ?? {})) {
    checkUrl.searchParams.set(key, value);
  }
  // A value allowed inside its route's segment may stand alone in the
  // check's, where `new URL` resolves `.` and `..` to another path.
  if (!pathMatches(check.path, checkUrl.pathname)) {
    return null;
  }
  return { url: checkUrl, field: check.field, expected: values[name] ?? "" };
};
