import type {
  ModelBudget,
  ModelBudgetScope,
  ModelRulesSettings,
  ModelSettings,
  ModelSpender,
} from "@grasp-os/shared/models";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// Models, for admins: the models the deployment allows, the client's rules
// for model calls (EU routing, which models take sensitive data, budgets),
// and this month's spend against each budget. They are deployment config
// that Grasp sets as agreed with the client, so the page only shows them,
// as core reads them; core checks the role.

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** A list of IDs for a sentence, or `none`. */
const listed = (ids: readonly string[]): string =>
  ids.length === 0 ? i18n._(msg`none`) : ids.join(", ");

const Section = ({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) => (
  <section aria-labelledby={id} className="flex flex-col gap-3">
    <h2 className="text-lg font-medium" id={id}>
      {title}
    </h2>
    {children}
  </section>
);

const AllowedModels = ({
  models,
  rules,
}: {
  models: string[];
  rules: ModelRulesSettings | undefined;
}) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>
          <Trans>Model</Trans>
        </TableHead>
        <TableHead>
          <span className="sr-only">
            <Trans>Rules</Trans>
          </span>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {models.map((model) => (
        <TableRow key={model}>
          <TableCell>{model}</TableCell>
          <TableCell>
            <span className="flex gap-2">
              {rules?.eu?.models.includes(model) === true ? (
                <Badge variant="secondary">
                  <Trans>Hosted in the EU</Trans>
                </Badge>
              ) : null}
              {rules?.sensitive?.models.includes(model) === true ? (
                <Badge variant="secondary">
                  <Trans>Takes sensitive data</Trans>
                </Badge>
              ) : null}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const EuRouting = ({ eu }: { eu: ModelRulesSettings["eu"] }) => {
  const { t } = useLingui();
  if (eu === null) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>No call has to stay in the EU.</Trans>
      </p>
    );
  }
  const workflows = listed(
    eu.workflows.map(({ app, workflow }) => `${workflow} (${app})`)
  );
  const connections = listed(eu.connections);
  return (
    <ul className="flex flex-col gap-1 text-sm">
      <li>
        {eu.deployment
          ? t`Every call stays in the EU: yes.`
          : t`Every call stays in the EU: no.`}
      </li>
      <li>
        <Trans>Workflows whose AI steps stay in the EU: {workflows}.</Trans>
      </li>
      <li>
        <Trans>Connections whose data stays in the EU: {connections}.</Trans>
      </li>
    </ul>
  );
};

const DataRules = ({
  sensitive,
}: {
  sensitive: ModelRulesSettings["sensitive"];
}) => {
  if (sensitive === null) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>
          There is no data rule: any allowed model may take sensitive data.
        </Trans>
      </p>
    );
  }
  const connections = listed(sensitive.connections);
  return (
    <ul className="flex flex-col gap-1 text-sm">
      <li>
        <Trans>
          Only the models marked as taking sensitive data may be sent data from
          a sensitive collection (marked in Knowledge) or a sensitive
          connection, or from a chat, App or run that read one.
        </Trans>
      </li>
      <li>
        <Trans>Sensitive connections: {connections}.</Trans>
      </li>
    </ul>
  );
};

const scopeTitles: Record<ModelBudgetScope, MessageDescriptor> = {
  deployment: msg`All calls together`,
  workflow: msg`Each workflow`,
  user: msg`Each person`,
};

const spenderName = (of: ModelSpender): string => {
  if (of.type === "deployment") {
    return i18n._(msg`All calls`);
  }
  if (of.type === "workflow") {
    const { workflowId } = of;
    const app = of.appName ?? of.appId;
    return i18n._(msg`${workflowId} in ${app}`);
  }
  return of.name ?? of.userId;
};

const BudgetTable = ({ budget }: { budget: ModelBudget }) => {
  const { t } = useLingui();
  const title = i18n._(scopeTitles[budget.scope]);
  const limit = dollars.format(budget.limit);
  const { alertAt } = budget;
  const top = budget.spent.length;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">{title}</h3>
      <p className="text-muted-foreground text-sm">
        <Trans>
          {limit} a month, admins alerted at {alertAt}%. Calls stop once
          it&apos;s used up.
        </Trans>
      </p>
      {budget.more ? (
        <p className="text-sm">
          <Trans>The {top} who spent most; more spent less.</Trans>
        </p>
      ) : null}
      {budget.spent.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Nothing spent yet.</Trans>
        </p>
      ) : (
        <Table aria-label={t`Spend: ${title}`}>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Spent by</Trans>
              </TableHead>
              <TableHead>
                <Trans>Spent</Trans>
              </TableHead>
              <TableHead>
                <Trans>Of the limit</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {budget.spent.map(({ of, amount }) => (
              <TableRow key={JSON.stringify(of)}>
                <TableCell>{spenderName(of)}</TableCell>
                <TableCell>{dollars.format(amount)}</TableCell>
                <TableCell>
                  {Math.round((amount / budget.limit) * 100)}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
};

const Budgets = ({
  budgets,
  month,
}: {
  budgets: ModelBudget[];
  month: string;
}) => {
  if (budgets.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>
          No budget is set: model calls aren&apos;t limited by cost.
        </Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        <Trans>Spend this month ({month}, UTC).</Trans>
      </p>
      {budgets.map((budget) => (
        <BudgetTable budget={budget} key={budget.scope} />
      ))}
    </div>
  );
};

const Settings = ({ settings }: { settings: ModelSettings }) => {
  const { t } = useLingui();
  if (settings.models.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>
          Models aren&apos;t set up for this deployment yet, so no model call
          can be made. Grasp sets them up.
        </Trans>
      </p>
    );
  }
  const { rules } = settings;
  const on = rules.state === "on" ? rules : undefined;
  return (
    <>
      {rules.state === "invalid" ? (
        <ErrorText>
          {t`The rules in this deployment's configuration can't be read, so every model call is refused. Contact Grasp.`}
        </ErrorText>
      ) : null}
      <Section id="allowed" title={t`Allowed models`}>
        <AllowedModels models={settings.models} rules={on} />
      </Section>
      {on === undefined ? null : (
        <>
          <Section id="eu" title={t`EU routing`}>
            <EuRouting eu={on.eu} />
          </Section>
          <Section id="data" title={t`Data rules`}>
            <DataRules sensitive={on.sensitive} />
          </Section>
          <Section id="budgets" title={t`Budgets`}>
            <Budgets budgets={on.budgets} month={settings.month} />
          </Section>
        </>
      )}
    </>
  );
};

const Models = () => {
  const page = Route.useLoaderData();
  return (
    <main className="flex max-w-4xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium">
          <Trans>Models</Trans>
        </h1>
        <p className="text-muted-foreground text-sm">
          <Trans>
            Grasp sets these for your organization, as agreed with you. To
            change them, contact Grasp.
          </Trans>
        </p>
      </div>
      <NotLoaded page={page} />
      {page.state === "ready" ? <Settings settings={page.data} /> : null}
    </main>
  );
};

export const Route = createFileRoute("/_shell/models")({
  component: Models,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.models.settings()
    ),
});
