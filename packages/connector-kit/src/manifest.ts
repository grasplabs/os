import { auditIdentifierMaxLength } from "@grasp-os/shared/audit";
import { oauthProviderSchema } from "@grasp-os/shared/connect";
import { permissionActionSchema } from "@grasp-os/shared/permissions";
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
 * (the request never left) or `failed` (it left, but its answer is
 * withheld: a redirect, or unreachable). A response past the size limit
 * isn't one of these: its body fails once the limit is passed. Never on a
 * provider's: the egress drops it from theirs.
 */
export const egressHeader = "grasp-egress";

/** The kinds of answer connect's egress gives itself, as `egressHeader` says. */
export const egressKind = {
  refused: "refused",
  failed: "failed",
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

const hostSchema = z.string().regex(hostPattern);

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
 * `{name}` segment stands for any one segment. A `{name}` segment named
 * after the action's resource property holds the resource a call's
 * capability names. The query string and the body are the action's own.
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
  })
  .refine(
    ({ method, redirects }) => redirects === undefined || method === "GET",
    "Only a GET may follow a redirect"
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
