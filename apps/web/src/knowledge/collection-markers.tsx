import { readOnlySources } from "@grasp-os/shared/knowledge";
import type { Collection, CollectionAccess } from "@grasp-os/shared/knowledge";
import { Badge } from "@grasp-os/ui/components/badge";

/** Who may read a collection, in words. */
const accessLabels: Readonly<Record<CollectionAccess, string>> = {
  everyone: "Everyone",
  teams: "Teams",
  me: "Only the owner",
};

/** Whether nobody may change `collection` here: Grasp or an App writes it. */
const isReadOnly = ({ source }: Collection): boolean =>
  readOnlySources.has(source);

/** Who may read a collection, and whether it is sensitive or read-only. */
export const CollectionMarkers = ({
  collection,
}: {
  collection: Collection;
}) => (
  <span className="flex flex-wrap gap-1">
    <Badge variant="outline">{accessLabels[collection.access]}</Badge>
    {collection.sensitive ? (
      <Badge variant="destructive">Sensitive</Badge>
    ) : null}
    {isReadOnly(collection) ? (
      <Badge variant="secondary">Read-only</Badge>
    ) : null}
  </span>
);
