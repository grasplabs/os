// Local check that the UI kit renders with the theme, in light and dark mode
// (e2e/kit.e2e.ts). Not product UI: builds in production mode answer not
// found. Gated on the mode rather than `DEV`, because the local stack serves
// a `--mode development` build, which Vite still builds with `DEV` false.
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
} from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@grasp-os/ui/components/hover-card";
import { Input } from "@grasp-os/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Kbd } from "@grasp-os/ui/components/kbd";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Separator } from "@grasp-os/ui/components/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@grasp-os/ui/components/sidebar";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Spinner } from "@grasp-os/ui/components/spinner";
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
import {
  BookOpenIcon,
  FileTextIcon,
  MessagesSquareIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";

import {
  PageSidebar,
  PageSidebarEntry,
  PageSidebarProvider,
  PageSidebarSection,
  PageSidebarTop,
  PageSidebarTrigger,
} from "../frame/page-sidebar.tsx";
import { GraspMark } from "../grasp-mark.tsx";

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

/** Navigation and page furniture: the sidebar, crumbs, people, keys. */
const Frame = () => (
  <Card>
    <CardHeader>
      <CardTitle>Frame</CardTitle>
      <CardDescription>Sidebar, breadcrumbs and avatars.</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-lg border">
          <SidebarProvider className="min-h-0">
            <Sidebar collapsible="none">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupLabel>Product</SidebarGroupLabel>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive>
                        <MessagesSquareIcon />
                        Chat
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton>
                        <BookOpenIcon />
                        Knowledge
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroup>
              </SidebarContent>
            </Sidebar>
          </SidebarProvider>
        </div>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/kit">Knowledge</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Onboarding guide</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <Separator />
        <div className="flex items-center gap-4">
          <AvatarGroup>
            <Avatar>
              <AvatarFallback>AL</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>GH</AvatarFallback>
            </Avatar>
          </AvatarGroup>
          <p className="text-muted-foreground text-sm">
            Press <Kbd>⌘</Kbd> <Kbd>B</Kbd> to fold the sidebar.
          </p>
          <Spinner />
        </div>
      </div>
    </CardContent>
  </Card>
);

/** Fields with their label, help and error, and an input with an addon. */
const Fields = () => (
  <Card>
    <CardHeader>
      <CardTitle>Fields</CardTitle>
      <CardDescription>Labels, help, errors and input groups.</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="kit-email">Email</FieldLabel>
          <Input id="kit-email" placeholder="ada@example.com" />
          <FieldDescription>Where the summary goes.</FieldDescription>
        </Field>
        <Field data-invalid>
          <FieldLabel htmlFor="kit-title">Title</FieldLabel>
          <Input id="kit-title" aria-invalid />
          <FieldError errors={[{ message: "A title is needed." }]} />
        </Field>
        <InputGroup>
          <InputGroupInput aria-label="Search" placeholder="Search" />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
      </div>
    </CardContent>
  </Card>
);

/** Lists, empty states, placeholders and what opens over the page. */
const Content = () => (
  <Card>
    <CardHeader>
      <CardTitle>Content</CardTitle>
      <CardDescription>Items, empty states and overlays.</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-4">
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>Onboarding guide</ItemTitle>
            <ItemDescription>Updated yesterday</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button variant="outline" size="sm">
              Open
            </Button>
          </ItemActions>
        </Item>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No documents yet</EmptyTitle>
            <EmptyDescription>Upload a file to start.</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Sheet>
            <SheetTrigger render={<Button variant="outline" />}>
              Open sheet
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Sheet</SheetTitle>
                <SheetDescription>A panel from the side.</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
          <Popover>
            <PopoverTrigger render={<Button variant="outline" />}>
              Open popover
            </PopoverTrigger>
            <PopoverContent>
              <PopoverHeader>
                <PopoverTitle>Popover</PopoverTitle>
                <PopoverDescription>Anchored to its button.</PopoverDescription>
              </PopoverHeader>
            </PopoverContent>
          </Popover>
          <HoverCard>
            <HoverCardTrigger render={<Button variant="ghost" />}>
              Hover for a card
            </HoverCardTrigger>
            <HoverCardContent>A preview card.</HoverCardContent>
          </HoverCard>
        </div>
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" />}>
            Show details
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="text-muted-foreground text-sm">The details.</p>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </CardContent>
  </Card>
);

const kitDocuments = ["Onboarding guide", "Pricing", "Holidays"];

/** The column beside a page's content, folding to a rail of its icons. */
const PageColumn = () => {
  const [open, setOpen] = useState(kitDocuments[0]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Page sidebar</CardTitle>
        <CardDescription>
          Folds to a rail and stays folded over a reload.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex h-64 overflow-hidden rounded-lg border">
          <PageSidebarProvider name="kit">
            <PageSidebar label="Documents">
              <PageSidebarTop>
                <PageSidebarEntry icon={<PlusIcon />} label="New document" />
              </PageSidebarTop>
              <PageSidebarSection label="Recent">
                {kitDocuments.map((name) => (
                  <PageSidebarEntry
                    active={name === open}
                    icon={<FileTextIcon />}
                    key={name}
                    label={name}
                    onClick={() => {
                      setOpen(name);
                    }}
                  />
                ))}
              </PageSidebarSection>
            </PageSidebar>
            <div className="flex flex-1 items-start gap-2 p-4">
              <PageSidebarTrigger label="Documents" />
              <p className="text-sm">{open}</p>
            </div>
          </PageSidebarProvider>
        </div>
      </CardContent>
    </Card>
  );
};

const Kit = () => (
  <Toaster>
    <TooltipProvider>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        <div className="flex items-center gap-3">
          <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
            <GraspMark className="size-4" />
          </div>
          <h1 className="text-2xl font-medium">UI kit</h1>
        </div>

        <Frame />

        <PageColumn />

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

        <Fields />

        <Content />
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
