import { Button } from "@grasp-os/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import { Trans, useLingui } from "@lingui/react/macro";
import { PanelLeftIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import type { KnowledgeNavData } from "./nav-data.ts";
import { KnowledgeNav, KnowledgeTree } from "./nav.tsx";
import type { KnowledgeAt } from "./nav.tsx";

/**
 * Every Knowledge page: the site header, the navigation beside the page,
 * and on a phone the navigation in a sheet (grasplabs/prototype
 * `routes/brain.tsx`). The page beside it scrolls on its own.
 */
export const KnowledgeFrame = ({
  crumbs,
  actions,
  data,
  at,
  children,
}: {
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  data: KnowledgeNavData;
  at: KnowledgeAt;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <SiteHeader
        actions={
          <>
            <Button
              className="md:hidden"
              onClick={() => {
                setSheet(true);
              }}
              size="sm"
              variant="outline"
            >
              <PanelLeftIcon data-icon="inline-start" />
              <Trans>Browse</Trans>
            </Button>
            {actions}
          </>
        }
        crumbs={crumbs}
      />
      <div className="flex min-h-0 flex-1">
        <KnowledgeNav at={at} data={data} />
        <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
      </div>
      <Sheet onOpenChange={setSheet} open={sheet}>
        <SheetContent closeLabel={t`Close`} side="left">
          <SheetTitle className="sr-only">
            <Trans>Knowledge</Trans>
          </SheetTitle>
          <KnowledgeTree at={at} data={data} />
        </SheetContent>
      </Sheet>
    </>
  );
};
