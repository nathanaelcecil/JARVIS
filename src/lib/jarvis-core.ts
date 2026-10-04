/**
 * JARVIS computational intelligence core.
 * Procedural multi-system renderer: nucleus fragments, irregular shell,
 * broken orbital rings, neural filaments, sparks, pulses and data bursts.
 * Pure Canvas2D with additive compositing — no WebGL dependency.
 */

export type JarvisState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "burst"
  | "system";

type StateProfile = {
  activity: number; // global motion multiplier
  coreGlow: number;
  pulseInterval: number;
  filament: number;
  inflow: number; // particles drawn toward center
  density: number;
  geometry: number; // circuitry / structured look
  burstRate: number;
};

const PROFILES: Record<JarvisState, StateProfile> = {
  idle: { activity: 0.55, coreGlow: 0.85, pulseInterval: 6.2, filament: 0.55, inflow: 0, density: 0.9, geometry: 0.15, burstRate: 0.02 },
  listening: { activity: 0.75, coreGlow: 1.05, pulseInterval: 3.6, filament: 0.7, inflow: 0.75, density: 1, geometry: 0.15, burstRate: 0.04 },
  thinking: { activity: 1.35, coreGlow: 1.25, pulseInterval: 2.2, filament: 1.15, inflow: 0.25, density: 1.15, geometry: 0.3, burstRate: 0.08 },
  speaking: { activity: 1, coreGlow: 1.2, pulseInterval: 1.35, filament: 1, inflow: 0, density: 1.05, geometry: 0.2, burstRate: 0.05 },
  burst: { activity: 1.9, coreGlow: 1.75, pulseInterval: 0.85, filament: 1.6, inflow: 0.4, density: 1.4, geometry: 0.35, burstRate: 0.55 },
  system: { activity: 0.9, coreGlow: 1, pulseInterval: 3, filament: 0.95, inflow: 0.1, density: 1, geometry: 1, burstRate: 0.05 },
};

/* ---------------- utilities ---------------- */

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type V3 = { x: number; y: number; z: number };

function rot(p: V3, ax: number, ay: number, az: number): V3 {
  let { x, y, z } = p;
  let c = Math.cos(ax), s = Math.sin(ax);
  let y1 = y * c - z * s, z1 = y * s + z * c;
  y = y1; z = z1;
  c = Math.cos(ay); s = Math.sin(ay);
  let x1 = x * c + z * s; z1 = -x * s + z * c;
  x = x1; z = z1;
  c = Math.cos(az); s = Math.sin(az);
  const x2 = x * c - y * s, y2 = x * s + y * c;
  return { x: x2, y: y2, z };
}

/** amber ramp: t 0 -> deep copper, 1 -> white-hot gold */
function amber(t: number, a: number) {
  const k = Math.max(0, Math.min(1, t));
  const r = 120 + 135 * Math.pow(k, 0.45);
  const g = 40 + 200 * Math.pow(k, 1.25);
  const b = 8 + 215 * Math.pow(k, 4.2);
  return `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(3)})`;
}

/* ---------------- element types ---------------- */

type Particle = {
  p: V3;
  base: number; // base radius
  layer: number; // 0 nucleus .. 4 distant
  size: number;
  bright: number;
  phase: number;
  spin: number;
  wob: number;
  kind: number; // 0 dot 1 dash 2 streak 3 chip
  ang: number;
};

type RingSeg = {
  a0: number;
  a1: number;
  r: number;
  w: number;
  bright: number;
  tilt: V3;
  spin: number;
  ring: number;
  jitter: number;
  flare: number;
};

type FilNode = V3;
type Filament = {
  pts: FilNode[];
  bright: number;
  w: number;
  spin: number;
  tilt: V3;
  life: number;
  phase: number;
  reach: number;
};

type Spark = {
  p: V3;
  v: V3;
  life: number;
  max: number;
  size: number;
  bright: number;
};

export class JarvisCoreEngine {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private raf = 0;
  private t = 0;
  private last = 0;
  private dpr = 1;
  private W = 0;
  private H = 0;
  private R = 300; // core radius in px

  private particles: Particle[] = [];
  private segs: RingSeg[] = [];
  private fils: Filament[] = [];
  private sparks: Spark[] = [];
  private pulses: { r: number; strength: number }[] = [];
  private nextPulse = 1.5;
  private burstEnergy = 0;
  private nextBurst = 8;

  private state: JarvisState = "idle";
  private cur: StateProfile = { ...PROFILES.idle };
  private densityScale = 1;

