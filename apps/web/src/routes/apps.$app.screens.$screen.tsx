import { createFileRoute } from "@tanstack/react-router";

import { ScreenFrame } from "../screens/screen-frame.tsx";

// One of an App's screens, full page. The Apps pages will link here; core
// refuses the screen while the `screens` feature is off, and the page says
// so. Keyed by App and screen, so moving to another starts afresh: the
// chrome never shows the name of the App the page just left.

const Screen = () => {
  const { app, screen } = Route.useParams();
  return (
    <main className="flex h-svh flex-col">
      <ScreenFrame app={app} key={`${app}/${screen}`} screen={screen} />
    </main>
  );
};

export const Route = createFileRoute("/apps/$app/screens/$screen")({
  component: Screen,
});
