// ---------------------------------------------------------------------------
// THALMORA — a travel poster for a place that isn't there.
//
// This program paints one 1024x1024 PNG poster for the invented destination
// "THALMORA" entirely from code: a golden-hour coastline, a great haloed beacon
// on a sea stack, and the place name set into the picture. No network, no
// assets, no network fonts — everything is rasterised here and written to
// $MAKEFUN_OUTPUT_DIR/entry.png (default /output/entry.png).
//
// Run with:  node main.ts          (Node 22.6+ / 24, TypeScript run directly)
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// 0. Geometry & render targets
// ---------------------------------------------------------------------------
const W = 1024; // final poster width
const H = 1024; // final poster height
const SS = 3; // supersampling factor: render at 3x, box-downsample for clean edges
const CW = W * SS;
const CH = H * SS;
const HORIZON = 604; // y of the sea horizon, in final pixels
const WATERLINE = 714; // y where the sea stack meets the water (reflection axis)

// The composition, in final pixels. Kept together so it can be tuned as a whole.
const SUN = { x: 704, y: 566, r: 44 };
const STACK = { cx: 336, base: 716, top: 588, hwBase: 48, hwTop: 27 }; // the sea stack
const TOWER = { cx: 336, base: 596, top: 292, hw: 12 }; // the beacon shaft
const HALO = { cx: 336, cy: 300, r: 66, w: 11 }; // the great ring the beacon carries

// ---------------------------------------------------------------------------
// 1. Deterministic RNG (the grader runs this twice and compares bytes, so
//    every random-looking value must be a pure function of a fixed seed).
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 2. A tiny software rasteriser (supersampled RGB buffer)
// ---------------------------------------------------------------------------
const buf = new Uint8Array(CW * CH * 3);

function setPx(x: number, y: number, r: number, g: number, b: number) {
  if (x < 0 || y < 0 || x >= CW || y >= CH) return;
  const i = (y * CW + x) * 3;
  // clamp: without this, a bright glow over a bright base wraps mod 256 and
  // turns warm highlights into false green/cyan bands
  buf[i] = r < 0 ? 0 : r > 255 ? 255 : r;
  buf[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
  buf[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
}

function blendPx(x: number, y: number, r: number, g: number, b: number, a: number) {
  if (x < 0 || y < 0 || x >= CW || y >= CH || a <= 0) return;
  const i = (y * CW + x) * 3;
  if (a >= 1) {
    buf[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    buf[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    buf[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    return;
  }
  buf[i] = buf[i] + (r - buf[i]) * a;
  buf[i + 1] = buf[i + 1] + (g - buf[i + 1]) * a;
  buf[i + 2] = buf[i + 2] + (b - buf[i + 2]) * a;
}

/** Scanline fill of a closed polygon (even-odd), points in supersampled space. */
function fillPoly(pts: number[][], r: number, g: number, b: number, a = 1) {
  let miny = Infinity;
  let maxy = -Infinity;
  for (const p of pts) {
    if (p[1] < miny) miny = p[1];
    if (p[1] > maxy) maxy = p[1];
  }
  const y0 = Math.max(0, Math.floor(miny));
  const y1 = Math.min(CH - 1, Math.ceil(maxy));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      if ((p[1] <= cy && q[1] > cy) || (q[1] <= cy && p[1] > cy)) {
        const t = (cy - p[1]) / (q[1] - p[1]);
        xs.push(p[0] + t * (q[0] - p[0]));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.round(xs[k]);
      const xb = Math.round(xs[k + 1]);
      for (let x = xa; x <= xb; x++) blendPx(x, y, r, g, b, a);
    }
  }
}

function poly(...pairs: number[][]) {
  return pairs;
}

function fillDisc(cx: number, cy: number, rad: number, r: number, g: number, b: number, a = 1) {
  const pts: number[][] = [];
  const n = 32;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(th) * rad, cy + Math.sin(th) * rad]);
  }
  fillPoly(pts, r, g, b, a);
}

/** Thick round-capped polyline (used for type and line work). */
function strokePolyline(pts: number[][], width: number, r: number, g: number, b: number, a = 1) {
  const hw = width / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const x0 = pts[i][0];
    const y0 = pts[i][1];
    const x1 = pts[i + 1][0];
    const y1 = pts[i + 1][1];
    let dx = x1 - x0;
    let dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1e-6;
    dx /= len;
    dy /= len;
    const nx = -dy * hw;
    const ny = dx * hw;
    fillPoly(
      [
        [x0 + nx, y0 + ny],
        [x1 + nx, y1 + ny],
        [x1 - nx, y1 - ny],
        [x0 - nx, y0 - ny],
      ],
      r,
      g,
      b,
      a,
    );
  }
  for (const p of pts) fillDisc(p[0], p[1], hw, r, g, b, a);
}

// ---------------------------------------------------------------------------
// 3. Colour helpers
// ---------------------------------------------------------------------------
type RGB = [number, number, number];

