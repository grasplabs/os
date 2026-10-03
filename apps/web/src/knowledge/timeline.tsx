import type { DocumentRead, VersionSummary } from "@grasp-os/shared/knowledge";
import { Button } from "@grasp-os/ui/components/button";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { splitHistory } from "./history.ts";

// A document's history as the prototype's note timeline
// (grasplabs/prototype `routes/brain/$noteId.tsx`): each version on a line
// down the side, with when, who saved it and what changed, the latest five
// shown and older ones folded by month. Each opens for reading; where the
// person may change the document, an earlier one can be restored, saved
// again as the next.

/**
 * One version on the timeline: it opens for reading, and an earlier one
 * can be restored.
 */
const Saved = ({
  doc,
  version,
  me,
  restore,
}: {
  doc: DocumentRead;
  version: VersionSummary;
  me: string;
  /** Restores it, where the person may; undefined where they may not. */
  restore: ((version: number) => void) | undefined;
}) => {
  const current = version.number === doc.currentVersion;
  const shown = version.number === doc.version.number;
  const { t, i18n } = useLingui();
  const { number, restoredFrom } = version;
  const when = new Date(version.createdAt).toLocaleDateString(i18n.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const who = version.author === me ? t`You` : version.author;
  return (
    <li aria-label={t`Version ${number}`} className="flex gap-3">
      <span className="text-muted-foreground w-22 flex-none text-xs leading-5">
        <time dateTime={version.createdAt}>{when}</time>
      </span>
      <div
        className={
          shown
            ? "border-foreground flex min-w-0 flex-1 flex-col gap-0.5 border-l-2 pb-3 pl-3"
            : "flex min-w-0 flex-1 flex-col gap-0.5 border-l-2 pb-3 pl-3"
        }
      >
        <span className="flex items-center justify-between gap-2">
          <Link
            aria-current={shown ? "page" : undefined}
            className="font-medium hover:underline aria-[current=page]:no-underline"
            params={{ collection: doc.collectionId }}
            search={
              current ? { doc: doc.id } : { doc: doc.id, version: number }
            }
            to="/knowledge/$collection"
          >
            {current ? t`Version ${number}, current` : t`Version ${number}`}
          </Link>
          {restore === undefined || current ? null : (
            <Button
              aria-label={t`Restore version ${number}`}
              onClick={() => {
                restore(number);
              }}
              size="xs"
              variant="ghost"
            >
              <Trans>Restore</Trans>
            </Button>
          )}
        </span>
        <span className="text-muted-foreground text-xs">
          {[
            who,
            restoredFrom === null
              ? version.message
              : t`Restored version ${restoredFrom}`,
          ]
            .filter((part) => part !== null && part !== "")
            .join(" · ")}
        </span>
      </div>
    </li>
  );
};

/** The timeline of the document's versions. */
export const Timeline = ({
  doc,
  versions,
  me,
  writable,
}: {
  doc: DocumentRead;
  versions: VersionSummary[];
  me: string;
  writable: boolean;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const { i18n } = useLingui();
  const [unfolded, setUnfolded] = useState(false);
  const headingId = useId();
  const { earlier, recent } = splitHistory(versions);
  const folded = earlier.reduce((sum, month) => sum + month.versions.length, 0);
  const restore = async (version: number): Promise<void> => {
    await run(async (session) => {
      // Read again whatever the outcome: a restore refused as a conflict
      // means the page shows an old version.
      await changeThenRefresh(
        async () =>
          await session.knowledge.restoreVersion({
            documentId: doc.id,
            version,
            ifVersion: doc.currentVersion,
          }),
        async () => {
          // The restored text is the current version now: show it.
          await navigate({
            to: "/knowledge/$collection",
            params: { collection: doc.collectionId },
            search: { doc: doc.id },
          });
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const canRestore =
    writable && !busy
      ? (version: number) => {
          void restore(version);
        }
      : undefined;
  const count = versions.length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2
        className="text-muted-foreground flex items-baseline justify-between text-sm"
        id={headingId}
      >
        <span>
          <Trans>History</Trans>
        </span>
        <span>
          <Plural one="# version" other="# versions" value={count} />
        </span>
      </h2>
      <ErrorText>{failure}</ErrorText>
      <div className="flex flex-col text-sm">
        {folded === 0 ? null : (
          <Button
            aria-expanded={unfolded}
            className="mb-2 -ml-2 self-start"
            onClick={() => {
              setUnfolded(!unfolded);
            }}
            size="xs"
            variant="ghost"
          >
            <ChevronRightIcon
              className={
                unfolded
                  ? "rotate-90 transition-transform"
                  : "transition-transform"
              }
            />
            <Plural one="# earlier" other="# earlier" value={folded} />
          </Button>
        )}
        <ol className="flex flex-col">
          {unfolded
            ? earlier.map((month) => (
                <li className="flex flex-col" key={month.month}>
                  <p className="text-muted-foreground pb-2 text-xs">
                    {new Date(`${month.month}-01T00:00:00Z`).toLocaleDateString(
                      i18n.locale,
                      { month: "short", year: "numeric", timeZone: "UTC" }
                    )}
                  </p>
                  <ol className="flex flex-col">
                    {month.versions.map((version) => (
                      <Saved
                        doc={doc}
                        key={version.number}
                        me={me}
                        restore={canRestore}
                        version={version}
                      />
                    ))}
                  </ol>
                </li>
              ))
            : null}
          {recent.map((version) => (
            <Saved
              doc={doc}
              key={version.number}
              me={me}
              restore={canRestore}
              version={version}
            />
          ))}
        </ol>
      </div>
    </section>
  );
};
