"use client";

import { useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/cn";
import type { OrbState } from "@/lib/types";

interface VoiceOrbProps {
  state: OrbState;
  label?: string;
  onClick?: () => void;
}

const stateLabels: Record<OrbState, string> = {
  idle: "Tap to speak",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

// ── Sphere geometry ──────────────────────────────────────
// Fibonacci sphere gives evenly-spaced points on a unit sphere.
function buildSphereNodes(count: number) {
  const nodes: { phi: number; theta: number }[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2; // –1 → 1
    const radiusAtY = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    const phi = Math.acos(y);
    nodes.push({ phi, theta: theta + radiusAtY * 0 }); // store spherical coords
  }
  return nodes;
}

interface Projected {
  x: number;
  y: number;
  z: number; // depth for opacity / sizing
}

function projectNodes(
  nodes: { phi: number; theta: number }[],
  rotY: number,
  rotX: number,
  radius: number,
  cx: number,
  cy: number
): Projected[] {
  return nodes.map(({ phi, theta }) => {
    // Spherical → Cartesian
    let x = Math.sin(phi) * Math.cos(theta);
    let y = Math.cos(phi);
    let z = Math.sin(phi) * Math.sin(theta);

    // Rotate around Y axis
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);
    const x2 = x * cosY - z * sinY;
    const z2 = x * sinY + z * cosY;
    x = x2;
    z = z2;

    // Rotate around X axis
    const cosX = Math.cos(rotX);
    const sinX = Math.sin(rotX);
    const y2 = y * cosX - z * sinX;
    const z3 = y * sinX + z * cosX;
    y = y2;
    z = z3;

    return {
      x: cx + x * radius,
      y: cy + y * radius,
      z,
    };
  });
}

// ── State-driven parameters ──────────────────────────────
interface StateParams {
  rotSpeedY: number;
  rotSpeedX: number;
  nodeColor: [number, number, number]; // RGB
  edgeColor: [number, number, number];
  glowColor: string;
  connectionThreshold: number; // max 3D distance to draw edge
  pulseSpeed: number;
  pulseAmplitude: number;
  nodeBaseAlpha: number;
  edgeBaseAlpha: number;
}

const STATE_PARAMS: Record<OrbState, StateParams> = {
  idle: {
    rotSpeedY: 0.0008,
    rotSpeedX: 0.0003,
    nodeColor: [34, 211, 238],   // cyan
    edgeColor: [34, 211, 238],
    glowColor: "rgba(34,211,238,0.06)",
    connectionThreshold: 0.85,
    pulseSpeed: 0.0015,
    pulseAmplitude: 0.15,
    nodeBaseAlpha: 0.5,
    edgeBaseAlpha: 0.12,
  },
  listening: {
    rotSpeedY: 0.002,
    rotSpeedX: 0.001,
    nodeColor: [34, 211, 238],
    edgeColor: [56, 189, 248],
    glowColor: "rgba(34,211,238,0.12)",
    connectionThreshold: 1.0,
    pulseSpeed: 0.004,
    pulseAmplitude: 0.3,
    nodeBaseAlpha: 0.75,
    edgeBaseAlpha: 0.2,
  },
  thinking: {
    rotSpeedY: 0.004,
    rotSpeedX: 0.002,
    nodeColor: [129, 140, 248],  // indigo
    edgeColor: [99, 102, 241],
    glowColor: "rgba(129,140,248,0.1)",
    connectionThreshold: 1.1,
    pulseSpeed: 0.006,
    pulseAmplitude: 0.35,
    nodeBaseAlpha: 0.8,
    edgeBaseAlpha: 0.25,
  },
  speaking: {
    rotSpeedY: 0.003,
    rotSpeedX: 0.0015,
    nodeColor: [167, 139, 250],  // violet
    edgeColor: [34, 211, 238],
    glowColor: "rgba(167,139,250,0.1)",
    connectionThreshold: 1.05,
    pulseSpeed: 0.005,
    pulseAmplitude: 0.4,
    nodeBaseAlpha: 0.85,
    edgeBaseAlpha: 0.22,
  },
};

const NODE_COUNT = 90;
const SPHERE_NODES = buildSphereNodes(NODE_COUNT);

// Pre-compute edge pairs (indices where 3D distance < max threshold across all states)
const MAX_THRESHOLD = 1.2;
const EDGE_PAIRS: [number, number][] = [];
{
  // Use unit-sphere positions (before projection) to find neighbours
  const cart = SPHERE_NODES.map(({ phi, theta }) => ({
    x: Math.sin(phi) * Math.cos(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(theta),
  }));
  for (let i = 0; i < cart.length; i++) {
    for (let j = i + 1; j < cart.length; j++) {
      const dx = cart[i].x - cart[j].x;
      const dy = cart[i].y - cart[j].y;
      const dz = cart[i].z - cart[j].z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) < MAX_THRESHOLD) {
        EDGE_PAIRS.push([i, j]);
      }
    }
  }
}

