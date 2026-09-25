// Local check that the UI kit renders with the theme, in light and dark mode
// (e2e/kit.e2e.ts). Not product UI: builds in production mode answer not
// found. Gated on the mode rather than `DEV`, because the local stack serves
// a `--mode development` build, which Vite still builds with `DEV` false.
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Switch } from "@grasp-os/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { toast, Toaster } from "@grasp-os/ui/components/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { createFileRoute, notFound } from "@tanstack/react-router";

const models = [
  { label: "Small", value: "small" },
  { label: "Large", value: "large" },
];

const runs = [
  { id: "run-1", workflow: "Weekly report", status: "Succeeded" },
  { id: "run-2", workflow: "Invoice intake", status: "Running" },
];

const showToast = () => {
  toast.add({ title: "Saved", description: "Your changes are saved." });
};

const Kit = () => (
  <Toaster>
    <TooltipProvider>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        <h1 className="text-2xl font-medium">UI kit</h1>

        <Card>
          <CardHeader>
            <CardTitle>Forms</CardTitle>
            <CardDescription>Inputs and controls.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-2 text-sm" htmlFor="kit-name">
                Name
                <Input id="kit-name" placeholder="Ada Lovelace" />
              </label>
              <label
                className="flex flex-col gap-2 text-sm"
                htmlFor="kit-notes"
              >
                Notes
                <Textarea id="kit-notes" placeholder="Anything else?" />
              </label>
              <Select items={models} defaultValue="small">
                <SelectTrigger aria-label="Model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.value} value={model.value}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label
                className="flex items-center gap-2 text-sm"
                htmlFor="kit-summary"
              >
                <Checkbox id="kit-summary" defaultChecked />
                Email me a summary
              </label>
              <label
                className="flex items-center gap-2 text-sm"
                htmlFor="kit-notifications"
              >
                <Switch id="kit-notifications" />
                Notifications
              </label>
            </div>
          </CardContent>
        </Card>

        <Tabs defaultValue="runs">
          <TabsList>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="actions">Actions</TabsTrigger>
          </TabsList>
          <TabsContent value="runs">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>{run.workflow}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{run.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="actions">
            <div className="flex flex-wrap gap-2">
              <Dialog>
                <DialogTrigger render={<Button variant="outline" />}>
                  Open dialog
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Dialog</DialogTitle>
                    <DialogDescription>A modal dialog.</DialogDescription>
                  </DialogHeader>
                </DialogContent>
              </Dialog>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />}>
                  Open menu
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem>Rename</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive">
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" />}>
                  Hover me
                </TooltipTrigger>
                <TooltipContent>A tooltip</TooltipContent>
              </Tooltip>
              <Button onClick={showToast}>Show toast</Button>
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </TooltipProvider>
  </Toaster>
);

export const Route = createFileRoute("/kit")({
  beforeLoad: () => {
    if (import.meta.env.MODE === "production") {
      throw notFound();
    }
  },
  component: Kit,
});
