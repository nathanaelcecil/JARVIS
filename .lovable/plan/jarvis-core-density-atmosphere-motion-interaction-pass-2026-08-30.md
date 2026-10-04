# JARVIS Core — Density, Atmosphere, Motion & Interaction Pass

Push the central computational core further across all four axes the user selected, while keeping the existing UI, palette, black background, and overall cinematic feel untouched.

## 1. Visual density & structure

- **Engineered lattice**: add a second, more regular set of great-circle arcs (low opacity, thin) that interweave with the chaotic broken rings. These read as underlying orbital scaffolding and only appear strongly in `system` / `thinking` states via the `geometry` profile.
- **Data-shard chips**: increase the proportion of right-angle "circuitry" fragments (kind 3) in the shell, especially when `geometry` is high. Keep them tiny so they add texture, not clutter.
- **Corona streamers**: thin radial traces that extend 1.05–1.25R beyond the shell, flickering and dying quickly, to break the silhouette edge and make the sphere feel like it is venting energy.
- **Adaptive density**: scale arc/particle counts with `densityScale` so desktop builds a denser shell while mobile stays performant.
- **Animated asymmetry**: slowly drift the lobe/void weight field over time so dense clusters and gaps reorganize across the sphere across the animation.

## 2. Richer motion & energy events

- **State-change surge**: on every `setState` transition, fire a fast radial energy ring and a spark cascade from the nucleus so the core visibly reacts to mode changes.
- **Visible pulse front**: when the periodic nucleus pulse expands, draw a faint additive ring at the wavefront and briefly brighten shell fragments, arcs and filaments that sit near the current pulse radius.
- **Local flares**: random segments/particles briefly ignite (brightness spike + slight scale pulse) and fade, independent of the global pulse.
- **Spark branching**: during `burst` and on state surges, emit short-lived branching sparks that travel tangentially before fading.
- **Turbulent shell drift**: apply a slow, noise-like displacement to outer-shell particles so the surface feels liquid/molten rather than frozen.

## 3. Atmosphere, glow & color

- **Chromatic depth**: tint front-facing fragments toward white-hot gold and back-facing fragments toward deep copper/red based on projected `z`, increasing the 3D volume read.
- **Per-fragment bloom**: bright fragments (nucleus, hot arcs, flares) are drawn twice — a small bright core plus a larger, very faint halo — to simulate local additive bloom without a per-particle gradient cost.
- **State tint**: apply a subtle global color bias tied to the active state (e.g. `burst` leans whiter/gold, `system` leans copper, `idle` deeper amber). The amber/gold palette remains dominant.
- **Volumetric dust**: a sparse field of very faint, slow-moving particles in the far glow (radius 1.5–3R) that catch the light and give the surrounding space volume.
- **Glow refinement**: keep the existing wide radial gradients, but tie their intensity and reach more tightly to `coreGlow` and `burstEnergy` so states feel more distinct.

## 4. Interaction polish

- **Better inertia**: when released, rotation coasts with stronger initial momentum and a smooth exponential decay. Auto-rotation gently resumes after a short idle period.
- **Magnetic cursor**: fragments near the pointer are subtly pulled toward it (a few pixels) and flare, making the core feel responsive to touch.
- **Double-tap/click reset**: a quick double-click/tap on the canvas resets rotation and zoom to default.
- **Zoom feel**: keep the existing magnitude-based exponential zoom, but add a tiny "settle" overshoot on state-driven zoom impulses.
- **Touch**: ensure two-finger drag does not fight the page scroll; rely on the existing non-passive wheel listener for pinch and add a small touch-action guard.

## Technical notes

- Single file scope: `src/lib/jarvis-core.ts` only. Touch `src/components/JarvisCore.tsx` only if a new event (double-click) needs forwarding.
- Preserve Canvas2D + additive blending. Avoid per-particle gradients; use the existing batching and two-pass drawing tricks for bloom.
- Keep performance safe on mobile: new density is gated by `densityScale`, and new dust/far particles skip on small screens.
- Verify with `bunx tsc` and Playwright screenshots across idle, thinking, burst, mid-drag, and zoomed states.
