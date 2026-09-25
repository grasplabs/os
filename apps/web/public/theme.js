// Follow the system colour scheme through the theme's `dark` class. Loaded as
// a classic script in <head>, so it runs before first paint and dark mode
// never flashes light. A file, not inline: the CSP allows no inline script.
{
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.classList.toggle("dark", dark.matches);
  };
  apply();
  dark.addEventListener("change", apply);
}
