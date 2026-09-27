import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";

/**
 * A change on the Connections page (see changeThenRefresh), then the page
 * read again, without the `connection` and `connectionError` a flow came
 * back with: their notice was about that flow, not about what the page
 * shows now.
 */
export const useChange = () => {
  const router = useRouter();
  const action = useCoreAction();
  const change = async (
    make: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    await action.run(async (session) => {
      await changeThenRefresh(
        async () => await make(session),
        async () => {
          await router.navigate({
            to: "/connections",
            search: {},
            replace: true,
          });
          // `sync` waits for the loader; without it, the router reloads
          // the page's data in the background and resolves at once.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return { busy: action.busy, failure: action.failure, change };
};
