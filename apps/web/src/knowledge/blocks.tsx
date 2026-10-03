import type { Collection } from "@grasp-os/shared/knowledge";
import { useId } from "react";
import type { ReactNode } from "react";

// The pictures on Knowledge's blocks, in the prototype's style
// (grasplabs/prototype `components/brain-home.tsx`): a pale field with a
// dashed grid, a line drawing in the middle. In the palette's own greys:
// Knowledge has no part colours of its own.

/** A pale field with a dashed grid, the drawing in the middle. */
export const Panel = ({
  short = false,
  children,
}: {
  short?: boolean;
  children: ReactNode;
}) => {
  const id = useId();
  return (
    <div
      className={
        short
          ? "bg-muted relative h-28 overflow-hidden rounded-xl transition-opacity group-hover:opacity-85"
          : "bg-muted relative h-40 overflow-hidden rounded-xl transition-opacity group-hover:opacity-85"
      }
    >
      <svg aria-hidden="true" className="absolute inset-0 size-full">
        <defs>
          <pattern height="28" id={id} patternUnits="userSpaceOnUse" width="28">
            <path
              className="stroke-border"
              d="M28 0H0V28"
              fill="none"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect fill={`url(#${id})`} height="100%" width="100%" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {children}
      </div>
    </div>
  );
};

const line = "stroke-foreground";
const surface = "stroke-foreground fill-card";
const tinted = "stroke-foreground fill-muted-foreground/15";

const drawingProps = {
  "aria-hidden": true,
  className: "h-32",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.5,
  viewBox: "0 0 200 120",
} as const;

/** A stack of documents and a speech bubble: what was shared and said. */
const SharedDrawing = () => (
  <svg {...drawingProps}>
    <rect className={surface} height="74" rx="6" width="58" x="44" y="30" />
    <rect className={surface} height="74" rx="6" width="58" x="54" y="22" />
    <path className={line} d="M64 40 H100 M64 50 H100 M64 60 H88" fill="none" />
    <path
      className={tinted}
      d="M112 44 H160 A8 8 0 0 1 168 52 V78 A8 8 0 0 1 160 86 H132 L120 96 V86 H112 A8 8 0 0 1 104 78 V52 A8 8 0 0 1 112 44 Z"
    />
    <path className={line} d="M118 60 H154 M118 70 H142" fill="none" />
  </svg>
);

/** Three people side by side, the middle one in front: a team's own. */
const TeamsDrawing = () => (
  <svg {...drawingProps}>
    <circle className={surface} cx="62" cy="46" r="13" />
    <path className={surface} d="M36 96 C36 74 88 74 88 96 Z" />
    <circle className={surface} cx="138" cy="46" r="13" />
    <path className={surface} d="M112 96 C112 74 164 74 164 96 Z" />
    <circle className={tinted} cx="100" cy="40" r="16" />
    <path className={tinted} d="M68 102 C68 74 132 74 132 102 Z" />
  </svg>
);

/** One person beside their own page: only its owner reads it. */
const OwnDrawing = () => (
  <svg {...drawingProps}>
    <rect className={surface} height="74" rx="6" width="58" x="104" y="24" />
    <path
      className={line}
      d="M114 40 H152 M114 50 H152 M114 60 H140"
      fill="none"
    />
    <circle className={tinted} cx="72" cy="44" r="15" />
    <path className={tinted} d="M42 100 C42 72 102 72 102 100 Z" />
  </svg>
);

/** Two app windows, one behind the other: what Grasp ships, read-only. */
const ShippedDrawing = () => (
  <svg {...drawingProps}>
    <rect className={surface} height="64" rx="7" width="92" x="44" y="22" />
    <rect className={tinted} height="64" rx="7" width="92" x="64" y="38" />
    <path className={line} d="M64 52 H156" fill="none" />
    <rect className={surface} height="22" rx="5" width="22" x="76" y="62" />
    <rect className={surface} height="22" rx="5" width="22" x="104" y="62" />
  </svg>
);

/** A process as three steps, the middle one lifted out: what Apps keep. */
const AppsDrawing = () => (
  <svg {...drawingProps}>
    <rect className={surface} height="30" rx="7" width="40" x="18" y="58" />
    <rect className={surface} height="30" rx="7" width="40" x="142" y="58" />
    <path
      className={line}
      d="M58 73 H76 M124 73 H142"
      fill="none"
      strokeDasharray="4 4"
    />
    <rect className={tinted} height="36" rx="8" width="48" x="76" y="34" />
    <path className={line} d="M92 52 L98 58 L110 46" fill="none" />
  </svg>
);

/**
 * A collection's picture, by where its documents come from and who reads
 * them, so blocks side by side tell apart at a glance.
 */
export const CollectionDrawing = ({
  collection,
}: {
  collection: Pick<Collection, "access" | "source">;
}) => {
  if (collection.source === "grasp") {
    return <ShippedDrawing />;
  }
  if (collection.source === "apps") {
    return <AppsDrawing />;
  }
  if (collection.access === "me") {
    return <OwnDrawing />;
  }
  return collection.access === "teams" ? <TeamsDrawing /> : <SharedDrawing />;
};

/** A notebook with a pen: what every agent always has in mind. */
export const MemoryDrawing = () => (
  <svg
    aria-hidden="true"
    className="h-32"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.5}
    viewBox="0 0 200 120"
  >
    <rect className={surface} height="84" rx="7" width="72" x="58" y="18" />
    <path className={line} d="M70 18 V102" fill="none" />
    <path
      className={line}
      d="M80 36 H118 M80 48 H118 M80 60 H108 M80 72 H114"
      fill="none"
    />
    <path className={tinted} d="M142 30 L152 30 L152 88 L147 98 L142 88 Z" />
    <path className={line} d="M142 40 H152" fill="none" />
  </svg>
);