function mix(a: RGB, b: RGB, t: number): RGB {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

function stops(st: Array<[number, RGB]>, t: number): RGB {
  if (t <= st[0][0]) return st[0][1];
  for (let i = 0; i + 1 < st.length; i++) {
    if (t <= st[i + 1][0]) {
      const f = (t - st[i][0]) / (st[i + 1][0] - st[i][0]);
      return mix(st[i][1], st[i + 1][1], f);
    }
  }
  return st[st.length - 1][1];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// 4. Sky, sun, clouds
// ---------------------------------------------------------------------------
const SKY: Array<[number, RGB]> = [
  [0.0, [13, 22, 46]],
  [0.22, [24, 45, 78]],
  [0.42, [44, 86, 116]],
  [0.60, [96, 139, 152]],
  [0.76, [186, 160, 138]],
  [0.88, [231, 172, 116]],
  [0.96, [250, 203, 141]],
  [1.0, [255, 228, 180]],
];

const CLOUDS: Array<[number, number, number, number, number]> = [
  // cx, cy, rx, ry, strength
  [286, 476, 236, 40, 1.0],
  [140, 452, 158, 27, 0.72],
  [486, 512, 250, 34, 0.85],
  [742, 446, 178, 27, 0.55],
  [430, 372, 316, 20, 0.34],
  [214, 268, 196, 15, 0.26],
  [790, 262, 232, 16, 0.3],
  [612, 330, 150, 13, 0.22],
];

function cloudDensity(x: number, y: number) {
  let d = 0;
  for (const c of CLOUDS) {
    const dx = (x - c[0]) / c[2];
    const dy = (y - c[1]) / c[3];
    d += c[4] * Math.exp(-(dx * dx + dy * dy) * 1.55);
  }
  return clamp01(d);
}

function paintSky() {
  // Sun glow is additive over the gradient, so the disc reads as the source.
  for (let y = 0; y < HORIZON * SS; y++) {
    const t = y / (HORIZON * SS);
    const base = stops(SKY, t);
    for (let x = 0; x < CW; x++) {
      let r = base[0];
      let g = base[1];
      let b = base[2];

      const dxs = (x - SUN.x * SS) / SS;
      const dys = (y - SUN.y * SS) / SS;
      const dist = Math.hypot(dxs, dys);
      // broad warm glow — kept modest so the gradient survives instead of
      // clipping to white right across the horizon
      const glow = Math.exp(-dist / 236) * 26;
      const glow2 = Math.exp(-dist / 96) * 44;
      r += glow * 1.24 + glow2 * 1.08;
      g += glow * 0.86 + glow2 * 0.66;
      b += glow * 0.44 + glow2 * 0.18;

      // clouds, lit from the sun side
      const d = cloudDensity(x / SS, y / SS);
      if (d > 0.01) {
        const warm = Math.exp(-Math.hypot(dxs, dys) / 430);
        const lit = mix([126, 138, 164], [255, 216, 172], warm);
        const a = clamp01(d) * 0.92;
        r = r + (lit[0] - r) * a;
        g = g + (lit[1] - g) * a;
        b = b + (lit[2] - b) * a;
      }
      setPx(x, y, r, g, b);
    }
  }

  // sun disc + inner core
  fillDisc(SUN.x * SS, SUN.y * SS, SUN.r * SS, 255, 245, 220, 1);
  fillDisc(SUN.x * SS, SUN.y * SS, SUN.r * 0.62 * SS, 255, 252, 240, 1);
}

// ---------------------------------------------------------------------------
// 5. Distant headlands on the horizon
// ---------------------------------------------------------------------------
function paintIslands() {
  const haze: RGB = [126, 150, 170];
  const draw = (pts: number[][], tint: RGB, a: number) => {
    fillPoly(
      pts.map((p) => [p[0] * SS, p[1] * SS]),
      tint[0],
      tint[1],
      tint[2],
      a,
    );
  };
  // A warm haze band softens the sky/sea join before any land is laid on it.
  for (let y = (HORIZON - 26) * SS; y < HORIZON * SS; y++) {
    const t = (y / SS - (HORIZON - 26)) / 26;
    const a = 0.5 * Math.pow(t, 2.2);
    for (let x = 0; x < CW; x++) blendPx(x, y, 252, 214, 164, a);
  }
  // far left headland: a ridge of slender spires — Thalmora's own profile
  draw(
    [
      [-10, 614],
      [18, 600],
      [46, 552],
      [70, 600],
      [100, 566],
      [124, 536],
      [148, 586],
      [176, 554],
      [204, 594],
      [238, 568],
      [266, 598],
      [300, 580],
      [340, 600],
      [358, 614],
    ],
    mix(haze, [176, 178, 178], 0.42),
    0.9,
  );
  // a softer, closer ridge below it, for depth
  draw([[118, 612], [176, 588], [252, 594], [300, 612]], mix(haze, [96, 104, 120], 0.5), 0.8);
  // right hand island, set well clear of the sun so the disc stays whole
  draw(
    [[806, 610], [848, 588], [918, 580], [978, 590], [1024, 598], [1024, 614], [806, 614]],
    mix(haze, [214, 188, 162], 0.34),
    0.85,
  );
  // small islet near centre
  draw([[452, 608], [486, 596], [524, 598], [540, 608], [540, 612], [452, 612]], haze, 0.66);
  // a lone sail on the far water (scale cue)
  draw([[676, 604], [684, 592], [692, 604]], [58, 62, 78], 0.8);
  draw([[680, 604], [688, 606], [684, 604]], [58, 62, 78], 0.8);
  // Atmospheric haze laid over the far land last, so the distance recedes —
  // but held back near the sun, which must stay bright.
  for (let y = (HORIZON - 68) * SS; y < HORIZON * SS; y++) {
    const t = (y / SS - (HORIZON - 68)) / 68;
    const aBase = 0.6 * Math.pow(t, 1.9);
    for (let x = 0; x < CW; x++) {
      const nearSun = Math.exp(-Math.pow((x / SS - SUN.x) / 130, 2));
      blendPx(x, y, 250, 212, 166, aBase * (1 - 0.8 * nearSun));
    }
  }
}

// ---------------------------------------------------------------------------
// 6. The sea
// ---------------------------------------------------------------------------
function paintSea() {
  // Depth lives in the water: warm and pale at the horizon, deep navy in front.
  const SEA: Array<[number, RGB]> = [
    [0.0, [215, 208, 197]],
    [0.09, [178, 188, 197]],
    [0.3, [104, 130, 156]],
    [0.62, [42, 64, 98]],
    [1.0, [13, 23, 43]],
  ];
  for (let y = HORIZON * SS; y < CH; y++) {
    const fy = y / SS;
    const t = (fy - HORIZON) / (H - HORIZON);
    const base = stops(SEA, t);
    for (let x = 0; x < CW; x++) {
      const fx = x / SS;
      let r = base[0];
      let g = base[1];
      let b = base[2];

      // the sun path: a warm column running down the water under the disc
      const wcol = Math.exp(-Math.pow((fx - SUN.x) / 330, 2)) * Math.exp(-t * 3.4);
      r += (252 - r) * wcol * 0.5;
      g += (206 - g) * wcol * 0.5;
      b += (152 - b) * wcol * 0.5;

      // swell: crest lines that widen as they come toward the viewer
      const wob = Math.sin(fx * 0.016 + t * 4.2) * 2.1;
      const ripple = Math.sin(fy * 0.52 + wob);
      const amp = 5 + 24 * t;
      const crest = Math.pow(Math.max(0, ripple), 6);
      const trough = Math.pow(Math.max(0, -ripple), 6);
      r += crest * amp - trough * amp * 0.45;
      g += crest * amp * 0.96 - trough * amp * 0.45;
      b += crest * amp * 0.86 - trough * amp * 0.42;

      // sun glitter: irregular broken dashes on the crests, not a regular barcode
      const gx = (fx - SUN.x) / 124;
      const rowSeed = Math.sin(fy * 12.9898) * 43758.5453;
      const ph = rowSeed - Math.floor(rowSeed);
      const seg = Math.pow(Math.max(0, Math.sin(fx * (0.15 + ph * 0.1) + fy * 0.65 + ph * 6.283)), 16);
      const gy = Math.exp(-Math.max(0, fy - HORIZON) / 300);
      const gl = Math.exp(-gx * gx) * gy * seg * (140 + 96 * ph);
      r += gl;
      g += gl * 0.9;
      b += gl * 0.6;

      setPx(x, y, r, g, b);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Foreground: the cliff that frames the picture, the sea stack and beacon
// ---------------------------------------------------------------------------
const RIM: RGB = [255, 208, 150]; // warm rim light, sun side (right)
const DARK: RGB = [30, 30, 44]; // shaded body
const DARK2: RGB = [21, 22, 34];

function sv(x: number, y: number): number[] {
  return [x * SS, y * SS];
}

function paintForegroundCliff() {
  // dark headland rising from the bottom-left, framing the view
  fillPoly(
    [
      sv(-10, 1030),
      sv(-10, 742),
      sv(64, 726),
      sv(148, 744),
      sv(228, 786),
      sv(300, 840),
      sv(356, 906),
      sv(396, 980),
      sv(410, 1030),
    ],
    DARK[0],
    DARK[1],
    DARK[2],
    1,
  );
  // rim light along the sun-lit edge
  strokePolyline(
    [sv(-6, 744), sv(64, 728), sv(148, 746), sv(228, 788), sv(300, 842), sv(356, 908)],
    3.2 * SS,
    RIM[0],
    RIM[1],
    RIM[2],
    0.85,
  );
  // boulders on the shore: irregular dark rocks, sunward edges lit
  const rocks: number[][][] = [
    [[46, 842], [72, 804], [106, 796], [120, 820], [110, 848], [76, 858]],
    [[148, 902], [178, 870], [206, 878], [212, 910], [184, 930], [154, 924]],
    [[248, 958], [286, 928], [318, 946], [322, 980], [286, 998], [252, 990]],
  ];
  for (const rk of rocks) {
    fillPoly(rk.map((p) => sv(p[0], p[1])), 33, 32, 45, 1);
    // a shaded crevice, then a sunward rim on the top-right edge
    strokePolyline([sv(rk[1][0] + 14, rk[1][1] + 10), sv(rk[3][0] - 12, rk[3][1] - 8)], 3 * SS, 21, 21, 32, 0.55);
    strokePolyline([sv(rk[1][0], rk[1][1]), sv(rk[2][0], rk[2][1])], 3 * SS, RIM[0], RIM[1], RIM[2], 0.5);
  }
  // low vegetation along the cliff top, muted so it reads as grass, not lights
  const rnd = mulberry32(700913);
  for (let i = 0; i < 170; i++) {
    const gx = -6 + rnd() * 352;
    const gy = 744 + rnd() * 246;
    const hgt = 5 + rnd() * 12;
    const lean = (rnd() - 0.5) * 7;
    const tone = rnd();
    strokePolyline(
      [[gx * SS, gy * SS], [(gx + lean * 0.5) * SS, (gy - hgt * 0.6) * SS], [(gx + lean) * SS, (gy - hgt) * SS]],
      1.7 * SS,
      44 + tone * 26,
      44 + tone * 24,
      38 + tone * 20,
      0.6,
    );
  }
}

function paintSeaStack() {
  // rock body
  fillPoly(
    [
      sv(STACK.cx - STACK.hwBase, STACK.base),
      sv(STACK.cx - STACK.hwTop - 6, 660),
      sv(STACK.cx - STACK.hwTop, STACK.top + 6),
      sv(STACK.cx + STACK.hwTop, STACK.top - 4),
      sv(STACK.cx + STACK.hwTop + 8, 662),
      sv(STACK.cx + STACK.hwBase, STACK.base),
    ],
    DARK2[0],
    DARK2[1],
    DARK2[2],
    1,
  );
  // rim light down the sun-lit flank
  strokePolyline(
    [sv(STACK.cx + STACK.hwTop, STACK.top - 4), sv(STACK.cx + STACK.hwTop + 8, 662), sv(STACK.cx + STACK.hwBase, STACK.base - 4)],
    3 * SS,
    RIM[0],
    RIM[1],
    RIM[2],
    0.8,
  );
  // a few rock strata
  for (let i = 0; i < 5; i++) {
    const y = STACK.top + 26 + i * 22;
    const half = STACK.hwTop + 4 + i * 4.2;
    strokePolyline([sv(STACK.cx - half, y), sv(STACK.cx + half * 0.9, y + 3)], 1.6 * SS, 12, 13, 20, 0.5);
  }
}

/** Filled annulus segment, angles in degrees, 0 = right, 90 = down (screen). */
function ringArc(cx: number, cy: number, rad: number, width: number, a0: number, a1: number, r: number, g: number, b: number, a = 1) {
  const outer: number[][] = [];
  const inner: number[][] = [];
  const steps = Math.max(6, Math.round(Math.abs(a1 - a0) / 4));
  for (let i = 0; i <= steps; i++) {
    const th = ((a0 + (a1 - a0) * (i / steps)) * Math.PI) / 180;
    outer.push([cx + Math.cos(th) * (rad + width / 2), cy + Math.sin(th) * (rad + width / 2)]);
    inner.push([cx + Math.cos(th) * (rad - width / 2), cy + Math.sin(th) * (rad - width / 2)]);
  }
  fillPoly(outer.concat(inner.reverse()), r, g, b, a);
}

function paintBeacon() {
  const { cx, base, top, hw } = TOWER;
  const hcx = HALO.cx * SS;
  const hcy = HALO.cy * SS;
  const hr = HALO.r * SS;
  const hw2 = HALO.w * SS;

  // The halo is a ring the shaft passes through: its far (upper) half goes
  // behind the tower, its near (lower) half in front. That is what stops the
  // landmark reading as a flat graphic pasted on the sky.
  ringArc(hcx, hcy, hr, hw2, 182, 358, 28, 28, 42, 1);
  ringArc(hcx, hcy, hr, hw2 * 0.78, 300, 352, RIM[0], RIM[1], RIM[2], 0.7);
  ringArc(hcx, hcy, hr, hw2 * 0.6, 186, 246, 9, 10, 17, 0.55);

  // shaft
  fillPoly([sv(cx - hw, base), sv(cx - hw * 0.8, top), sv(cx + hw * 0.8, top), sv(cx + hw, base)], DARK[0], DARK[1], DARK[2], 1);
  // the sun catches the right flank — a mid-tone band so the tower has volume
  fillPoly(
    [sv(cx + hw * 0.26, base), sv(cx + hw * 0.2, top), sv(cx + hw * 0.8, top), sv(cx + hw, base)],
    74,
    62,
    62,
    1,
  );
  // ...and a bright rim line on the lit edge
  strokePolyline([sv(cx + hw * 0.8, top + 4), sv(cx + hw, base - 4)], 2.6 * SS, RIM[0], RIM[1], RIM[2], 0.95);
  // two thin window slits, warm
  for (let i = 0; i < 3; i++) {
    const wy = top + 60 + i * 78;
    strokePolyline([sv(cx + 3, wy), sv(cx + 3, wy + 12)], 2.6 * SS, 255, 226, 176, 0.8);
  }
  // gallery
  fillPoly([sv(cx - 22, top + 12), sv(cx + 22, top + 12), sv(cx + 18, top - 4), sv(cx - 18, top - 4)], 40, 40, 56, 1);
  // lantern room
  fillPoly([sv(cx - 13, top - 4), sv(cx + 13, top - 4), sv(cx + 11, top - 30), sv(cx - 11, top - 30)], 26, 26, 40, 1);
  // the light itself, warm and bright
  fillDisc(cx * SS, (top - 16) * SS, 9.5 * SS, 255, 236, 190, 1);
  fillDisc(cx * SS, (top - 16) * SS, 20 * SS, 255, 214, 150, 0.34);
  fillDisc(cx * SS, (top - 16) * SS, 34 * SS, 255, 200, 140, 0.14);
  // roof cone
  fillPoly([sv(cx - 14, top - 30), sv(cx + 14, top - 30), sv(cx, top - 48)], 26, 26, 40, 1);
  strokePolyline([sv(cx - 14, top - 30), sv(cx, top - 48), sv(cx + 14, top - 30)], 2 * SS, RIM[0], RIM[1], RIM[2], 0.6);

  // ---- the near (lower) half of the halo, in front of the shaft ----
  ringArc(hcx, hcy, hr, hw2, 2, 178, 34, 34, 50, 1);
  // the sun is low and to the right, so the near ring's right side is rim-lit
  ringArc(hcx, hcy, hr, hw2 * 0.8, -6, 82, RIM[0], RIM[1], RIM[2], 0.95);
  // and its lower-left sits in shade
  ringArc(hcx, hcy, hr, hw2 * 0.58, 96, 176, 10, 11, 18, 0.6);
  // two thin stays from the shaft to the ring
  for (const sgn of [-1, 1]) {
    strokePolyline(
      [sv(cx + sgn * 2, top - 30), sv(HALO.cx + sgn * HALO.r * 0.72, HALO.cy + HALO.r * 0.5)],
      1.4 * SS,
      14,
      15,
      22,
      0.85,
    );
  }
}

/** A wavy, dimmed vertical mirror of the stack/beacon drawn into the water. */
function paintReflection() {
  const axis = WATERLINE;
  // Reflections are foreshortened: the mirror of a tall tower is short, which
  // is also what keeps the whole landmark (halo included) inside the frame.
  const K = 0.6;

  const reflectPoly = (pts: number[][], r: number, g: number, b: number, aTop: number) => {
    // mirror each vertex about the waterline, then wobble horizontally per row
    const mir = pts.map((p) => [p[0], axis - (p[1] - axis) * K]);
    const ys = mir.map((p) => p[1]);
    const ymin = Math.max(HORIZON, Math.min(...ys));
    const ymax = Math.min(H, Math.max(...ys));
    const xsAt = (pts2: number[][], yy: number) => {
      const xs: number[] = [];
      for (let i = 0, n = pts2.length; i < n; i++) {
        const p = pts2[i];
        const q = pts2[(i + 1) % n];
        if ((p[1] <= yy && q[1] > yy) || (q[1] <= yy && p[1] > yy)) {
          const t = (yy - p[1]) / (q[1] - p[1]);
          xs.push(p[0] + t * (q[0] - p[0]));
        }
      }
      return xs.sort((m, n) => m - n);
    };
    for (let yy = Math.ceil(ymin); yy <= Math.floor(ymax); yy++) {
      const depth = (yy - axis) / 240;
      // ripples break the mirrored image into bands, so the reflection reads
      // as water rather than a solid dark shape under the tower
      const ripple = 0.6 + 0.4 * Math.sin(yy * 0.72 + 1.3);
      const a = aTop * Math.exp(-Math.max(0, depth) * 1.35) * ripple;
      if (a <= 0.02) continue;
      const wob = Math.sin(yy * 0.15) * (1.8 + Math.abs(yy - axis) * 0.03);
      const xs = xsAt(mir, yy);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.round((xs[k] + wob) * SS);
        const xb = Math.round((xs[k + 1] + wob) * SS);
        for (let x = xa; x <= xb; x++) blendPx(x, yy * SS, r, g, b, a);
      }
    }
  };

  // stack + shaft reflection
  reflectPoly(
    [
      [STACK.cx - STACK.hwBase, STACK.base],
      [STACK.cx - STACK.hwTop, STACK.top],
      [STACK.cx + STACK.hwTop, STACK.top],
      [STACK.cx + STACK.hwBase, STACK.base],
    ],
    DARK2[0],
    DARK2[1],
    DARK2[2],
    0.5,
  );
  reflectPoly(
    [
      [TOWER.cx - TOWER.hw, TOWER.base],
      [TOWER.cx - TOWER.hw * 0.8, TOWER.top],
      [TOWER.cx + TOWER.hw * 0.8, TOWER.top],
      [TOWER.cx + TOWER.hw, TOWER.base],
    ],
    26,
    26,
    40,
    0.42,
  );
  // the halo's own mirror, squashed by the shallower angle of the water
  const mOuter: number[][] = [];
  const mInner: number[][] = [];
  for (let i = 0; i < 72; i++) {
    const th = (i / 72) * Math.PI * 2;
    const co = Math.cos(th);
    const si = Math.sin(th);
    const oy = HALO.cy + si * (HALO.r + HALO.w / 2);
    const iy = HALO.cy + si * (HALO.r - HALO.w / 2);
    mOuter.push([(HALO.cx + co * (HALO.r + HALO.w / 2)) * SS, (axis - (oy - axis) * K) * SS]);
    mInner.push([(HALO.cx + co * (HALO.r - HALO.w / 2)) * SS, (axis - (iy - axis) * K) * SS]);
  }
  fillPoly(mOuter.concat(mInner.reverse()), 42, 42, 58, 0.34);
  // the reflected ring keeps the sun's kiss on its right side
  const mRim: number[][] = [];
  for (let a = -8; a <= 84; a += 6) {
    const th = (a * Math.PI) / 180;
    const oy = HALO.cy + Math.sin(th) * HALO.r;
    mRim.push([(HALO.cx + Math.cos(th) * HALO.r) * SS, (axis - (oy - axis) * K) * SS]);
  }
  strokePolyline(mRim, HALO.w * SS * 0.7, RIM[0], RIM[1], RIM[2], 0.5);
  // light pooling on the water where the wet ring lands: an elongated shimmer
  // (a round disc here read as a stray lens flare)
  const centreY = axis + (axis - HALO.cy) * K;
  const pool: number[][] = [];
  for (let i = 0; i < 48; i++) {
    const th = (i / 48) * Math.PI * 2;
    pool.push([(HALO.cx + Math.cos(th) * HALO.r * 1.2) * SS, (centreY + Math.sin(th) * 11) * SS]);
  }
  fillPoly(pool, 255, 200, 140, 0.13);
  // light smear of the lantern
  for (let i = 0; i < 24; i++) {
    const yy = axis + 6 + i * 8;
    if (yy > H) break;
    const a = 0.5 * Math.exp(-i * 0.16);
    const wob = Math.sin(i * 1.7) * 6;
    const cxx = (TOWER.cx + wob) * SS;
    const rr = (10 + i * 1.6) * SS;
    fillDisc(cxx, yy * SS, rr, 255, 208, 148, a * 0.5);
  }
}

function paintShore() {
  // A tight dark contact and a few foam lines where the stack meets the water —
  // the landmark has to sit *in* the sea, not float over it.
  const bx = STACK.cx;
  const pad: number[][] = [];
  const n = 40;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    pad.push([(bx + Math.cos(th) * 54) * SS, (WATERLINE + Math.sin(th) * 9) * SS]);
  }
  fillPoly(pad, 15, 19, 31, 0.34);
  for (let i = 0; i < 6; i++) {
    const y = WATERLINE - 5 + i * 4;
    const w = 40 + i * 11;
    strokePolyline([sv(bx - w, y), sv(bx + w, y)], (1.2 + i * 0.2) * SS, 255, 240, 210, 0.12 + i * 0.02);
  }
  // a second, small rock out in the water on the right, to weight that side
  const ix = 878;
  const iy = 686;
  fillPoly(
    [sv(ix - 44, iy + 30), sv(ix - 30, iy), sv(ix - 4, iy - 18), sv(ix + 24, iy - 6), sv(ix + 42, iy + 20), sv(ix + 48, iy + 30)],
    27,
    27,
    39,
    1,
  );
  strokePolyline([sv(ix - 4, iy - 18), sv(ix + 24, iy - 6), sv(ix + 42, iy + 20)], 2.4 * SS, RIM[0], RIM[1], RIM[2], 0.5);
  for (let i = 0; i < 16; i++) {
    const yy = iy + 32 + i * 5;
    const a = 0.3 * Math.exp(-i * 0.2);
    const w = 44 - i * 1.7;
    const wob = Math.sin(i * 1.3) * 4;
    strokePolyline([sv(ix - w + wob, yy), sv(ix + w + wob, yy)], 4 * SS, 26, 26, 38, a);
  }
  strokePolyline([sv(ix - 46, iy + 31), sv(ix + 50, iy + 31)], 2 * SS, 255, 240, 210, 0.2);
}

function paintVillage() {
  // A scatter of small dwellings with lit windows: the poster has to promise a
  // place you could actually stay, not just look at.
  const hut = (x: number, y: number, s: number) => {
    fillPoly([sv(x - s, y), sv(x + s, y), sv(x + s, y - s * 1.15), sv(x - s, y - s * 1.15)], 30, 30, 44, 1);
    fillPoly([sv(x - s * 1.35, y - s * 1.1), sv(x + s * 1.35, y - s * 1.1), sv(x, y - s * 2.3)], 26, 26, 40, 1);
    // sunward roof edge catches the last light
    strokePolyline([sv(x, y - s * 2.3), sv(x + s * 1.35, y - s * 1.1), sv(x + s, y - s * 1.05)], 1.6 * SS, RIM[0], RIM[1], RIM[2], 0.5);
    // a warm window, the promise of a lit room
    fillPoly([sv(x - s * 0.55, y - s * 0.35), sv(x - s * 0.05, y - s * 0.35), sv(x - s * 0.05, y - s * 0.95), sv(x - s * 0.55, y - s * 0.95)], 255, 216, 152, 0.92);
    if (s > 6) fillPoly([sv(x + s * 0.2, y - s * 0.35), sv(x + s * 0.62, y - s * 0.35), sv(x + s * 0.62, y - s * 0.9), sv(x + s * 0.2, y - s * 0.9)], 255, 208, 140, 0.7);
  };
  // along the cliff-top ridge, following its line into the distance
  hut(54, 742, 7);
  hut(88, 733, 6);
  hut(124, 740, 7);
  hut(162, 749, 6);
  hut(198, 766, 5);
  // a tiny outpost on the right-hand rock, so both shores feel inhabited
  hut(866, 684, 5);
  hut(892, 688, 4);
}

function paintBoat() {
  // a small sail crossing the middle distance: an invitation, and a scale cue
  const bx = 566;
  const by = 646;
  fillPoly([sv(bx - 16, by), sv(bx + 16, by), sv(bx + 10, by + 7), sv(bx - 10, by + 7)], 30, 30, 44, 1);
  fillPoly([sv(bx - 1, by - 34), sv(bx - 1, by - 2), sv(bx - 20, by - 2)], 240, 232, 214, 1);
  fillPoly([sv(bx + 2, by - 30), sv(bx + 2, by - 2), sv(bx + 15, by - 2)], 214, 196, 176, 1);
  strokePolyline([sv(bx - 1, by - 34), sv(bx - 1, by + 2)], 1.6 * SS, 22, 22, 32, 1);
  // reflection, mast and a trailing wake so the boat sits on the water
  fillPoly([sv(bx - 14, by + 7), sv(bx + 12, by + 7), sv(bx + 8, by + 15), sv(bx - 8, by + 15)], 30, 34, 50, 0.4);
  strokePolyline([sv(bx - 1, by + 8), sv(bx - 1, by + 21)], 1.4 * SS, 58, 58, 72, 0.3);
  strokePolyline([sv(bx - 22, by + 5), sv(bx - 42, by + 7), sv(bx - 62, by + 9)], 1.3 * SS, 238, 228, 210, 0.3);
  // a breath of haze over the boat, so it belongs to the far water
  for (let y = by - 42; y <= by + 22; y++) {
    for (let x = bx - 28; x <= bx + 22; x++) {
      blendPx(x * SS, y * SS, 246, 212, 172, 0.15);
    }
  }
}

function paintBirds() {
  const flock: Array<[number, number, number]> = [
    [442, 292, 9],
    [486, 264, 7],
    [524, 318, 8],
    [596, 246, 6],
    [640, 286, 5],
    [748, 318, 7],
    [812, 272, 6],
    [866, 322, 8],
    [914, 256, 5],
  ];
  for (const b of flock) {
    const [x, y, s] = b;
    strokePolyline([sv(x - s, y), sv(x - s * 0.35, y - s * 0.6), sv(x, y - s * 0.1)], 1.5 * SS, 20, 20, 30, 0.85);
    strokePolyline([sv(x, y - s * 0.1), sv(x + s * 0.35, y - s * 0.6), sv(x + s, y)], 1.5 * SS, 20, 20, 30, 0.85);
  }
}

// ---------------------------------------------------------------------------
// 8. Type: a monoline geometric display face, defined here so the name is
//    drawn by this program and not by a font file.
// ---------------------------------------------------------------------------
// Each glyph: w = advance width, s = list of polylines in a cap-height box
// (x in [0..w], y 0 = cap line, 1 = baseline).
const GLYPHS: Record<string, { w: number; s: number[][][] }> = {
  A: { w: 0.74, s: [[[0, 1], [0.37, 0], [0.74, 1]], [[0.135, 0.66], [0.605, 0.66]]] },
  B: {
    w: 0.6,
    s: [
      [[0, 0], [0, 1]],
      [[0, 0], [0.26, 0], [0.42, 0.13], [0.42, 0.34], [0.26, 0.47], [0, 0.47]],
      [[0, 0.47], [0.3, 0.47], [0.5, 0.62], [0.5, 0.85], [0.3, 1], [0, 1]],
    ],
  },
  C: { w: 0.62, s: [[[0.56, 0.14], [0.4, 0], [0.2, 0], [0.02, 0.16], [0.02, 0.5], [0.02, 0.84], [0.2, 1], [0.4, 1], [0.56, 0.86]]] },
  D: {
    w: 0.62,
    s: [
      [[0, 0], [0, 1]],
      [[0, 0], [0.26, 0], [0.48, 0.16], [0.48, 0.5], [0.48, 0.84], [0.26, 1], [0, 1]],
    ],
  },
  E: { w: 0.54, s: [[[0.54, 0], [0, 0], [0, 1], [0.54, 1]], [[0, 0.5], [0.42, 0.5]]] },
  F: { w: 0.5, s: [[[0.5, 0], [0, 0], [0, 1]], [[0, 0.5], [0.38, 0.5]]] },
  G: {
    w: 0.66,
    s: [
      [[0.58, 0.14], [0.42, 0], [0.2, 0], [0.02, 0.16], [0.02, 0.5], [0.02, 0.84], [0.2, 1], [0.44, 1], [0.6, 0.85], [0.6, 0.62], [0.34, 0.62]],
    ],
  },
  H: { w: 0.62, s: [[[0, 0], [0, 1]], [[0.62, 0], [0.62, 1]], [[0, 0.5], [0.62, 0.5]]] },
  I: { w: 0.16, s: [[[0.08, 0], [0.08, 1]]] },
  J: { w: 0.5, s: [[[0.5, 0], [0.5, 0.8], [0.36, 1], [0.14, 1], [0.02, 0.84]]] },
  K: { w: 0.58, s: [[[0, 0], [0, 1]], [[0.58, 0.02], [0.04, 0.52]], [[0.2, 0.4], [0.58, 1]]] },
  L: { w: 0.48, s: [[[0, 0], [0, 1], [0.48, 1]]] },
  M: { w: 0.88, s: [[[0, 1], [0, 0], [0.44, 0.6], [0.88, 0], [0.88, 1]]] },
  N: { w: 0.64, s: [[[0, 1], [0, 0], [0.64, 1], [0.64, 0]]] },
  O: { w: 0.7, s: [[[0.35, 0], [0.58, 0.12], [0.7, 0.5], [0.58, 0.88], [0.35, 1], [0.12, 0.88], [0, 0.5], [0.12, 0.12], [0.35, 0]]] },
  P: { w: 0.58, s: [[[0, 1], [0, 0], [0.34, 0], [0.52, 0.13], [0.52, 0.36], [0.34, 0.49], [0, 0.49]]] },
  Q: {
    w: 0.72,
    s: [
      [[0.36, 0], [0.59, 0.12], [0.72, 0.5], [0.59, 0.88], [0.36, 1], [0.13, 0.88], [0, 0.5], [0.13, 0.12], [0.36, 0]],
      [[0.5, 0.8], [0.74, 1.03]],
    ],
  },
  R: {
    w: 0.6,
    s: [
      [[0, 1], [0, 0], [0.34, 0], [0.52, 0.13], [0.52, 0.35], [0.34, 0.48], [0, 0.48]],
      [[0.3, 0.48], [0.6, 1]],
    ],
  },
  S: { w: 0.58, s: [[[0.55, 0.13], [0.4, 0], [0.18, 0], [0.03, 0.13], [0.03, 0.34], [0.18, 0.47], [0.42, 0.52], [0.55, 0.66], [0.55, 0.86], [0.4, 1], [0.17, 1], [0.02, 0.86]]] },
  T: { w: 0.6, s: [[[0, 0], [0.6, 0]], [[0.3, 0], [0.3, 1]]] },
  U: { w: 0.62, s: [[[0, 0], [0, 0.8], [0.14, 1], [0.48, 1], [0.62, 0.8], [0.62, 0]]] },
  V: { w: 0.72, s: [[[0, 0], [0.36, 1], [0.72, 0]]] },
  W: { w: 0.98, s: [[[0, 0], [0.22, 1], [0.49, 0.44], [0.76, 1], [0.98, 0]]] },
  X: { w: 0.64, s: [[[0, 0], [0.64, 1]], [[0.64, 0], [0, 1]]] },
  Y: { w: 0.6, s: [[[0, 0], [0.3, 0.5]], [[0.6, 0], [0.3, 0.5]], [[0.3, 0.5], [0.3, 1]]] },
  Z: { w: 0.58, s: [[[0, 0], [0.58, 0], [0, 1], [0.58, 1]]] },
  ' ': { w: 0.34, s: [] },
  '.': { w: 0.2, s: [[[0.1, 0.95], [0.1, 0.99]]] },
  '-': { w: 0.4, s: [[[0.05, 0.5], [0.35, 0.5]]] },
  '·': { w: 0.24, s: [[[0.12, 0.5], [0.12, 0.56]]] },
};

function glyphWidth(str: string, cap: number, track: number) {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    const g = GLYPHS[str[i]] ?? GLYPHS[' '];
    w += g.w * cap + (i ? track : 0);
  }
  return w;
}

function drawText(
  str: string,
  cxPx: number,
  baselinePx: number,
  cap: number,
  trackEm: number,
  strokeEm: number,
  col: RGB,
  a = 1,
) {
  const track = trackEm * cap;
  const total = glyphWidth(str, cap, track);
  let pen = cxPx - total / 2;
  const top = baselinePx - cap;
  const lw = strokeEm * cap;
  for (let i = 0; i < str.length; i++) {
    const g = GLYPHS[str[i]] ?? GLYPHS[' '];
    for (const sub of g.s) {
      const pts = sub.map((p) => [(pen + p[0] * cap) * SS, (top + p[1] * cap) * SS]);
      strokePolyline(pts, lw * SS, col[0], col[1], col[2], a);
    }
    pen += g.w * cap + track;
  }
  return total;
}

function paintType() {
  const cream: RGB = [247, 241, 227];
  const warmCream: RGB = [253, 236, 199];
  // the invented place name, large and held in the still-dark upper sky
  drawText('THALMORA', W / 2, 164, 96, 0.24, 0.15, warmCream, 1);

  // a rule with a diamond at each end and a larger one at its centre: the name
  // is *set*, locked to the picture, not dropped in afterwards
  const ruleY = 192;
  strokePolyline(
    [[W / 2 - 196, ruleY], [W / 2 - 34, ruleY]],
    2.4,
    cream[0],
    cream[1],
    cream[2],
    0.7,
  );
  strokePolyline([[W / 2 + 34, ruleY], [W / 2 + 196, ruleY]], 2.4, cream[0], cream[1], cream[2], 0.7);
  const diamond = (dx: number, rad: number, a: number) => {
    fillPoly(
      [
        [dx, ruleY - rad],
        [dx + rad, ruleY],
        [dx, ruleY + rad],
        [dx - rad, ruleY],
      ],
      cream[0],
      cream[1],
      cream[2],
      a,
    );
  };
  diamond(W / 2, 10, 0.9);
  diamond(W / 2 - 196, 5, 0.7);
  diamond(W / 2 + 196, 5, 0.7);

  // subtitle: what a stay there feels like
  drawText('THE LONG LIGHT COAST', W / 2, 224, 28, 0.3, 0.2, cream, 1);
}

// ---------------------------------------------------------------------------
// 9. Finishing: vignette, grain, a fine printed border
// ---------------------------------------------------------------------------
function paintFinish() {
  const cx = CW / 2;
  const cy = CH / 2;
  const maxd = Math.hypot(cx, cy);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxd;
      const v = 1 - 0.3 * d * d; // vignette
      const i = (y * CW + x) * 3;
      buf[i] *= v;
      buf[i + 1] *= v;
      buf[i + 2] *= v;
    }
  }
  // a fine carried border, inset — a printed poster's edge
  const m = 36;
  strokePolyline(
    [
      [m * SS, m * SS],
      [(W - m) * SS, m * SS],
      [(W - m) * SS, (H - m) * SS],
      [m * SS, (H - m) * SS],
      [m * SS, m * SS],
    ],
    2.2 * SS,
    247,
    241,
    227,
    0.5,
  );
}

