import { useEffect, useRef } from "react";

import { headDotCount, headDots, headEar, headPitch } from "./head-dots.ts";

// Grasp's buddy: the head from the prototype's onboarding, Stephen in dots,
// small (grasplabs/prototype `components/grasp-buddy.tsx`). Rows of dots
// sized by the photo's shading; alive the same way: its dots gather from a
// small cloud when the page opens, sway faintly through the rows, fade and
// return in drifting patches, and swell and warm under the pointer. While
// the person types, its ear warms. A warm ring runs through it once it has
// gathered, and when it is clicked. Decorative only. With less motion it
// stands still and only answers the pointer.

/** How large the buddy is on screen, in pixels, and drawn at that size. */
const size = 128;
/** The onboarding's own drawing size: the buddy's reach and ring scale from it. */
const onboardingSize = 380;
const small = size / onboardingSize;
const tau = Math.PI * 2;
/** How the dots look and move, as in the onboarding (`dot-ink.ts`). */
const look = {
  air: 1.06,
  lightDot: 0.13,
  darkDot: 0.34,
  variety: 0.95,
  tideSize: 1.1,
  tideSpeed: 0.16,
  reach: 1.7,
  reveal: 1,
  grow: 1.1,
  warm: 0.5,
};
const morphSeconds = 1.3;
const spreadSeconds = 0.5;
const reachPixels = 64;
/** Steps of ink and of warmth: one colour each, so a frame is a few fills. */
const alphas = 12;
const heats = 6;
/** This small, its patches of faintness go this deep at most. */
const tideDepth = 0.5;
/** The sway through its rows and each dot's own drift, in the figure's units. */
const flow = 0.007;
const drift = 0.003;
/** Its ear warms this much with every key, and cools in about this long. */
const heard = { key: 0.45, seconds: 0.9 };
/** The warm ring: how fast and how wide it runs, in pixels, and how long it lasts. */
const ringLook = { speed: 240 * small, width: 22 * small, seconds: 1.8 };

interface Head {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  tone: Float32Array;
  ink: Float32Array;
}

let decoded: Head | undefined;

/** The head's dots, read from their numbers once. */
const head = (): Head => {
  if (decoded !== undefined) {
    return decoded;
  }
  const bytes = Uint8Array.from(
    atob(headDots),
    (char) => char.codePointAt(0) ?? 0
  );
  const view = new DataView(bytes.buffer);
  const read = (at: number, low: number, high: number): number =>
    low + (view.getUint16(at * 2, true) / 65_535) * (high - low);
  const x = new Float32Array(headDotCount);
  const y = new Float32Array(headDotCount);
  const z = new Float32Array(headDotCount);
  const tone = new Float32Array(headDotCount);
  const ink = new Float32Array(headDotCount);
  for (let at = 0; at < headDotCount; at += 1) {
    x[at] = read(at * 5, -1.5, 1.5);
    y[at] = read(at * 5 + 1, -1.5, 1.5);
    z[at] = read(at * 5 + 2, -1.5, 1.5);
    tone[at] = read(at * 5 + 3, 0, 1);
    ink[at] = read(at * 5 + 4, 0, 1);
  }
  decoded = { x, y, z, tone, ink };
  return decoded;
};

/** A small seeded random (Park–Miller), so the head gathers the same way each time. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

type Rgb = [number, number, number];

/** Any CSS colour as red, green and blue, by letting a canvas paint it. */
const rgbOf = (color: string, probe: CanvasRenderingContext2D): Rgb => {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = probe.getImageData(0, 0, 1, 1).data;
  return [red, green, blue];
};

const mix = (from: Rgb, to: Rgb, t: number): Rgb => [
  Math.round(from[0] + (to[0] - from[0]) * t),
  Math.round(from[1] + (to[1] - from[1]) * t),
  Math.round(from[2] + (to[2] - from[2]) * t),
];