export function VoiceOrb({
  state,
  label,
  onClick,
}: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Smoothly interpolated params for transitions
  const liveParams = useRef<StateParams>({ ...STATE_PARAMS[state] });

  const displayLabel = label ?? stateLabels[state];

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    }

    const target = STATE_PARAMS[stateRef.current];
    const live = liveParams.current;
    const lerp = 0.04; // smooth transition speed

    // Lerp all params toward target
    live.rotSpeedY += (target.rotSpeedY - live.rotSpeedY) * lerp;
    live.rotSpeedX += (target.rotSpeedX - live.rotSpeedX) * lerp;
    live.connectionThreshold += (target.connectionThreshold - live.connectionThreshold) * lerp;
    live.pulseSpeed += (target.pulseSpeed - live.pulseSpeed) * lerp;
    live.pulseAmplitude += (target.pulseAmplitude - live.pulseAmplitude) * lerp;
    live.nodeBaseAlpha += (target.nodeBaseAlpha - live.nodeBaseAlpha) * lerp;
    live.edgeBaseAlpha += (target.edgeBaseAlpha - live.edgeBaseAlpha) * lerp;
    for (let c = 0; c < 3; c++) {
      live.nodeColor[c] += (target.nodeColor[c] - live.nodeColor[c]) * lerp;
      live.edgeColor[c] += (target.edgeColor[c] - live.edgeColor[c]) * lerp;
    }
    live.glowColor = target.glowColor; // snap

    const now = performance.now();
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.36;

    const rotY = now * live.rotSpeedY;
    const rotX = now * live.rotSpeedX;
    const pulse = Math.sin(now * live.pulseSpeed) * live.pulseAmplitude;

    const projected = projectNodes(SPHERE_NODES, rotY, rotX, radius, cx, cy);

    ctx.clearRect(0, 0, w, h);

    // Background glow
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.6);
    grad.addColorStop(0, live.glowColor);
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Draw edges
    const [er, eg, eb] = live.edgeColor;
    for (const [i, j] of EDGE_PAIRS) {
      const a = projected[i];
      const b = projected[j];
      // 3D distance on unit sphere (use z for depth fade)
      const depthAlpha = ((a.z + 1) / 2) * ((b.z + 1) / 2); // 0→1
      const unitDist = Math.sqrt(
        (SPHERE_NODES[i].phi - SPHERE_NODES[j].phi) ** 2 +
        (SPHERE_NODES[i].theta - SPHERE_NODES[j].theta) ** 2
      );
      if (unitDist > live.connectionThreshold * 3) continue;

      const alpha = (live.edgeBaseAlpha + pulse * 0.05) * depthAlpha;
      if (alpha < 0.01) continue;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(${er | 0},${eg | 0},${eb | 0},${alpha.toFixed(3)})`;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Draw nodes
    const [nr, ng, nb] = live.nodeColor;
    for (let i = 0; i < projected.length; i++) {
      const p = projected[i];
      const depth = (p.z + 1) / 2; // 0 (back) → 1 (front)
      const alpha = (live.nodeBaseAlpha + pulse * 0.1) * (0.2 + depth * 0.8);
      const r = 1.2 + depth * 1.8 + pulse * 0.5;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${nr | 0},${ng | 0},${nb | 0},${alpha.toFixed(3)})`;
      ctx.fill();

      // Front nodes get a tiny glow
      if (depth > 0.7) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${nr | 0},${ng | 0},${nb | 0},${(alpha * 0.15).toFixed(3)})`;
        ctx.fill();
      }
    }

    rafRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex w-full max-w-[420px] flex-col items-center gap-5 focus:outline-none"
      aria-label={displayLabel}
    >
      {/* Outer glow ring — CSS, always present */}
      <div
        className={cn(
          "absolute inset-0 rounded-full transition-all duration-700 pointer-events-none",
          state === "idle" && "shadow-[0_0_60px_var(--glow-cyan),0_0_120px_rgba(34,211,238,0.04)]",
          state === "listening" && "shadow-[0_0_80px_var(--glow-cyan-strong),0_0_160px_var(--glow-cyan)]",
          state === "thinking" && "shadow-[0_0_80px_var(--glow-indigo-strong),0_0_160px_var(--glow-indigo)]",
          state === "speaking" && "shadow-[0_0_90px_var(--glow-indigo-strong),0_0_180px_var(--glow-cyan)]",
        )}
      />

      <canvas
        ref={canvasRef}
        className="aspect-square w-full cursor-pointer rounded-full"
      />

      {/* Label */}
      <span
        className={cn(
          "text-sm font-medium tracking-widest uppercase transition-colors duration-500",
          state === "idle" && "text-text-secondary",
          state === "listening" && "text-accent-cyan",
          state === "thinking" && "text-accent-indigo",
          state === "speaking" && "text-purple-400",
        )}
      >
        {displayLabel}
      </span>
    </button>
  );
}