  /* ---- interaction state: drag-rotate, wheel-expand, pointer aura ---- */
  private viewRX = 0;
  private viewRY = 0;
  private velX = 0;
  private velY = 0;
  private dragging = false;
  private lastPX = 0;
  private lastPY = 0;
  private zoom = 1;
  private zoomTarget = 1;
  private pxn = 0; // pointer, normalized -1..1 from center
  private pyn = 0;
  private mx = 0; // pointer, px from center
  private my = 0;
  private pActive = 0; // eased pointer presence
  private offsetX = 0; // horizontal offset for chat panel
  private offsetTarget = 0;
  private pTarget = 0;
  // precomputed view trig, refreshed once per frame
  private cRX = 1;
  private sRX = 0;
  private cRY = 1;
  private sRY = 0;
  private detachInput: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const c = canvas.getContext("2d", { alpha: false });
    if (!c) throw new Error("2d context unavailable");
    this.ctx = c;
    this.resize();
    this.build();
    this.bindInput();
  }

  private bindInput() {
    const canvas = this.canvas;
    const toLocal = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left - this.W * 0.5;
      const y = e.clientY - r.top - this.H * 0.5;
      return { x, y };
    };
    const onDown = (e: PointerEvent) => {
      this.dragging = true;
      this.lastPX = e.clientX;
      this.lastPY = e.clientY;
      this.velX = 0;
      this.velY = 0;
    };
    const onMove = (e: PointerEvent) => {
      const { x, y } = toLocal(e);
      this.mx = x;
      this.my = y;
      this.pxn = Math.max(-1, Math.min(1, x / (this.W * 0.5)));
      this.pyn = Math.max(-1, Math.min(1, y / (this.H * 0.5)));
      this.pTarget = 1;
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPX;
      const dy = e.clientY - this.lastPY;
      this.lastPX = e.clientX;
      this.lastPY = e.clientY;
      const k = 0.0042;
      this.viewRY += dx * k;
      this.viewRX += dy * k;
      this.velY = dx * k * 60;
      this.velX = dy * k * 60;
    };
    const onUp = () => {
      this.dragging = false;
    };
    const onLeave = () => {
      this.pTarget = 0;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      this.zoomTarget = Math.max(0.7, Math.min(1.6, this.zoomTarget * Math.exp(-dy * 0.0016)));
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    this.detachInput = () => {
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }

  setState(s: JarvisState) {
    this.state = s;
  }

  setOffsetX(x: number) {
    this.offsetTarget = x;
  }

  start() {
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.detachInput?.();
    this.detachInput = null;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(320, rect.width);
    this.H = Math.max(320, rect.height);
    this.canvas.width = Math.floor(this.W * this.dpr);
    this.canvas.height = Math.floor(this.H * this.dpr);
    this.R = Math.min(this.H * 0.335, this.W * 0.42);
    this.densityScale = this.W < 760 ? 0.5 : this.W < 1200 ? 0.75 : 1;
  }

  /* ---------------- procedural construction ---------------- */

  private build() {
    const rnd = mulberry(20260827);
    this.particles = [];
    this.segs = [];
    this.fils = [];

    // Asymmetry field: a few dense lobes and a few voids on the sphere.
    const lobes = Array.from({ length: 5 }, () => ({
      dir: this.randDir(rnd),
      k: 0.5 + rnd() * 1.8,
      w: 0.25 + rnd() * 0.5,
    }));
    const voids = Array.from({ length: 3 }, () => ({
      dir: this.randDir(rnd),
      w: 0.2 + rnd() * 0.35,
    }));

    const weight = (d: V3) => {
      let w = 0.35;
      for (const l of lobes) {
        const dot = d.x * l.dir.x + d.y * l.dir.y + d.z * l.dir.z;
        w += l.k * Math.exp(-Math.pow(1 - dot, 2) / (2 * l.w * l.w));
      }
      for (const v of voids) {
        const dot = d.x * v.dir.x + d.y * v.dir.y + d.z * v.dir.z;
        w *= 1 - 0.92 * Math.exp(-Math.pow(1 - dot, 2) / (2 * v.w * v.w));
      }
      return w;
    };

    // --- nucleus: extremely dense fragment cluster
    const NUC = 2600;
    for (let i = 0; i < NUC; i++) {
      const d = this.randDir(rnd);
      const r = 0.03 + Math.pow(rnd(), 2.4) * 0.34;
      this.particles.push({
        p: { x: d.x * r, y: d.y * r, z: d.z * r },
        base: r,
        layer: 0,
        size: 0.55 + Math.pow(rnd(), 3) * 2.8,
        bright: 0.55 + rnd() * 0.45,
        phase: rnd() * 6.283,
        spin: 0.22 + rnd() * 0.5,
        wob: 0.4 + rnd() * 1.6,
        kind: rnd() < 0.55 ? 0 : rnd() < 0.6 ? 1 : rnd() < 0.7 ? 3 : 2,
        ang: rnd() * 6.283,
      });
    }

    // --- inner + shell + outer + distant, weighted by asymmetry field
    const bands: Array<[number, number, number, number]> = [
      // [count, rmin, rmax, layer]
      [3000, 0.24, 0.6, 1],
      [3200, 0.58, 0.88, 2],
      [5200, 0.88, 1.02, 2], // dense fragmented surface shell -> spherical silhouette
      [2600, 1.0, 1.09, 2], // outer rim crust
      [1400, 0.7, 1.0, 2],
      [1500, 1.08, 1.3, 3],
      [600, 1.28, 1.75, 4],
    ];
    for (const [count, rmin, rmax, layer] of bands) {
      let made = 0;
      let guard = 0;
      while (made < count && guard < count * 25) {
        guard++;
        const d = this.randDir(rnd);
        const w = weight(d);
        if (rnd() > Math.min(1, w / 1.6)) continue;
        // irregular radial shell — never a clean sphere
        const shellNoise =
          0.93 +
          0.14 * Math.sin(d.x * 5.1 + d.y * 3.3) * Math.cos(d.z * 4.4 - d.x * 2.1) +
          0.06 * Math.sin(d.y * 11.3 + d.z * 7.7);
        let r = (rmin + (rmax - rmin) * Math.pow(rnd(), 1.6)) * shellNoise;
        if (rnd() < 0.02) r *= 1.25 + rnd() * 0.4; // torn-away pieces
        made++;
        this.particles.push({
          p: { x: d.x * r, y: d.y * r, z: d.z * r },
          base: r,
          layer,
          size: 0.3 + Math.pow(rnd(), 3.4) * (layer > 2 ? 1.2 : 1.8),
          bright: (0.28 + rnd() * 1.0) * Math.min(1.5, w),
          phase: rnd() * 6.283,
          spin: (0.16 - layer * 0.025) * (0.5 + rnd()),
          wob: 0.2 + rnd() * 1.2,
          kind: rnd() < 0.58 ? 0 : rnd() < 0.5 ? 2 : rnd() < 0.62 ? 3 : 1,
          ang: rnd() * 6.283,
        });
      }
    }

    // --- broken orbital rings (9), each fragmented into many SHORT arcs
    const RINGS = 9;
    for (let ri = 0; ri < RINGS; ri++) {
      const tilt = {
        x: (rnd() - 0.5) * 2.6,
        y: rnd() * 6.283,
        z: (rnd() - 0.5) * 1.6,
      };
      const r = 0.5 + ri * 0.065 + (rnd() - 0.5) * 0.06;
      const spin = (rnd() < 0.5 ? -1 : 1) * (0.012 + rnd() * 0.05);
      const ringBright = 0.35 + Math.pow(rnd(), 1.6) * 0.85;
      let a = rnd() * 6.283;
      const total = a + 6.283;
      while (a < total) {
        const gap = 0.02 + Math.pow(rnd(), 2.2) * 0.28;
        const len = 0.02 + Math.pow(rnd(), 2.1) * 0.26;
        if (rnd() < 0.82) {
          this.segs.push({
            a0: a,
            a1: a + len,
            r: r * (0.97 + rnd() * 0.07),
            w: 0.4 + Math.pow(rnd(), 3) * 1.5,
            bright: ringBright * (0.2 + rnd() * 0.95),
            tilt,
            spin,
            ring: ri,
            jitter: rnd() * 6.283,
            flare: rnd(),
          });
        }
        a += len + gap;
      }
      // ring debris + branching sparks riding the orbit
      const deb = 220;
      for (let i = 0; i < deb; i++) {
        const ang = rnd() * 6.283;
        const rr = r * (0.94 + rnd() * 0.12);
        const p = rot({ x: Math.cos(ang) * rr, y: (rnd() - 0.5) * 0.03, z: Math.sin(ang) * rr }, tilt.x, tilt.y, tilt.z);
        this.particles.push({
          p,
          base: rr,
          layer: 2,
          size: 0.3 + Math.pow(rnd(), 3.2) * 1.4,
          bright: 0.2 + rnd() * 0.85,
          phase: rnd() * 6.283,
          spin: spin * 6,
          wob: 0.1 + rnd() * 0.4,
          kind: rnd() < 0.6 ? 0 : 1,
          ang: rnd() * 6.283,
        });
      }
    }

    // --- hundreds of tiny free-floating broken arcs defining the shell crust
    const ARCS = 900;
    for (let i = 0; i < ARCS; i++) {
      const tilt = { x: (rnd() - 0.5) * 3.14, y: rnd() * 6.283, z: (rnd() - 0.5) * 3.14 };
      const a0 = rnd() * 6.283;
      const len = 0.015 + Math.pow(rnd(), 2.4) * 0.2;
      const shell = rnd();
      const r =
        shell < 0.62
          ? 0.9 + rnd() * 0.16 // crust
          : shell < 0.88
            ? 0.45 + rnd() * 0.42 // interior layers
            : 1.06 + rnd() * 0.22; // slightly outside
      // reject against the asymmetry field using the arc midpoint direction
      const mid = a0 + len * 0.5;
      const d = this.norm(rot({ x: Math.cos(mid), y: 0, z: Math.sin(mid) }, tilt.x, tilt.y, tilt.z));
      if (rnd() > Math.min(1, weight(d) / 1.5)) continue;
      this.segs.push({
        a0,
        a1: a0 + len,
        r,
        w: 0.35 + Math.pow(rnd(), 3.2) * 1.1,
        bright: 0.25 + Math.pow(rnd(), 1.8) * 1.0,
        tilt,
        spin: (rnd() < 0.5 ? -1 : 1) * (0.004 + rnd() * 0.02),
        ring: 90 + i,
        jitter: rnd() * 6.283,
        flare: rnd(),
      });
    }


    // --- neural / data filaments
    const FIL = 760;
    for (let i = 0; i < FIL; i++) {
      const d0 = this.randDir(rnd);
      const w = weight(d0);
      if (rnd() > Math.min(1, w / 1.3)) {
        // keep some anyway so dark sides aren't empty, but far fewer
        if (rnd() > 0.18) continue;
      }
      // filaments live ON the computational mass, not radiating from the centre
      const r0 = 0.3 + Math.pow(rnd(), 0.8) * 0.75;
      const reach = 0.06 + Math.pow(rnd(), 2.6) * 0.26;
      const steps = 6 + Math.floor(rnd() * 12);
      const pts: FilNode[] = [];
      let cur = { x: d0.x * r0, y: d0.y * r0, z: d0.z * r0 };
      // start tangential to the shell so paths crawl around the sphere
      const helper = this.randDir(rnd);
      let dir = this.norm({
        x: d0.y * helper.z - d0.z * helper.y,
        y: d0.z * helper.x - d0.x * helper.z,
        z: d0.x * helper.y - d0.y * helper.x,
      });
      for (let s = 0; s < steps; s++) {
        const step = (reach / steps) * (0.5 + rnd());
        dir = this.norm({
          x: dir.x + (rnd() - 0.5) * 0.95,
          y: dir.y + (rnd() - 0.5) * 0.95,
          z: dir.z + (rnd() - 0.5) * 0.95,
        });
        cur = { x: cur.x + dir.x * step, y: cur.y + dir.y * step, z: cur.z + dir.z * step };
        const m = Math.hypot(cur.x, cur.y, cur.z);
        if (m > 1.18) {
          cur = { x: (cur.x / m) * 1.18, y: (cur.y / m) * 1.18, z: (cur.z / m) * 1.18 };
          pts.push(cur);
          break;
        }
        pts.push(cur);
      }

      const tilt = { x: (rnd() - 0.5) * 0.3, y: rnd() * 6.283, z: 0 };
      this.fils.push({
        pts,
        bright: 0.14 + Math.pow(rnd(), 1.9) * 0.8,
        w: 0.3 + Math.pow(rnd(), 3) * 1.5,
        spin: (rnd() < 0.5 ? -1 : 1) * (0.005 + rnd() * 0.03),
        tilt,
        life: rnd(),
        phase: rnd() * 6.283,
        reach,
      });
      // branch
      if (rnd() < 0.35 && pts.length > 3) {
        const from = pts[2 + Math.floor(rnd() * (pts.length - 3))] ?? pts[0]!;
        const bp: FilNode[] = [];
        let bd = this.randDir(rnd);
        let bc = { ...from };
        const bs = 2 + Math.floor(rnd() * 5);
        for (let s = 0; s < bs; s++) {
          bd = this.norm({ x: bd.x + (rnd() - 0.5) * 0.9, y: bd.y + (rnd() - 0.5) * 0.9, z: bd.z + (rnd() - 0.5) * 0.9 });
          const st = 0.05 + rnd() * 0.13;
          bc = { x: bc.x + bd.x * st, y: bc.y + bd.y * st, z: bc.z + bd.z * st };
          bp.push(bc);
        }
        this.fils.push({
          pts: bp,
          bright: 0.12 + rnd() * 0.7,
          w: 0.25 + rnd() * 0.8,
          spin: 0.008,
          tilt,
          life: rnd(),
          phase: rnd() * 6.283,
          reach,
        });
      }
    }
  }

  private randDir(rnd: () => number): V3 {
    const u = rnd() * 2 - 1;
    const th = rnd() * 6.283;
    const s = Math.sqrt(1 - u * u);
    return { x: s * Math.cos(th), y: u, z: s * Math.sin(th) };
  }

  private norm(v: V3): V3 {
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  }

  /* ---------------- simulation ---------------- */

  private step(dt: number) {
    /* --- interaction: inertia rotation, zoom easing, pointer presence --- */
    if (!this.dragging) {
      this.viewRY += this.velY * dt;
      this.viewRX += this.velX * dt;
      const damp = Math.exp(-dt * 1.9);
      this.velX *= damp;
      this.velY *= damp;
      // slowly relax the vertical tilt back toward level
      this.viewRX *= Math.exp(-dt * 0.35);
    }
    this.viewRX = Math.max(-1.1, Math.min(1.1, this.viewRX));
    this.zoom += (this.zoomTarget - this.zoom) * (1 - Math.exp(-dt * 6));
    this.pActive += (this.pTarget - this.pActive) * (1 - Math.exp(-dt * 3));
    this.offsetX += (this.offsetTarget - this.offsetX) * (1 - Math.exp(-dt * 2.5));
    this.cRX = Math.cos(this.viewRX);
    this.sRX = Math.sin(this.viewRX);
    this.cRY = Math.cos(this.viewRY);
    this.sRY = Math.sin(this.viewRY);

    const target = PROFILES[this.state];
    const k = 1 - Math.exp(-dt * 1.6);
    const c = this.cur;

    c.activity += (target.activity - c.activity) * k;
    c.coreGlow += (target.coreGlow - c.coreGlow) * k;
    c.pulseInterval += (target.pulseInterval - c.pulseInterval) * k;
    c.filament += (target.filament - c.filament) * k;
    c.inflow += (target.inflow - c.inflow) * k;
    c.density += (target.density - c.density) * k;
    c.geometry += (target.geometry - c.geometry) * k;
    c.burstRate += (target.burstRate - c.burstRate) * k;

    // pulses travel outward from nucleus
    this.nextPulse -= dt;
    if (this.nextPulse <= 0) {
      this.pulses.push({ r: 0, strength: 1 });
      this.nextPulse = c.pulseInterval * (0.75 + Math.random() * 0.5);
    }
    for (const p of this.pulses) {
      p.r += dt * (0.85 + c.activity * 0.5);
      p.strength *= Math.exp(-dt * 0.5);
    }
    this.pulses = this.pulses.filter((p) => p.r < 3.2 && p.strength > 0.03);

    // data bursts
    this.burstEnergy *= Math.exp(-dt * 1.1);
    this.nextBurst -= dt * (0.4 + c.burstRate * 9);
    if (this.nextBurst <= 0) {
      this.nextBurst = 5 + Math.random() * 9;
      this.burstEnergy = Math.min(2.4, this.burstEnergy + 1.4);
      this.pulses.push({ r: 0, strength: 1.9 });
      const n = 70 + Math.floor(Math.random() * 120);
      for (let i = 0; i < n; i++) this.emitSpark(0.9 + Math.random());
    }

    // ambient sparks
    if (Math.random() < dt * (8 + c.activity * 20)) this.emitSpark(0.3 + Math.random() * 0.5);

    for (const s of this.sparks) {
      s.life -= dt;
      s.p.x += s.v.x * dt;
      s.p.y += s.v.y * dt;
      s.p.z += s.v.z * dt;
      s.v.x *= 1 - dt * 0.6;
      s.v.y *= 1 - dt * 0.6;
      s.v.z *= 1 - dt * 0.6;
    }
    this.sparks = this.sparks.filter((s) => s.life > 0);
  }

  private emitSpark(power: number) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * 6.283;
    const s = Math.sqrt(1 - u * u);
    const d = { x: s * Math.cos(th), y: u, z: s * Math.sin(th) };
    // sparks ignite inside the computational mass, not at the very centre,
    // and mostly slide along the shell instead of shooting radially out
    const r0 = 0.3 + Math.random() * 0.75;
    const h = { x: Math.random() - 0.5, y: Math.random() - 0.5, z: Math.random() - 0.5 };
    const tan = this.norm({
      x: d.y * h.z - d.z * h.y,
      y: d.z * h.x - d.x * h.z,
      z: d.x * h.y - d.y * h.x,
    });
    const sp = (0.12 + Math.random() * 0.4) * power;
    const out = 0.12 + Math.random() * 0.35;
    this.sparks.push({
      p: { x: d.x * r0, y: d.y * r0, z: d.z * r0 },
      v: {
        x: (tan.x * (1 - out) + d.x * out) * sp,
        y: (tan.y * (1 - out) + d.y * out) * sp,
        z: (tan.z * (1 - out) + d.z * out) * sp,
      },
      life: 0.3 + Math.random() * 0.9,
      max: 1.2,
      size: 0.4 + Math.random() * 1.4,
      bright: 0.5 + Math.random() * 0.6,
    });

  }

  /* ---------------- rendering ---------------- */

  private project(p: V3) {
    // global view rotation from drag interaction (trig cached per frame)
    const x1 = p.x * this.cRY + p.z * this.sRY;
    const z1 = -p.x * this.sRY + p.z * this.cRY;
    const y1 = p.y * this.cRX - z1 * this.sRX;
    const z2 = p.y * this.sRX + z1 * this.cRX;
    // gentle perspective; camera on +z
    const persp = 6;
    const zz = z2 + persp;
    const f = Math.min(1.3, persp / Math.max(2.2, zz)) * this.zoom;
    // subtle per-depth parallax toward the pointer
    const par = this.pActive * 0.018 * z2;
    return { sx: x1 * f + this.pxn * par, sy: y1 * f + this.pyn * par, depth: f, z: z2 };
  }


  private pulseBoost(r: number) {
    let b = 0;
    for (const p of this.pulses) {
      const d = Math.abs(r - p.r);
      if (d < 0.42) b += p.strength * (1 - d / 0.42) * 1.5;
    }
    return b;
  }

  private draw() {
    const ctx = this.ctx;
    const t = this.t;
    const c = this.cur;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, this.W, this.H);

    const cx = this.W * 0.5 + this.offsetX;
    const cy = this.H * 0.5;
    const R = this.R;
    const breathe = 1 + Math.sin(t * 0.6) * 0.012 + this.burstEnergy * 0.02;
    const energy = c.coreGlow + this.burstEnergy * 0.5;

    ctx.translate(cx, cy);
    ctx.globalCompositeOperation = "lighter";

    /* --- long-range ambient haze: very wide, very low alpha --- */
    const zR = R * this.zoom;
    const far = ctx.createRadialGradient(0, 0, zR * 0.3, 0, 0, zR * 3.6);
    far.addColorStop(0, `rgba(255,170,70,${0.05 * energy})`);
    far.addColorStop(0.16, `rgba(210,105,26,${0.034 * energy})`);
    far.addColorStop(0.34, `rgba(150,62,12,${0.021 * energy})`);
    far.addColorStop(0.54, `rgba(96,36,6,${0.012 * energy})`);
    far.addColorStop(0.74, `rgba(52,17,3,${0.006 * energy})`);
    far.addColorStop(0.88, `rgba(24,8,1,${0.002 * energy})`);
    far.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = far;
    ctx.beginPath();
    ctx.arc(0, 0, zR * 3.6, 0, 6.283);
    ctx.fill();

    /* --- near-field halo (smooth gradient from center to edge) --- */
    const halo = ctx.createRadialGradient(0, 0, zR * 0.02, 0, 0, zR * 2.6);
    halo.addColorStop(0, `rgba(255,210,140,${0.18 * energy})`);
    halo.addColorStop(0.08, `rgba(255,180,80,${0.13 * energy})`);
    halo.addColorStop(0.2, `rgba(230,120,30,${0.08 * energy})`);
    halo.addColorStop(0.38, `rgba(160,65,12,${0.045 * energy})`);
    halo.addColorStop(0.65, `rgba(90,32,4,${0.022 * energy})`);
    halo.addColorStop(0.85, `rgba(40,12,2,${0.008 * energy})`);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, zR * 2.6, 0, 6.283);
    ctx.fill();

    /* --- distant + outer particles first, then rings/filaments, then nucleus --- */
    this.drawParticles(R * breathe, t, c, energy, 4);
    this.drawParticles(R * breathe, t, c, energy, 3);
    this.drawFilaments(R * breathe, t, c, energy, false);
    this.drawRings(R * breathe, t, c, energy, false);
    this.drawParticles(R * breathe, t, c, energy, 2);
    this.drawParticles(R * breathe, t, c, energy, 1);

    /* --- nucleus occlusion: eclipse structures passing behind the core --- */
    const occR = zR * 0.34 * (1 + Math.sin(t * 0.8) * 0.03);
    const occ = ctx.createRadialGradient(0, 0, 0, 0, 0, occR);
    occ.addColorStop(0, "rgba(0,0,0,0.55)");
    occ.addColorStop(0.6, "rgba(0,0,0,0.3)");
    occ.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = occ;
    ctx.beginPath();
    ctx.arc(0, 0, occR, 0, 6.283);
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";

    this.drawNucleus(R * breathe, t, energy);
    this.drawParticles(R * breathe, t, c, energy, 0);
    this.drawRings(R * breathe, t, c, energy, true);
    this.drawFilaments(R * breathe, t, c, energy, true);
    this.drawSparks(R * breathe, energy);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawParticles(R: number, t: number, c: StateProfile, energy: number, layer: number) {
    const ctx = this.ctx;
    const skip = this.densityScale < 1 ? Math.round(1 / this.densityScale) : 1;
    let i = -1;
    for (const q of this.particles) {
      i++;
      if (q.layer !== layer) continue;
      if (skip > 1 && i % skip !== 0 && layer > 1) continue;

      const spin = q.spin * (0.35 + c.activity);
      // inflow: listening pulls outer material toward the nucleus
      const draw = c.inflow * 0.14 * Math.max(0, q.layer - 0.5) * (0.6 + 0.4 * Math.sin(t * 0.9 + q.phase));
      const wob = Math.sin(t * q.wob + q.phase) * 0.012 * (1 + q.layer * 0.6);
      const scale = 1 - draw + wob;
      const p = rot(
        { x: q.p.x * scale, y: q.p.y * scale, z: q.p.z * scale },
        Math.sin(t * spin * 0.4 + q.phase) * 0.06,
        t * spin * 0.35,
        0,
      );
      const pr = this.project(p);
      const rr = Math.hypot(q.p.x, q.p.y, q.p.z);
      const boost = this.pulseBoost(rr);

      const flick = 0.72 + 0.28 * Math.sin(t * (1.1 + q.wob * 1.8) + q.phase * 3);
      const dep = pr.depth / this.zoom;
      let a = q.bright * flick * (0.28 + dep * 0.75) * (0.55 + energy * 0.5) * c.density;
      a *= 1 + boost * 0.9;
      a *= layer === 0 ? 1 : layer >= 3 ? 0.26 : 1.05;
      // stronger volumetric depth: the back hemisphere sinks away behind the nucleus
      a *= (0.55 + 0.5 * (pr.z * 0.5 + 0.5)) * 1.12;
      // crust emphasis: material near the shell radius defines the silhouette,
      // with limb brightening so the circumference reads as a hard edge
      if (rr > 0.84 && rr < 1.14) {
        const limb = 1 - Math.min(1, Math.abs(pr.z) / Math.max(0.001, rr));
        a *= 1.5 + 1.6 * Math.pow(limb, 1.5);
      }
      if (a < 0.012) continue;
      let heat = Math.max(0, 1 - rr * 0.62) * 0.75 + boost * 0.3 + (layer === 0 ? 0.3 : 0);
      // cursor proximity: fragments near the pointer flare slightly
      if (this.pActive > 0.01) {
        const d = Math.hypot(pr.sx * R - this.mx, pr.sy * R - this.my);
        const prox = Math.max(0, 1 - d / (R * 0.28)) * this.pActive;
        if (prox > 0) {
          a *= 1 + prox * 1.1;
          heat += prox * 0.35;
        }
      }


      const x = pr.sx * R;
      const y = pr.sy * R;
      const s = q.size * pr.depth * (this.W < 760 ? 0.8 : 1);
      ctx.fillStyle = amber(heat, Math.min(1, a));
      ctx.strokeStyle = ctx.fillStyle;

      if (q.kind === 0) {
        ctx.fillRect(x - s * 0.5, y - s * 0.5, s, s);
      } else if (q.kind === 1) {
        const ang = q.ang + t * spin * 0.6;
        const l = s * 2;
        ctx.lineWidth = Math.max(0.4, s * 0.55);
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(ang) * l * 0.5, y - Math.sin(ang) * l * 0.5);
        ctx.lineTo(x + Math.cos(ang) * l * 0.5, y + Math.sin(ang) * l * 0.5);
        ctx.stroke();
      } else if (q.kind === 2) {
        const ang = Math.atan2(y, x) + Math.PI / 2;
        const l = s * (1.1 + 1.1 * flick);
        ctx.lineWidth = Math.max(0.3, s * 0.4);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * l, y + Math.sin(ang) * l);
        ctx.stroke();
      } else {
        // circuitry chip: tiny right-angle trace
        const g = 0.4 + c.geometry;
        const l = s * 2.6 * g;
        ctx.lineWidth = Math.max(0.35, s * 0.45);
        ctx.beginPath();
        ctx.moveTo(x - l, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y - l * 0.8);
        ctx.stroke();
      }
    }
  }

  private drawRings(R: number, t: number, c: StateProfile, energy: number, front: boolean) {
    const ctx = this.ctx;
    for (const sg of this.segs) {
      const rot0 = t * sg.spin * (0.4 + c.activity * 0.9);
      const steps = Math.max(3, Math.ceil((sg.a1 - sg.a0) * 26));
      // compute midpoint depth to decide front/back
      const mid = (sg.a0 + sg.a1) * 0.5 + rot0;
      const mp = rot({ x: Math.cos(mid) * sg.r, y: 0, z: Math.sin(mid) * sg.r }, sg.tilt.x, sg.tilt.y, sg.tilt.z);
      const mz = this.project(mp).z;
      if (front !== mz > 0) continue;

      const boost = this.pulseBoost(sg.r);
      const flare = 0.55 + 0.45 * Math.sin(t * (0.4 + sg.flare) + sg.jitter);
      let a = sg.bright * flare * (0.35 + energy * 0.45) * (mz > 0 ? 1 : 0.55);
      a *= (1 + boost * 1.3 + this.burstEnergy * 0.4) * 1.5;
      if (a < 0.015) continue;

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const ang = sg.a0 + ((sg.a1 - sg.a0) * i) / steps + rot0;
        const wob = 1 + Math.sin(ang * 7 + sg.jitter + t * 0.3) * 0.018;
        const p = rot(
          { x: Math.cos(ang) * sg.r * wob, y: Math.sin(ang * 3 + sg.jitter) * 0.012, z: Math.sin(ang) * sg.r * wob },
          sg.tilt.x,
          sg.tilt.y,
          sg.tilt.z,
        );
        const pr = this.project(p);
        const x = pr.sx * R;
        const y = pr.sy * R;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const heat = Math.min(sg.r > 1 ? 0.72 : 0.92, 0.26 + boost * 0.45 + flare * 0.22);
      ctx.strokeStyle = amber(heat, Math.min(1, a));
      ctx.lineWidth = Math.max(0.5, sg.w * (mz > 0 ? 1.15 : 0.75)) * (this.W < 760 ? 0.75 : 1);
      ctx.stroke();
    }
  }

  private drawFilaments(R: number, t: number, c: StateProfile, energy: number, front: boolean) {
    const ctx = this.ctx;
    for (const f of this.fils) {
      const cycle = (t * (0.18 + c.activity * 0.25) + f.life) % 1;
      const env = Math.sin(Math.PI * Math.min(1, cycle / 0.85));
      if (env <= 0.02) continue;
      const ay = t * f.spin * (0.4 + c.activity);
      const head = f.pts[0];
      if (!head) continue;
      const first = this.project(rot(head, f.tilt.x, f.tilt.y + ay, 0));
      if (front !== first.z > -0.05) continue;

      const boost = this.pulseBoost(f.reach * 0.6);
      let a = f.bright * env * c.filament * (0.3 + energy * 0.5) * (1 + boost * 1.4 + this.burstEnergy * 0.5);
      a *= front ? 1 : 0.42;
      if (a < 0.015) continue;

      ctx.beginPath();
      let started = false;
      for (let i = 0; i < f.pts.length; i++) {
        const node = f.pts[i];
        if (!node) continue;
        const p = rot(node, f.tilt.x, f.tilt.y + ay, 0);
        const pr = this.project(p);
        const x = pr.sx * R;
        const y = pr.sy * R;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = amber(0.35 + boost * 0.4 + env * 0.25, Math.min(1, a));
      ctx.lineWidth = f.w * (front ? 1 : 0.7);
      ctx.stroke();

      // travelling data packet along the filament
      const idx = Math.min(f.pts.length - 1, Math.floor(cycle * f.pts.length));
      const pp = rot(f.pts[idx] ?? head, f.tilt.x, f.tilt.y + ay, 0);
      const ppr = this.project(pp);
      const s = 1.2 * ppr.depth * (0.6 + env);
      ctx.fillStyle = amber(0.9, Math.min(1, a * 1.6));
      ctx.fillRect(ppr.sx * R - s * 0.5, ppr.sy * R - s * 0.5, s, s);
    }
  }

  private drawNucleus(R: number, t: number, energy: number) {
    const ctx = this.ctx;
    const pump =
      (1 + Math.sin(t * 1.7) * 0.05 + Math.sin(t * 4.3) * 0.02 + this.burstEnergy * 0.12) *
      (1 + Math.sin(t * 0.45) * 0.045) *
      this.zoom;

    // larger, more volumetric central orb with a smoother radial gradient
    const g1 = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.58 * pump);
    g1.addColorStop(0, `rgba(255,248,230,${Math.min(0.95, 0.55 * energy)})`);
    g1.addColorStop(0.1, `rgba(255,220,130,${0.42 * energy})`);
    g1.addColorStop(0.22, `rgba(255,190,80,${0.28 * energy})`);
    g1.addColorStop(0.38, `rgba(238,140,35,${0.14 * energy})`);
    g1.addColorStop(0.58, `rgba(160,65,12,${0.05 * energy})`);
    g1.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g1;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.58 * pump, 0, 6.283);
    ctx.fill();

    // hot inner filigree — a few rapidly reorganising fragments
    const n = 58;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 * 3 + t * (0.5 + (i % 5) * 0.25);
      const rr = R * (0.04 + ((i * 37) % 100) / 100 * 0.22) * pump;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a * 1.3 + i) * rr * 0.8;
      const s = 1 + ((i * 13) % 7) * 0.55;
      ctx.fillStyle = amber(1, Math.min(1, 0.52 * energy));
      ctx.fillRect(x - s * 0.5, y - s * 0.5, s, s);
    }
    ctx.strokeStyle = amber(1, Math.min(0.9, 0.35 * energy));
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 12; i++) {
      const a = t * (0.3 + i * 0.07) + i * 1.7;
      const rr = R * (0.06 + i * 0.018) * pump;
      ctx.beginPath();
      ctx.arc(0, 0, rr, a, a + 0.6 + (i % 3) * 0.5);
      ctx.stroke();
    }
  }

  private drawSparks(R: number, energy: number) {
    const ctx = this.ctx;
    for (const s of this.sparks) {
      const life = Math.max(0, s.life / s.max);
      const pr = this.project(s.p);
      const x = pr.sx * R;
      const y = pr.sy * R;
      const a = Math.min(1, s.bright * life * (0.4 + energy * 0.5));
      if (a < 0.02) continue;
      const len = Math.min(14, Math.hypot(s.v.x, s.v.y) * 26 * pr.depth);
      ctx.strokeStyle = amber(0.95, a);
      ctx.lineWidth = Math.max(0.4, s.size * 0.4 * pr.depth);
      const dx = s.v.x, dy = s.v.y;
      const l = Math.hypot(dx, dy) || 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - (dx / l) * len, y - (dy / l) * len);
      ctx.stroke();
    }
  }
}