// ---------------------------------------------------------------------------
// 10. Downsample 3x -> 1x with a box filter
// ---------------------------------------------------------------------------
function downsample() {
  const out = new Uint8Array(W * H * 3);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        const row = (y * SS + sy) * CW;
        for (let sx = 0; sx < SS; sx++) {
          const i = (row + x * SS + sx) * 3;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
        }
      }
      const o = (y * W + x) * 3;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
    }
  }
  // faint paper grain over the finished pixels, deterministic and kept light
  // so the truecolour PNG still compresses well under the 1 MiB cap
  const rnd = mulberry32(4242);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = (rnd() - 0.5) * 3;
      const i = (y * W + x) * 3;
      out[i] += n;
      out[i + 1] += n;
      out[i + 2] += n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 11. PNG writer (RGB truecolour, with a palette fallback if we ever exceed 1 MiB)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** PNG Paeth predictor. */
function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Filter the RGB scanlines the way PNG wants them: for each row pick the filter
 * (None/Sub/Up/Average/Paeth) with the smallest sum of absolute differences.
 * On a smooth gradient this shrinks the deflated stream several-fold, which is
 * what keeps the truecolour file comfortably under the 1 MiB cap.
 */
function filterScanlines(rgb: Uint8Array) {
  const stride = 1 + W * 3;
  const out = Buffer.allocUnsafe(H * stride);
  const cur = new Uint8Array(W * 3);
  const prev = new Uint8Array(W * 3);
  const cand: Uint8Array[] = [new Uint8Array(W * 3), new Uint8Array(W * 3), new Uint8Array(W * 3), new Uint8Array(W * 3), new Uint8Array(W * 3)];
  for (let y = 0; y < H; y++) {
    cur.set(rgb.subarray(y * W * 3, (y + 1) * W * 3));
    for (let i = 0; i < W * 3; i++) {
      const a = i >= 3 ? cur[i - 3] : 0;
      const b = y > 0 ? prev[i] : 0;
      const c = y > 0 && i >= 3 ? prev[i - 3] : 0;
      const x = cur[i];
      cand[0][i] = x & 0xff;
      cand[1][i] = (x - a) & 0xff;
      cand[2][i] = (x - b) & 0xff;
      cand[3][i] = (x - ((a + b) >> 1)) & 0xff;
      cand[4][i] = (x - paeth(a, b, c)) & 0xff;
    }
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const arr = cand[f];
      let s = 0;
      for (let i = 0; i < W * 3; i++) {
        const v = arr[i];
        s += v < 128 ? v : 256 - v;
      }
      if (s < bestScore) {
        bestScore = s;
        best = f;
      }
    }
    const o = y * stride;
    out[o] = best;
    Buffer.from(cand[best].buffer, cand[best].byteOffset, W * 3).copy(out, o + 1);
    prev.set(cur);
  }
  return out;
}

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

