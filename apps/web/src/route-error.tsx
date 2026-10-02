import { failureText, withReference } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { isPageFault, reportError } from "./error-reports.ts";
import { ErrorText } from "./error-text.tsx";
import { SiteHeader } from "./frame/site-header.tsx";

/**
 * What a page shows in place of itself when it failed, whatever the route:
 * core's reason with its reference, or, for a fault of the page's own, a
 * plain "something went wrong" with the reference its report got, so the
 * person can quote either. The page's own errors never show their message:
 * it names code, not anything the person can act on.
 */
export const RouteError = ({ error }: ErrorComponentProps) => {
  const router = useRouter();
  const { t } = useLingui();
  const [reference, setReference] = useState<{
    error: unknown;
    requestId?: string;
  }>();
  useEffect(() => {
    let current = true;
    const report = async (): Promise<void> => {
      const requestId = await reportError("render", error);
      if (current) {
        setReference({ error, requestId });
      }
    };
    void report();
    return () => {
      current = false;
    };
  }, [error]);
  const reason = isPageFault(error)
    ? withReference(
        t`Something went wrong.`,
        reference !== undefined && reference.error === error
          ? reference.requestId
          : undefined
      )
    : failureText(error);
  // Inside the frame (the shell loaded, a page under it failed), the page
  // keeps its header, and with it the way to the sidebar on a phone.
  const inFrame = useRouterState({
    select: ({ matches }) =>
      matches.some(
        ({ routeId, status }) => routeId === "/_shell" && status === "success"
      ),
  });
  const title = t`This page didn't load`;
  // Not a <main>: inside the shell it shows in the frame's.
  return (
    <>
      {inFrame ? <SiteHeader crumbs={[{ label: title }]} /> : null}
      <div className="flex flex-col items-start gap-4 p-6">
        <h1 className="text-2xl font-medium">{title}</h1>
        <ErrorText>{reason}</ErrorText>
        <Button
          variant="outline"
          onClick={() => {
            void router.invalidate();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    </>
  );
};
