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
 * Tool `_meta` key: the paths of the output fields that may be masked, such
 * as a message's body where a permission covers only its metadata.
 */
export const maskMetaKey = "grasp-os/mask";

/** Most resource IDs one call may report reading. */
export const maxProvenanceItems = 1000;

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
 * A path segment an action leaves open, such as `{mailbox}`, maybe with a
 * literal suffix after a colon, as Google's custom methods have it:
 * `{id}:batchUpdate`.
 */
const parameterSegment = /^\{(?<name>[A-Za-z_]\w*)\}(?<suffix>:[A-Za-z]\w*)?$/u;

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
    segments.every(
      (segment) =>
        parameterSegment.test(segment) ||
        (literalSegment.test(segment) &&
          segment !== "." &&
          segment !== ".." &&
          !isBatchSegment(segment))
    )
  );
};

export const hostSchema = z.string().regex(hostPattern);

/**
 * One request an action may send: its method, host and path, where a
 * `{name}` segment stands for any one segment. The query string is the
 * action's own.
 */
export const routeSchema = z.strictObject({
  method: z.enum(httpMethods),
  host: hostSchema,
  path: z.string().max(512).refine(isPathTemplate, "Not a path template"),
});
export type Route = z.infer<typeof routeSchema>;

/**
 * What connect knows of one action (tool) before running it, and decides
 * by before it reads a token: whether it is read-only, the input property
 * that selects its resource, its input properties, and the only requests
 * it may send.
 */
export const actionManifestSchema = z.strictObject({
  routes: z.array(routeSchema).max(32),
  readOnly: z.boolean(),
  resource: z
    .string()
    .regex(/^[A-Za-z_]\w*$/u)
    .nullable(),
  input: z.array(z.string().min(1).max(128)).max(128),
});
export type ActionManifest = z.infer<typeof actionManifestSchema>;

/** Most requests one action may declare, and hosts one connector. */
const maxHosts = 16;

export const connectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);

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
 * Characters a parameter's value may not decode to: path and query
 * delimiters, matrix and custom-method separators (`;`, `:`), a percent
 * sign (so it isn't decoded a second time), a backslash, and controls.
 */
// oxlint-disable-next-line no-control-regex -- control characters are the point
const forbiddenInValue = /[/\\?#%;:\u0000-\u001F\u007F]/u;

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
      const { name = "", suffix = "" } = parameter.groups ?? {};
      if (!given.endsWith(suffix)) {
        return false;
      }
      const decoded = decodedSegment(
        given.slice(0, given.length - suffix.length)
      );
      const bound = Object.hasOwn(values, name) ? values[name] : undefined;
      return (
        decoded !== undefined &&
        decoded !== "" &&
        decoded !== "." &&
        decoded !== ".." &&
        !forbiddenInValue.test(decoded) &&
        (bound === undefined || decoded === bound)
      );
    })
  );
};
