/**
 * What brings a scrollbar back into the product, which hides every bar
 * (apps/web/src/styles.css; areas still scroll): `overflow-scroll` (a bar
 * even when nothing overflows; `overflow-auto` scrolls without one),
 * Tailwind `scrollbar-*` utilities other than `scrollbar-none`, and
 * `::-webkit-scrollbar` or `::scrollbar` selectors. Returns what it found,
 * or `undefined`.
 */
const scrollbarClass =
  /(?:^|[\s:'"`])(?<found>overflow(?:-[xy])?-scroll|scrollbar-(?!none\b)[a-z0-9-]+)(?=$|[\s'"`\]])/u;
const scrollbarSelector = /::-webkit-scrollbar|::scrollbar/u;

export const findScrollbar = (text: string): string | undefined => {
  const found = scrollbarClass.exec(text)?.groups?.found;
  if (found !== undefined) {
    return found;
  }
  return scrollbarSelector.test(text) ? "::-webkit-scrollbar" : undefined;
};
