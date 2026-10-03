import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
import { Separator } from "@grasp-os/ui/components/separator";
import { SidebarTrigger } from "@grasp-os/ui/components/sidebar";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import type { ReactNode } from "react";

/** A step on the way to the page; the last one is the page itself. */
export type Crumb =
  | { label: string }
  | { label: string; to: "/" | "/knowledge" | "/apps" | "/workflows" }
  | { label: string; to: "/apps/$app"; params: { app: string } }
  | {
      label: string;
      to: "/knowledge/$collection";
      params: { collection: string };
    };

/** Where a crumb leads, as a link. */
const crumbLink = (crumb: Extract<Crumb, { to: string }>) => {
  if (!("params" in crumb)) {
    return <Link to={crumb.to} />;
  }
  return "app" in crumb.params ? (
    <Link params={crumb.params} to="/apps/$app" />
  ) : (
    <Link params={crumb.params} search={{}} to="/knowledge/$collection" />
  );
};

const CrumbLink = ({ crumb }: { crumb: Crumb }) => {
  if (!("to" in crumb)) {
    return <BreadcrumbPage>{crumb.label}</BreadcrumbPage>;
  }
  return (
    <BreadcrumbLink render={crumbLink(crumb)}>{crumb.label}</BreadcrumbLink>
  );
};

/**
 * The bar above every signed-in page: the sidebar's trigger, then where the
 * page is, and on the right any page action. It stays in view while the
 * page scrolls. On one line whatever the window: on a narrow one only the
 * step before the page is kept.
 */
export const SiteHeader = ({
  crumbs,
  actions,
}: {
  crumbs: readonly Crumb[];
  actions?: ReactNode;
}) => {
  const { t } = useLingui();
  const last = crumbs.length - 1;
  return (
    <header className="bg-background sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b">
      {/* A square of its own, as wide as a page sidebar's rail, so the
          line beside it continues that sidebar's edge. */}
      <div className="flex h-full w-12 flex-none items-center justify-center">
        <SidebarTrigger label={t`Show or hide the sidebar`} />
      </div>
      <Separator
        className="-ml-px h-4 data-vertical:self-auto"
        orientation="vertical"
      />
      <div className="flex min-w-0 flex-1 items-center gap-1 px-4 lg:gap-2 lg:pr-6">
        <Breadcrumb aria-label={t`Breadcrumb`} className="min-w-0">
          <BreadcrumbList className="flex-nowrap">
            {crumbs.map((crumb, index) => (
              <Fragment key={`${index}:${crumb.label}`}>
                {index > 0 ? (
                  <BreadcrumbSeparator
                    className={index < last ? "max-md:hidden" : undefined}
                  />
                ) : null}
                <BreadcrumbItem
                  className={
                    index === last
                      ? "min-w-8"
                      : `flex-none ${index < last - 1 ? "max-md:hidden" : ""}`
                  }
                >
                  <CrumbLink crumb={crumb} />
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        {actions === undefined ? null : (
          <div className="ml-auto flex flex-none items-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
};
