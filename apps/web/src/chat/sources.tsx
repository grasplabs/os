import type { ChatProvenance } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { Plural, Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  BookIcon,
  BookOpenIcon,
  CableIcon,
  ChevronDownIcon,
} from "lucide-react";

// What the chat's answers may hold, in the prototype's sources look
// (grasplabs/prototype `components/ai-elements/sources.tsx`): the
// collections and connections core says the chat read from, each
// collection one link away in Knowledge. Only what core reports: the page
// never guesses a source.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
  /** A collection opens in Knowledge; a connection is only named. */
  kind: "collection" | "connection";
}

export const ChatSources = ({
  provenance,
  names,
}: {
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
}) => {
  const { sources, restricted } = provenance;
  const count = sources.length;
  if (count === 0 && !restricted) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-start gap-2 text-xs">
      {restricted ? (
        <Badge variant="destructive">
          <Trans>Restricted</Trans>
        </Badge>
      ) : null}
      {count === 0 ? null : (
        <details className="group text-primary">
          <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <BookOpenIcon aria-hidden="true" className="size-3.5" />
            <span className="font-medium">
              <Plural
                one="Answers draw on # source"
                other="Answers draw on # sources"
                value={count}
              />
            </span>
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3.5 transition-transform group-open:rotate-180"
            />
          </summary>

          <ul className="mt-3 flex w-fit flex-col gap-2">
            {sources.map((id) => {
              const source = names.get(id);
              const name = source?.name ?? id;
              return (
                <li key={id}>
                  {source?.kind === "collection" ? (
                    <Link
                      className="flex items-center gap-2 font-medium hover:underline"
                      params={{ collection: id }}
                      search={{}}
                      to="/knowledge/$collection"
                    >
                      <BookIcon aria-hidden="true" className="size-4" />
                      {name}
                    </Link>
                  ) : (
                    <span className="flex items-center gap-2 font-medium">
                      <CableIcon aria-hidden="true" className="size-4" />
                      {name}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
};
