import { describe, expect, it } from "vite-plus/test";

import { findScrollbar } from "./no-scrollbars.ts";

describe(findScrollbar, () => {
  it.each([
    ["overflow-scroll", "overflow-scroll"],
    ["flex overflow-y-scroll p-2", "overflow-y-scroll"],
    ["md:overflow-x-scroll", "overflow-x-scroll"],
    ["scrollbar-thin", "scrollbar-thin"],
    ["[&::-webkit-scrollbar]:hidden", "::-webkit-scrollbar"],
  ])("finds the bar in %j", (text, found) => {
    expect(findScrollbar(text)).toBe(found);
  });

  it.each([
    "overflow-auto",
    "overflow-y-auto overflow-x-hidden",
    "scrollbar-none",
    "scroll-smooth scroll-mt-4",
    "No scrollbars here, just words about overflow.",
  ])("lets %j through", (text) => {
    expect(findScrollbar(text)).toBeUndefined();
  });
});
