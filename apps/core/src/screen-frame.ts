import { screenFrameMessage, screenFrameReady } from "@grasp-os/shared/screens";

// The document an App's screen runs in: the frontend frames it with
// `sandbox="allow-scripts"` and hands it the screen once it has loaded.
//
// It is served from its own address, with a policy of its own
// (`screenFramePolicy` in security-headers.ts), because a `srcdoc` or
// `data:` frame inherits the policy of the page around it, and the product
// page allows no inline or `data:` script. Chromium, Firefox and WebKit all
// do: only a document loaded over the network gets its own.
//
// It holds no App code itself. The page posts it the screen (an import map
// of `data:` modules, the CSS and the module to run) with a `MessagePort`,
// the frame's only channel to the page. Only the first message from the
// page counts, so nothing can restart it with other code later; the page
// in turn talks to the first frame document only.

const bootstrap = `"use strict";
const start = (event) => {
  const { data, ports } = event;
  if (event.source !== parent || data?.type !== "${screenFrameMessage}" || ports.length !== 1) {
    return;
  }
  removeEventListener("message", start);
  const map = document.createElement("script");
  map.type = "importmap";
  map.textContent = JSON.stringify({ imports: data.imports });
  document.head.append(map);
  const style = document.createElement("style");
  style.textContent = data.css;
  document.head.append(style);
  import(data.runtime).then((runtime) => runtime.runScreen(ports[0], data.entry));
};
addEventListener("message", start);
parent.postMessage(
  { type: "${screenFrameReady}", load: new URLSearchParams(location.search).get("load") },
  "*"
);`;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Screen</title>
    <script>${bootstrap}</script>
  </head>
  <body></body>
</html>
`;

/** The frame's document; core sets its policy with the other headers. */
export const screenFrameResponse = (): Response =>
  new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
