"use client";

import { useRef, useEffect, useCallback } from "react";

// ── Star types ───────────────────────────────────────────
interface Star {
  x: number;
  y: number;
  z: number; // depth 0→1 (used for parallax + brightness)
  size: number;
  baseAlpha: number;
  twinkleSpeed: number;
  twinkleOffset: number;
}

interface Nebula {
  x: number;
  y: number;
  radius: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  driftX: number;
  driftY: number;
}

const STAR_COUNT = 320;
const NEBULA_COUNT = 5;

function createStars(w: number, h: number): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const z = Math.random();
    stars.push({
      x: Math.random() * w,
      y: Math.random() * h,
      z,
      size: 0.3 + z * 1.5,
      baseAlpha: 0.15 + z * 0.7,
      twinkleSpeed: 0.0008 + Math.random() * 0.003,
      twinkleOffset: Math.random() * Math.PI * 2,
    });
  }
  return stars;
}

function createNebulae(w: number, h: number): Nebula[] {
  const palette: [number, number, number][] = [
    [34, 211, 238],   // cyan
    [129, 140, 248],  // indigo
    [99, 102, 241],   // deeper indigo
    [14, 116, 144],   // dark cyan
    [67, 56, 202],    // violet-indigo
  ];
  return Array.from({ length: NEBULA_COUNT }, (_, i) => {
    const [r, g, b] = palette[i % palette.length];
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      radius: 150 + Math.random() * 350,
      r,
      g,
      b,
      alpha: 0.012 + Math.random() * 0.025,
      driftX: (Math.random() - 0.5) * 0.08,
      driftY: (Math.random() - 0.5) * 0.06,
    };
  });
}

export function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const starsRef = useRef<Star[]>([]);
  const nebulaeRef = useRef<Nebula[]>([]);
  const sizeRef = useRef({ w: 0, h: 0 });

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    sizeRef.current = { w, h };
    starsRef.current = createStars(w, h);
    nebulaeRef.current = createNebulae(w, h);
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { w, h } = sizeRef.current;
    const dpr = window.devicePixelRatio || 1;

    // Handle resize
    if (canvas.clientWidth !== w || canvas.clientHeight !== h) {
      init();
      ctx.scale(dpr, dpr);
    }

    const now = performance.now();

    ctx.clearRect(0, 0, w, h);

    // ── Nebulae (soft glowing clouds) ─────────────────────
    for (const n of nebulaeRef.current) {
      // Gentle drift
      n.x += n.driftX;
      n.y += n.driftY;
      // Wrap
      if (n.x < -n.radius) n.x = w + n.radius;
      if (n.x > w + n.radius) n.x = -n.radius;
      if (n.y < -n.radius) n.y = h + n.radius;
      if (n.y > h + n.radius) n.y = -n.radius;

      const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.radius);
      grad.addColorStop(0, `rgba(${n.r},${n.g},${n.b},${n.alpha})`);
      grad.addColorStop(0.5, `rgba(${n.r},${n.g},${n.b},${n.alpha * 0.4})`);
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(n.x - n.radius, n.y - n.radius, n.radius * 2, n.radius * 2);
    }

    // ── Stars ─────────────────────────────────────────────
    for (const s of starsRef.current) {
      const twinkle =
        Math.sin(now * s.twinkleSpeed + s.twinkleOffset) * 0.5 + 0.5;
      const alpha = s.baseAlpha * (0.4 + twinkle * 0.6);

      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(210,225,245,${alpha.toFixed(3)})`;
      ctx.fill();

      // Bright stars get a soft halo
      if (s.z > 0.75) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(210,225,245,${(alpha * 0.08).toFixed(3)})`;
        ctx.fill();
      }
    }

    rafRef.current = requestAnimationFrame(draw);
  }, [init]);

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    init();
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.scale(dpr, dpr);
    }
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [init, draw]);

  // Resize handler
  useEffect(() => {
    const onResize = () => init();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [init]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 h-full w-full"
      aria-hidden="true"
    />
  );
}