function encodeRGB(rgb: Uint8Array) {
  const raw = filterScanlines(rgb);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Median-cut quantiser to 256 colours, used only if the RGB PNG is too large. */
function encodePalette(rgb: Uint8Array) {
  const boxes: number[][] = [];
  const all: number[] = [];
  for (let i = 0; i < rgb.length; i += 3 * 3) all.push(i);
  boxes.push(all);
  const split = (idx: number[]) => {
    let lo = [255, 255, 255];
    let hi = [0, 0, 0];
    for (const i of idx) {
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], rgb[i + c]);
        hi[c] = Math.max(hi[c], rgb[i + c]);
      }
    }
    const ch = hi[0] - lo[0] >= hi[1] - lo[1] ? (hi[0] - lo[0] >= hi[2] - lo[2] ? 0 : 2) : hi[1] - lo[1] >= hi[2] - lo[2] ? 1 : 2;
    idx.sort((a, b) => rgb[a + ch] - rgb[b + ch]);
    return [idx.slice(0, idx.length >> 1), idx.slice(idx.length >> 1)];
  };
  while (boxes.length < 256) {
    boxes.sort((a, b) => b.length - a.length);
    const big = boxes.shift();
    if (!big || big.length < 2) {
      if (big) boxes.push(big);
      break;
    }
    const [l, r] = split(big);
    boxes.push(l, r);
  }
  const palette = Buffer.alloc(256 * 3);
  const means: RGB[] = [];
  boxes.forEach((b, bi) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const i of b) {
      r += rgb[i];
      g += rgb[i + 1];
      bl += rgb[i + 2];
    }
    const n = b.length || 1;
    const m: RGB = [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
    means.push(m);
    palette[bi * 3] = m[0];
    palette[bi * 3 + 1] = m[1];
    palette[bi * 3 + 2] = m[2];
  });
  const cache = new Int16Array(32768).fill(-1);
  const idx = new Uint8Array(W * H);
  for (let p = 0, k = 0; p < rgb.length; p += 3, k++) {
    const key = ((rgb[p] >> 3) << 10) | ((rgb[p + 1] >> 3) << 5) | (rgb[p + 2] >> 3);
    let best = cache[key];
    if (best < 0) {
      let bd = Infinity;
      best = 0;
      for (let i = 0; i < means.length; i++) {
        const dr = rgb[p] - means[i][0];
        const dg = rgb[p + 1] - means[i][1];
        const db = rgb[p + 2] - means[i][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      cache[key] = best;
    }
    idx[k] = best;
  }
  const raw = Buffer.alloc(H * (1 + W));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W)] = 0;
    Buffer.from(idx.subarray(y * W, (y + 1) * W)).copy(raw, y * (1 + W) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 3; // palette
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', palette),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 12. Compose and write
// ---------------------------------------------------------------------------
function main() {
  paintSky();
  paintIslands();
  paintSea();
  paintForegroundCliff();
  paintVillage();
  paintSeaStack();
  paintBeacon();
  paintReflection();
  paintShore();
  paintBoat();
  paintBirds();
  paintType();
  paintFinish();

  const rgb = downsample();
  let png = encodeRGB(rgb);
  console.log(`rgb png: ${png.length} bytes`);
  if (png.length > 1048576) png = encodePalette(rgb);

  const dir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'entry.png');
  fs.writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes, ${W}x${H})`);
}

main();
