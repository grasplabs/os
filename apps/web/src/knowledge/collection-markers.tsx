import { readOnlySources } from "@grasp-os/shared/knowledge";
import type { Collection, CollectionAccess } from "@grasp-os/shared/knowledge";
import { Badge } from "@grasp-os/ui/components/badge";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** Who may read a collection, in words. */
const accessLabels: Readonly<Record<CollectionAccess, MessageDescriptor>> = {
  everyone: msg`Everyone`,
  teams: msg`Teams`,
  me: msg`Only the owner`,
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
    <Badge variant="outline">{i18n._(accessLabels[collection.access])}</Badge>
    {collection.sensitive ? (
      <Badge variant="destructive">
        <Trans>Sensitive</Trans>
      </Badge>
    ) : null}
    {isReadOnly(collection) ? (
      <Badge variant="secondary">
        <Trans>Read-only</Trans>
      </Badge>
    ) : null}
  </span>
);
