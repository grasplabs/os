import type { Identity } from "@grasp-os/shared/rpc";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  BookOpenIcon,
  BoxesIcon,
  CableIcon,
  MessagesSquareIcon,
  WorkflowIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { CoreConnection } from "../core-connection.ts";
import { GraspMark } from "../grasp-mark.tsx";
import { NotificationsItem } from "../notifications/nav-item.tsx";
import { PersonMenu } from "./person-menu.tsx";

// The product's sections, down the left beside every signed-in page. What
// only admins use is in the person menu at its foot.

interface Section {
  to: "/" | "/knowledge" | "/apps" | "/workflows" | "/connections";
  label: MessageDescriptor;
  icon: LucideIcon;
}

const sections: readonly Section[] = [
  { to: "/", label: msg`Chat`, icon: MessagesSquareIcon },
  { to: "/knowledge", label: msg`Knowledge`, icon: BookOpenIcon },
  { to: "/apps", label: msg`Apps`, icon: BoxesIcon },
  { to: "/workflows", label: msg`Workflows`, icon: WorkflowIcon },
  { to: "/connections", label: msg`Connections`, icon: CableIcon },
];

/** The app's sidebar: the mark, the sections and the person signed in. */
export const AppSidebar = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => {
  const { t, i18n } = useLingui();
  const matchRoute = useMatchRoute();
  return (
    <Sidebar collapsible="offcanvas" label={t`Sidebar`} variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/" />} size="lg">
              <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-lg">
                <GraspMark className="size-4" />
              </span>
              <span className="truncate font-medium">Grasp</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label={t`Main`}>
              <SidebarMenu>
                {sections.map(({ to, label, icon: Icon }) => (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      // Chat is only itself; any other section holds the
                      // pages under it.
                      isActive={matchRoute({ to, fuzzy: to !== "/" }) !== false}
                      render={<Link to={to} />}
                    >
                      <Icon />
                      <span>{i18n._(label)}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                <NotificationsItem />
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <PersonMenu core={core} identity={identity} />
      </SidebarFooter>
    </Sidebar>
  );
};