/** Every colour a dot can have, by warmth then ink, from the brain tokens. */
const paletteOf = (element: HTMLElement): string[] => {
  const probe = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  if (probe === null) {
    return Array.from({ length: alphas * heats }, () => "rgba(26, 26, 25, 1)");
  }
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string): Rgb =>
    rgbOf(style.getPropertyValue(name).trim() || fallback, probe);
  const ink = read("--brain-ink", "#1a1a19");
  const heat = read("--brain-heat", "#e5572b");
  const glow = read("--brain-glow", "#f6c35a");
  const styles: string[] = [];
  for (let level = 0; level < heats; level += 1) {
    const warmth = level / (heats - 1);
    const color =
      warmth < 0.6
        ? mix(ink, heat, warmth / 0.6)
        : mix(heat, glow, (warmth - 0.6) / 0.4);
    for (let alpha = 0; alpha < alphas; alpha += 1) {
      styles.push(
        `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${(alpha / (alphas - 1)).toFixed(3)})`
      );
    }
  }
  return styles;
};

interface Cloud {
  seed: Float32Array;
  grain: Float32Array;
  delay: Float32Array;
  lift: Float32Array;
  from: Float32Array;
  ear: Float32Array;
}

/**
 * Every dot's own chance, grain, delay and lift, so the head gathers
 * unevenly, like ink; where it starts in the small cloud; and how much of
 * the ear it is.
 */
const cloudOf = (shape: Head): Cloud => {
  const count = headDotCount;
  const random = seeded(7);
  const seed = new Float32Array(count);
  const grain = new Float32Array(count);
  const delay = new Float32Array(count);
  const lift = new Float32Array(count);
  const from = new Float32Array(count * 3);
  const ear = new Float32Array(count);
  const [earX, earY, earZ] = headEar.at;
  for (let at = 0; at < count; at += 1) {
    seed[at] = random();
    grain[at] = random() ** 2;
    delay[at] = random() * spreadSeconds;
    lift[at] = 0.12 + random() * 0.4;
    const angle = random() * tau;
    const far = Math.sqrt(random()) * 0.35;
    from[at * 3] = Math.cos(angle) * far;
    from[at * 3 + 1] = Math.sin(angle) * far;
    from[at * 3 + 2] = (random() - 0.5) * 0.3;
    const off =
      ((shape.x[at] ?? 0) - earX) ** 2 +
      ((shape.y[at] ?? 0) - earY) ** 2 +
      ((shape.z[at] ?? 0) - earZ) ** 2;
    const weight = Math.exp(-off / (headEar.radius * headEar.radius));
    ear[at] = weight < 0.02 ? 0 : weight;
  }
  return { seed, grain, delay, lift, from, ear };
};

/** What a frame shares with every dot in it. */
interface Moment {
  now: number;
  age: number;
  morphing: boolean;
  still: boolean;
  /** How deep the patches of faintness go now, and where they are. */
  tide: number;
  tideAt: number;
  /** How hard it listens to typing. */
  listening: number;
  /** How much of the warm ring is left, and how far it has run. */
  ringLeft: number;
  travelled: number;
}

interface Dot {
  x: number;
  y: number;
  z: number;
  lit: number;
  printed: number;
}

