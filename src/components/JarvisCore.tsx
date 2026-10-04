import { useEffect, useRef } from "react";
import { JarvisCoreEngine, type JarvisState } from "@/lib/jarvis-core";

export function JarvisCore({ state, offsetX = 0 }: { state: JarvisState; offsetX?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useRef<JarvisCoreEngine | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const e = new JarvisCoreEngine(canvas);
    engine.current = e;
    e.start();
    const onResize = () => e.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      e.stop();
      engine.current = null;
    };
  }, []);

  useEffect(() => {
    engine.current?.setState(state);
  }, [state]);

  useEffect(() => {
    engine.current?.setOffsetX(offsetX);
  }, [offsetX]);

  return (
    <canvas
      ref={ref}
      className="absolute inset-0 h-full w-full cursor-grab touch-none active:cursor-grabbing"
      aria-hidden="true"
    />
  );

}
