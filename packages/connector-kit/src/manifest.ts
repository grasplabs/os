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

/** A path segment an action leaves open, such as `{mailbox}`. */
const parameterSegment = /^\{[A-Za-z_]\w*\}$/u;

/** Whether `path` is a path template: `/` and one or more segments. */
const isPathTemplate = (path: string): boolean => {
  const [empty, ...segments] = path.split("/");
  return (
    empty === "" &&
    segments.length > 0 &&
    segments.every(
      (segment) =>
        parameterSegment.test(segment) ||
        (literalSegment.test(segment) && segment !== "." && segment !== "..")
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

/** Most requests one action may declare, and hosts one connector. */
const maxRoutes = 32;
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
    actions: z.record(
      permissionActionSchema,
      z.strictObject({ routes: z.array(routeSchema).max(maxRoutes) })
    ),
  })
  .refine(
    ({ hosts, actions }) =>
      Object.values(actions).every(({ routes }) =>
        routes.every(({ host }) => hosts.includes(host))
      ),
    "Every route's host must be one of the connector's hosts"
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
 * Whether a URL's path (as `URL.pathname` gives it: dot segments resolved,
 * still percent-encoded) is one the template allows. A `{name}` segment
 * takes any one non-empty segment that doesn't decode to a path of its own
 * (`..`, or one with a slash in it), so a value can't climb out of its
 * place on a server that decodes it.
 */
export const pathMatches = (template: string, pathname: string): boolean => {
  const expected = template.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => {
      const given = actual[index] ?? "";
      if (!parameterSegment.test(segment)) {
        return given === segment;
      }
      const decoded = decodedSegment(given);
      return (
        decoded !== undefined &&
        decoded !== "" &&
        decoded !== "." &&
        decoded !== ".." &&
        !decoded.includes("/") &&
        !decoded.includes("\\")
      );
    })
  );
};
