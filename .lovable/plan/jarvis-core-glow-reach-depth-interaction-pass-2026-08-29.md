# JARVIS Core — Glow Reach, Depth & Interaction Pass

Refine the existing core in `src/lib/jarvis-core.ts` only. UI, HUD, palette and state system stay untouched.

## 1. Long-range gradient glow

- Extend the ambient halo far beyond the shell: add a second, very wide outer glow gradient reaching ~2.2x the core radius, with many low-alpha stops (deep ember → black) so the light fades smoothly into the background instead of cutting off.
- Keep the existing near-field nucleus gradient; blend the two so brightness stays concentrated at the center while a faint amber haze visibly fills the frame around the core.
- Glow intensity stays tied to `coreGlow` per state (burst still flares farther, idle stays subtle).

## 2. More cinematic depth

- Stronger depth fade: scale particle/arc/filament brightness and alpha more aggressively by projected depth (z), so the back hemisphere clearly dims behind the nucleus and front fragments feel close.
- Slight nucleus occlusion: render a faint dark-core pass between back and front layers so structures passing behind the nucleus are partially eclipsed.
- Very subtle parallax tied to the pointer position (a few pixels of offset between layers).

## 3. Better motion & energy events

- Nucleus propagation: periodic soft pulses ignite a radial wave that briefly brightens shell particles, arcs and filaments at the wavefront, then fades — subtle in idle, stronger in burst/thinking.
- Nucleus breathing: slow sinusoidal scale/glow oscillation of the nucleus cluster.
- Local events: occasional small clusters flare and reorganize; sparks continue to ignite tangentially inside the mass.

## 4. Interaction: rotate & expand

- Drag to rotate: pointer drag applies torque to the whole structure (rings, filaments, particles share a global rotation bias) with inertia/damping; slowly returns to gentle auto-rotation when released.
- Wheel to expand/zoom: scroll scales the projected radius (clamped ~0.7x–1.6x) with magnitude-based easing (exp curve, deltaMode-normalized) so trackpad flicks don't slam the limits. Native non-passive wheel listener to avoid page scroll interference. Trackpad pinch (ctrl+wheel) handled by the same path.
- Cursor proximity: fragments near the pointer get a tiny brighten/deflection so the core feels responsive to touch.
- All interactions modify a shared transform state in the engine; no new HUD elements.

## Technical notes

- Single file changed: `src/lib/jarvis-core.ts` (plus a tiny `JarvisCore.tsx` touch only if needed to forward pointer events from the canvas).
- Canvas2D + additive blending preserved; watch fill-rate cost of the wider glow — use one large radial gradient per frame, not per-particle.
- Verify with typecheck + Playwright screenshots (idle/burst, mid-drag, zoomed in/out) and compare against the reference for silhouette readability.