/** Eases in and out, cubically. */
const easeInOut = (t: number): number => {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/** Dot `at` now: flying in from the cloud while it gathers, then swaying. */
const gathered = (
  shape: Head,
  cloud: Cloud,
  at: number,
  { now, age, morphing, still }: Moment
): Dot => {
  let x = shape.x[at] ?? 0;
  let y = shape.y[at] ?? 0;
  let z = shape.z[at] ?? 0;
  let lit = shape.tone[at] ?? 0;
  let printed = shape.ink[at] ?? 0;
  if (morphing) {
    const eased = easeInOut((age - (cloud.delay[at] ?? 0)) / morphSeconds);
    const fromX = cloud.from[at * 3] ?? 0;
    const fromY = cloud.from[at * 3 + 1] ?? 0;
    const fromZ = cloud.from[at * 3 + 2] ?? 0;
    x = fromX + (x - fromX) * eased;
    y = fromY + (y - fromY) * eased;
    z =
      fromZ +
      (z - fromZ) * eased +
      Math.sin(Math.PI * eased) * (cloud.lift[at] ?? 0);
    lit = 0.4 + (lit - 0.4) * eased;
    printed = 0.4 + (printed - 0.4) * eased;
  }
  // Alive, not heaving, and only sideways: a faint sway through the rows.
  if (!still) {
    x +=
      flow *
        (Math.sin(now * 1.3 + y * 4) + 0.4 * Math.sin(now * 2.2 + y * 11)) +
      drift * Math.sin(now * 2.1 + (cloud.seed[at] ?? 0) * tau);
  }
  return { x, y, z, lit, printed };
};

/** How much a dot `distance` pixels from the warm spot swells and glows. */
const nearness = (distance: number, reach: number, spot: number): number => {
  if (distance >= reach) {
    return 0;
  }
  const t = 1 - distance / reach;
  return spot * t * t * (3 - 2 * t);
};

/** A dot's warmth: under the pointer, at the ear while typing, and in the ring. */
const heatOf = (
  near: number,
  ear: number,
  own: number,
  ringOff: number,
  { now, still, listening, ringLeft }: Moment
): number => {
  let heat = look.warm * near;
  if (ear > 0 && listening > 0.02) {
    const pulse = still ? 0.6 : 0.75 + 0.25 * Math.sin(now * 9 + own * 3);
    heat = Math.max(heat, ear * listening * pulse);
  }
  if (ringLeft > 0 && ringOff * ringOff < 4) {
    heat = Math.max(heat, 0.75 * ringLeft * Math.exp(-ringOff * ringOff));
  }
  return heat;
};

/** How strongly a dot is printed: its ink, the tide, and its warmth. */
const alphaOf = (
  { x, y, lit, printed }: Dot,
  own: number,
  near: number,
  heat: number,
  { now, still, tide, tideAt }: Moment
): number => {
  let alpha = 0.58 + 0.32 * printed + 0.08 * lit;
  if (!still) {
    alpha *= 0.92 + 0.08 * Math.sin(now * 1.4 + own * 60);
  }
  alpha *= Math.min(1, Math.max(0, (1.3 - Math.hypot(x, y)) / 0.35));
  if (tide > 0) {
    const tx = x * look.tideSize;
    const ty = y * look.tideSize;
    const swell =
      Math.sin(tx * 2.3 + tideAt + 1.7 * Math.sin(ty * 1.6 - tideAt * 0.7)) *
      Math.cos(
        ty * 2.1 - tideAt * 0.9 + 1.3 * Math.sin(tx * 1.2 + tideAt * 0.5)
      );
    const shown = 1 - tide * (1 - smoothstep(0.2, 0.8, 0.5 + 0.5 * swell));
    // The pointer finds what the tide hides.
    alpha *= shown + (1 - shown) * look.reveal * near;
  }
  return heat > 0.12 ? Math.max(alpha, 0.45 + 0.5 * heat) : alpha;
};

/** A dot's radius as a share of the spacing, so dots always stand apart. */
const radiusOf = (
  printed: number,
  grain: number,
  near: number,
  heat: number
): number => {
  const variety = 1 - 0.55 * look.variety + 1.3 * look.variety * grain;
  const share = Math.min(
    0.4,
    (look.lightDot + (look.darkDot - look.lightDot) * printed) * variety
  );
  return share * Math.min(1 + 0.25 * heat + look.grow * near, 0.44 / share);
};

/** The colour a dot of this ink and warmth, each 0 to 1, is printed in. */
const bucketOf = (alpha: number, heat: number): number => {
  const a = Math.min(alphas - 1, Math.max(0, Math.round(alpha * (alphas - 1))));
  const h = Math.min(heats - 1, Math.round(heat * (heats - 1)));
  return h * alphas + a;
};

/** Where a frame put every dot, how large, and in which colour. */
interface Frame {
  screenX: Float32Array;
  screenY: Float32Array;
  radius: Float32Array;
  bucket: Uint16Array;
  counts: Uint32Array;
  starts: Uint32Array;
  order: Uint32Array;
}

/** Draws a frame: one path per colour, every dot of that ink and warmth in one fill. */
const paint = (
  context: CanvasRenderingContext2D,
  styles: readonly string[],
  dpr: number,
  { screenX, screenY, radius, bucket, counts, starts, order }: Frame
): void => {
  let offset = 0;
  for (let b = 0; b < counts.length; b += 1) {
    starts[b] = offset;
    offset += counts[b] ?? 0;
  }
  for (let at = 0; at < bucket.length; at += 1) {
    const b = bucket[at] ?? 0;
    const place = starts[b] ?? 0;
    order[place] = at;
    starts[b] = place + 1;
  }
  context.clearRect(0, 0, size, size);
  let next = 0;
  for (let b = 0; b < counts.length; b += 1) {
    const many = counts[b] ?? 0;
    // The faintest colour is not printed at all.
    if (many > 0 && b % alphas !== 0) {
      context.fillStyle = styles[b] ?? "transparent";
      context.beginPath();
      for (let k = next; k < next + many; k += 1) {
        const at = order[k] ?? 0;
        const r = radius[at] ?? 0;
        const cx = screenX[at] ?? 0;
        const cy = screenY[at] ?? 0;
        // Round wherever a screen can show it; a dot of a pixel is a square.
        if (r * dpr < 1.1) {
          context.rect(cx - r, cy - r, r * 2, r * 2);
        } else {
          context.moveTo(cx + r, cy);
          context.arc(cx, cy, r, 0, tau);
        }
      }
      context.fill();
    }
    next += many;
  }
};

/** Draws the buddy on `element` until the returned function stops it. */
const animate = (element: HTMLCanvasElement): (() => void) => {
  const context = element.getContext("2d");
  if (context === null) {
    return () => {
      // Nothing to stop.
    };
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  element.width = size * dpr;
  element.height = size * dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let styles = paletteOf(element);
  const repaint = (): void => {
    styles = paletteOf(element);
  };
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", repaint);
  const themes = new MutationObserver(repaint);
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });

  const shape = head();
  const count = headDotCount;
  const cloud = cloudOf(shape);

  const screenX = new Float32Array(count);
  const screenY = new Float32Array(count);
  const radius = new Float32Array(count);
  const bucket = new Uint16Array(count);
  const counts = new Uint32Array(alphas * heats);
  const starts = new Uint32Array(alphas * heats);
  const order = new Uint32Array(count);

  const scale = size * 0.43 * look.air;
  const middle = size / 2;
  const gap = headPitch * scale;
  const reach = reachPixels * look.reach * small;

  // The warm spot glides after the pointer and fades in and out.
  const pointer = { x: middle, y: middle, inside: false };
  let spotX = middle;
  let spotY = middle;
  let spot = 0;
  let listening = 0;
  const ring = { x: middle, y: middle, at: -Infinity };
  let greeted = false;

  let visible = true;
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  watcher.observe(element);

  let frame = 0;
  let born = -1;
  let then = -1;
  const draw = (ms: number): void => {
    frame = requestAnimationFrame(draw);
    if (!visible) {
      return;
    }
    const now = ms / 1000;
    if (born < 0) {
      born = now;
    }
    const since = then < 0 ? 1 / 60 : Math.min(now - then, 0.1);
    then = now;
    const age = now - born;
    const morphing = !still && age < morphSeconds + spreadSeconds;
    if (!still && !greeted && age > morphSeconds + spreadSeconds + 0.15) {
      greeted = true;
      ring.x = middle;
      ring.y = middle;
      ring.at = now;
    }
    const tide = still
      ? 0
      : tideDepth * smoothstep(0.12, 0.6, 0.5 - 0.5 * Math.cos(age * 0.21));
    const tideAt = now * look.tideSpeed;
    const follow = still ? 1 : 0.22;
    if (pointer.inside) {
      spotX += (pointer.x - spotX) * follow;
      spotY += (pointer.y - spotY) * follow;
    }
    spot += ((pointer.inside ? 1 : 0) - spot) * (still ? 1 : 0.12);
    const hovering = spot > 0.01;
    listening *= Math.exp(-since / heard.seconds);
    const travelled = (now - ring.at) * ringLook.speed;
    const ringLeft = 1 - (now - ring.at) / ringLook.seconds;

    counts.fill(0);
    const moment: Moment = {
      now,
      age,
      morphing,
      still,
      tide,
      tideAt,
      listening,
      ringLeft,
      travelled,
    };
    for (let at = 0; at < count; at += 1) {
      const dot = gathered(shape, cloud, at, moment);
      const own = cloud.seed[at] ?? 0;
      const perspective = 3.4 / (3.4 - dot.z);
      const sx = middle + dot.x * perspective * scale;
      const sy = middle - dot.y * perspective * scale;
      const near = hovering
        ? nearness(Math.hypot(sx - spotX, sy - spotY), reach, spot)
        : 0;
      const ringOff =
        (Math.hypot(sx - ring.x, sy - ring.y) - travelled) / ringLook.width;
      const heat = heatOf(near, cloud.ear[at] ?? 0, own, ringOff, moment);
      const alpha = alphaOf(dot, own, near, heat, moment);
      screenX[at] = sx;
      screenY[at] = sy;
      radius[at] =
        radiusOf(dot.printed, cloud.grain[at] ?? 0, near, heat) *
        gap *
        perspective;
      const b = bucketOf(alpha, heat);
      bucket[at] = b;
      counts[b] = (counts[b] ?? 0) + 1;
    }

    paint(context, styles, dpr, {
      screenX,
      screenY,
      radius,
      bucket,
      counts,
      starts,
      order,
    });
  };
  frame = requestAnimationFrame(draw);

  const place = (event: PointerEvent): { x: number; y: number } => {
    const box = element.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * size,
      y: ((event.clientY - box.top) / box.height) * size,
    };
  };
  const onMove = (event: PointerEvent): void => {
    Object.assign(pointer, place(event), { inside: true });
  };
  const onLeave = (): void => {
    pointer.inside = false;
  };
  const onDown = (event: PointerEvent): void => {
    if (!still) {
      Object.assign(ring, place(event), { at: performance.now() / 1000 });
    }
  };
  // It listens while the person types, wherever on the page that is.
  const onInput = (event: Event): void => {
    if (
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLInputElement
    ) {
      listening = Math.min(1, listening + heard.key);
    }
  };
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerleave", onLeave);
  element.addEventListener("pointerdown", onDown);
  document.addEventListener("input", onInput);

  return () => {
    cancelAnimationFrame(frame);
    watcher.disconnect();
    themes.disconnect();
    scheme.removeEventListener("change", repaint);
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerleave", onLeave);
    element.removeEventListener("pointerdown", onDown);
    document.removeEventListener("input", onInput);
  };
};

/**
 * The buddy, 128px. `aligned` pulls it a little to the left, so its
 * shoulders line up with words under it, as on the chat's start.
 */
export const GraspBuddy = ({ aligned = false }: { aligned?: boolean }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    return element === null ? undefined : animate(element);
  }, []);
  return (
    <canvas
      aria-hidden="true"
      className={aligned ? "-ml-4 size-32 flex-none" : "size-32 flex-none"}
      ref={canvas}
    />
  );
};
