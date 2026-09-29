import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  fetchNewClientOptions,
  startClient,
} from "../../provision/functions.ts";
import { useAction } from "../../provision/use-action.ts";

/** A form field with its label and what it's for. */
const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) => (
  <label className="flex flex-col gap-1 text-sm">
    <span className="font-medium">{label}</span>
    {children}
    <span className="text-muted-foreground">{hint}</span>
  </label>
);

/** The form's text field `name`, trimmed. */
const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const NewClient = () => {
  const { releases } = Route.useLoaderData();
  const navigate = useNavigate();
  const { busy, failure, run } = useAction();
  const start = (form: FormData) => {
    const accountId = textOf(form, "accountId");
    void run(async () => {
      const clientId = await startClient({
        data: {
          clientId: textOf(form, "clientId"),
          name: textOf(form, "name"),
          releaseId: textOf(form, "releaseId"),
          ring: Number(textOf(form, "ring")),
          ...(accountId === "" ? {} : { accountId }),
        },
      });
      await navigate({ to: "/clients/$clientId", params: { clientId } });
    });
  };
  const [newest] = releases;
  return (
    <main className="flex max-w-xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">New client</h1>
      {newest === undefined ? (
        <p className="text-muted-foreground">
          No release is imported yet, so there is nothing to deploy.
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            start(new FormData(event.currentTarget));
          }}
          className="flex flex-col gap-4"
        >
          <Field
            label="Client id"
            hint="Its hostname: lowercase letters, digits and dashes. It can't change."
          >
            <Input name="clientId" required maxLength={50} />
          </Field>
          <Field label="Name" hint="The organisation, as staff know it.">
            <Input name="name" required maxLength={100} />
          </Field>
          <Field
            label="Cloudflare account id"
            hint="An account to adopt, with the deployer a member. Leave it empty to create one (partner accounts only)."
          >
            <Input name="accountId" pattern="[0-9a-f]{32}" />
          </Field>
          <Field label="Release" hint="The release it starts on.">
            <Input
              name="releaseId"
              list="release-ids"
              required
              defaultValue={newest.id}
            />
            <datalist id="release-ids">
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.notes}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="Ring" hint="When rollouts reach it: ring 0 first.">
            <Input
              name="ring"
              type="number"
              min={0}
              required
              defaultValue={1}
            />
          </Field>
          <div className="flex items-center gap-4">
            <Button type="submit" disabled={busy}>
              Start provisioning
            </Button>
            {failure === null ? null : (
              <p role="alert" className="text-destructive text-sm">
                {failure}
              </p>
            )}
          </div>
        </form>
      )}
    </main>
  );
};

export const Route = createFileRoute("/clients/new")({
  loader: async () => await fetchNewClientOptions(),
  component: NewClient,
});
