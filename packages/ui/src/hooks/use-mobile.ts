import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;
const mobileQuery = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

const subscribe = (onChange: () => void): (() => void) => {
  const query = matchMedia(mobileQuery);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
};

const isMobileNow = (): boolean => matchMedia(mobileQuery).matches;

/** Rendered on the server (the console), there is no screen yet: not mobile. */
const isMobileOnServer = (): boolean => false;

/** Whether the screen is narrower than the sidebar's mobile breakpoint. */
export const useIsMobile = (): boolean =>
  useSyncExternalStore(subscribe, isMobileNow, isMobileOnServer);
