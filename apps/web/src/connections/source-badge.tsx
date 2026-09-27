import type { CatalogSource } from "@grasp-os/shared/connect";
import { Badge } from "@grasp-os/ui/components/badge";

/**
 * Who holds a connection's tokens: our own connector (Native), or Composio's
 * cloud, a third party (Via Composio). Shown wherever a connector is, so
 * people can tell before and after they connect it.
 */
export const SourceBadge = ({ source }: { source: CatalogSource }) =>
  source === "native" ? (
    <Badge variant="secondary">Native</Badge>
  ) : (
    <Badge variant="outline">Via Composio</Badge>
  );
