import { failureText, withReference } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { isPageFault, reportError } from "./error-reports.ts";
import { ErrorText } from "./error-text.tsx";

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
  // Not a <main>: inside the shell it shows in the frame's.
  return (
    <div className="flex flex-col items-start gap-4 p-6">
      <h1 className="text-2xl font-medium">
        <Trans>This page didn&apos;t load</Trans>
      </h1>
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
  );
};
