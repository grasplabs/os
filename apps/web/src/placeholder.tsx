/** A section of the product that isn't built yet: its name, and that. */
export const Placeholder = ({ title }: { title: string }) => (
  <main className="flex flex-col gap-2 p-6">
    <h1 className="text-2xl font-medium">{title}</h1>
    <p className="text-muted-foreground text-sm">Not built yet.</p>
  </main>
);
