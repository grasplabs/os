import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";

import { fetchClients } from "../provision/functions.ts";

const Clients = () => {
  const clients = Route.useLoaderData();
  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-medium">Clients</h1>
        <Link to="/clients/new" className={buttonVariants()}>
          New client
        </Link>
      </div>
      {clients.length === 0 ? (
        <p className="text-muted-foreground">No clients yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Ring</TableHead>
              <TableHead>Cloudflare account</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((client) => (
              <TableRow key={client.id}>
                <TableCell>
                  <Link
                    to="/clients/$clientId"
                    params={{ clientId: client.id }}
                    className="font-mono underline-offset-4 hover:underline"
                  >
                    {client.id}
                  </Link>
                </TableCell>
                <TableCell>{client.name}</TableCell>
                <TableCell>{client.status}</TableCell>
                <TableCell>{client.ring}</TableCell>
                <TableCell>
                  <span className="font-mono">{client.accountId}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
};

export const Route = createFileRoute("/")({
  loader: async () => await fetchClients(),
  component: Clients,
});
