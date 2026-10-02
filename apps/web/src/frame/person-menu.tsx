import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  CpuIcon,
  EllipsisVerticalIcon,
  LogOutIcon,
  UsersIcon,
} from "lucide-react";

import { signOut } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { roleLabel } from "../labels.ts";
import { LanguageMenu } from "../language-picker.tsx";

// The person signed in, at the foot of the sidebar: a menu with what only
// admins use, the language and signing out. The menu only leaves out what
// a role can't use; core checks the role on every call whatever it shows.

/** Up to two letters of `name`, for the avatar. */
const initials = (name: string): string =>
  name
    .split(/\s+/u)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

/** The person's name and role, on the menu's button. */
const Who = ({ identity }: { identity: Identity }) => {
  const { t } = useLingui();
  const role = roleLabel(identity.role);
  return (
    <>
      <Avatar>
        <AvatarFallback>{initials(identity.name)}</AvatarFallback>
      </Avatar>
      <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{identity.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {identity.staff ? t`${role}, Grasp staff` : role}
        </span>
      </span>
    </>
  );
};

export const PersonMenu = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const { isMobile } = useSidebar();
  const admin = isAdmin(identity.role);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
            <Who identity={identity} />
            <EllipsisVerticalIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-56"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>{identity.email}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {admin ? (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuItem render={<Link to="/activity" />}>
                    <ActivityIcon />
                    {t`Activity`}
                  </DropdownMenuItem>
                  <DropdownMenuItem render={<Link to="/models" />}>
                    <CpuIcon />
                    {t`Models`}
                  </DropdownMenuItem>
                  {/* For the organization's own admins, never Grasp staff. */}
                  {identity.staff ? null : (
                    <DropdownMenuItem render={<Link to="/members" />}>
                      <UsersIcon />
                      {t`Members`}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuGroup>
              <LanguageMenu />
              <DropdownMenuItem
                onClick={() => {
                  void signOut(core);
                }}
              >
                <LogOutIcon />
                {t`Sign out`}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
