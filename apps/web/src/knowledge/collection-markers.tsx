import { readOnlySources } from "@grasp-os/shared/knowledge";
import type { Collection, CollectionAccess } from "@grasp-os/shared/knowledge";
import { Badge } from "@grasp-os/ui/components/badge";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  BookIcon,
  LockIcon,
  LockKeyholeIcon,
  ShieldAlertIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

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

const accessIcons: Readonly<Record<CollectionAccess, LucideIcon>> = {
  everyone: BookIcon,
  teams: UsersIcon,
  me: LockIcon,
};

/** A collection's icon in the navigation, by who may read it. */
export const CollectionIcon = ({
  collection,
  className,
}: {
  collection: Pick<Collection, "access">;
  className?: string;
}) => {
  const Icon = accessIcons[collection.access];
  return <Icon aria-hidden="true" className={className} />;
};

/**
 * The navigation's short form of the markers: an icon each for sensitive
 * and read-only, named for whoever can't see it. Who may read it is the
 * collection's own icon.
 */
export const CollectionMarks = ({ collection }: { collection: Collection }) => {
  const { t } = useLingui();
  return (
    <>
      {collection.sensitive ? (
        <>
          <ShieldAlertIcon
            aria-hidden="true"
            className="text-status-attention size-3.5 flex-none"
          />
          <span className="sr-only">{t`Sensitive`}</span>
        </>
      ) : null}
      {isReadOnly(collection) ? (
        <>
          <LockKeyholeIcon
            aria-hidden="true"
            className="text-muted-foreground size-3.5 flex-none"
          />
          <span className="sr-only">{t`Read-only`}</span>
        </>
      ) : null}
    </>
  );
};
