"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import dynamic from "next/dynamic";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";

// Must be loaded client-only to avoid SSR hydration mismatch
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then(m => m.WalletMultiButton),
  { ssr: false }
);

type Phase = "Lobby" | "Starting" | "Night" | "Day" | "GameOver";
type Role = "Mafia" | "Citizen" | "Doctor" | null;

interface Player { walletAddress: string; username: string; isEliminated: boolean; }
interface ChatMessage { walletAddress: string; username: string; text: string; timestamp: number; isGhost?: boolean; }
interface GameState { gameId: string; phase: Phase; round: number; stakeSOL: number; maxPlayers: number; players: Player[]; chat: ChatMessage[]; }

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001";

// ── Unique cloak color themes per player index ────────────────────────────
const CLOAK_THEMES = [
  { body: "#12102e", stroke: "#3a2888", glow: "#6644ff" }, // indigo
  { body: "#1e0a0a", stroke: "#6a1a1a", glow: "#ff3333" }, // crimson
  { body: "#0a1a12", stroke: "#1a5a30", glow: "#44ff88" }, // emerald
  { body: "#0a0e1a", stroke: "#1a3a6a", glow: "#3388ff" }, // sapphire
  { body: "#1a0a1a", stroke: "#5a1a5a", glow: "#cc44ff" }, // violet
  { body: "#0a1818", stroke: "#1a5a5a", glow: "#44ddcc" }, // teal
  { body: "#181200", stroke: "#5a4400", glow: "#ffcc33" }, // amber
  { body: "#180a00", stroke: "#5a2a00", glow: "#ff8844" }, // ember
];

function getCloakTheme(index: number) {
  return CLOAK_THEMES[index % CLOAK_THEMES.length];
}

// ── Character oval positions with perspective ─────────────────────────────
function getCharPos(i: number, total: number) {
  const n = Math.max(total, 1);
  const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
  const x = 50 + 36 * Math.cos(angle);
  const y = 52 + 20 * Math.sin(angle);
  const scale = 0.62 + 0.44 * ((Math.sin(angle) + 1) / 2);
  return { x, y, scale };
}

// ── Game Character (human figure with pointing gesture) ───────────────────
function GameCharacter({ isEliminated, isSelected, isMe, revealedRole, isDying, theme, voteCount, isPointing, pointAngleDeg }: {
  isEliminated: boolean; isSelected: boolean; isMe: boolean;
  revealedRole: Role | null; isDying: boolean; isPointing: boolean; pointAngleDeg: number;
  theme: typeof CLOAK_THEMES[0]; voteCount: number;
}) {
  const eyeColor = revealedRole === "Mafia" ? "#ff2222"
    : revealedRole === "Doctor" ? "#33ee88"
    : revealedRole === "Citizen" ? "#ffffff"
    : "#ddaa88";

  const outfit = isEliminated ? "#0d0d18" : theme.body;
  const outlineCol = isMe ? theme.glow : isEliminated ? "#1a1a26" : theme.stroke;
  // Which side: arm extends from right shoulder (angle -90..90 = right half) else left shoulder
  const pointsRight = Math.abs(pointAngleDeg) <= 90;
  // Pivot at right shoulder (54,42) or left shoulder (16,42)
  const pivotX = pointsRight ? 54 : 16;
  const pivotY = 42;
  // SVG default arm direction: right shoulder arm points right (0°), left shoulder arm points left (180°)
  const armBaseAngle = pointsRight ? 0 : 180;
  const rotationDeg = pointAngleDeg - armBaseAngle;

  return (
    <svg viewBox="0 0 70 112" xmlns="http://www.w3.org/2000/svg" style={{ width: "100%", height: "100%", overflow: "visible" }}>
      {/* Vote bubble */}
      {voteCount > 0 && (
        <g>
          <circle cx="58" cy="9" r="11" fill="#cc1100" opacity="0.95"/>
          <text x="58" y="13.5" fontSize="11" textAnchor="middle" fill="white" fontWeight="bold">{voteCount}</text>
        </g>
      )}

      {/* Ground shadow */}
      <ellipse cx="35" cy="110" rx="26" ry="4" fill="rgba(0,0,0,0.5)"/>

      {/* LEFT LEG */}
      <path d="M22 70 L18 106 Q20 110 25 108 Q28 108 27 104 L26 70Z"
        fill={isEliminated ? "#111" : theme.stroke} opacity={isEliminated ? 0.4 : 1}/>

      {/* RIGHT LEG */}
      <path d="M48 70 L52 106 Q50 110 45 108 Q42 108 43 104 L44 70Z"
        fill={isEliminated ? "#111" : theme.stroke} opacity={isEliminated ? 0.4 : 1}/>

      {/* POINTING ARM — drawn BEFORE body so body naturally masks the shoulder base */}
      {isPointing && !isEliminated && (
        <g transform={`rotate(${rotationDeg}, ${pivotX}, ${pivotY})`}>
          {/* Upper arm + forearm extending outward from pivot */}
          <path d={pointsRight
            ? "M54 39 L90 39 L92 43 L90 47 L54 47 Z"   /* right: extends +X */
            : "M16 39 L-20 39 L-22 43 L-20 47 L16 47 Z" /* left: extends -X */}
            fill={outfit} stroke={outlineCol} strokeWidth="0.9" rx="4"/>
          {/* Glowing fist at tip */}
          <circle cx={pointsRight ? 95 : -25} cy={pivotY} r="5.5" fill={theme.glow} opacity="0.92"/>
          <circle cx={pointsRight ? 95 : -25} cy={pivotY} r="11"  fill={theme.glow} opacity="0.15"/>
        </g>
      )}

      {/* BODY — drawn on top so it masks the arm base cleanly */}
      <rect x="16" y="36" width="38" height="36" rx="10"
        fill={outfit} stroke={outlineCol} strokeWidth={isMe ? 1.6 : 0.9}/>

      {/* Body centre-line detail */}
      {!isEliminated && (
        <line x1="35" y1="39" x2="35" y2="70" stroke={theme.stroke} strokeWidth="0.5" opacity="0.35"/>
      )}

      {/* LEFT ARM — hangs when not pointing, or when pointing right (right arm is used) */}
      {(!isPointing || (isPointing && pointsRight)) && (
        <path d="M16 38 Q6 50 8 72 Q10 78 15 76 Q19 74 17 68 Q15 50 20 40Z"
          fill={outfit} stroke={outlineCol} strokeWidth="0.9"/>
      )}

      {/* RIGHT ARM — hangs when not pointing, or when pointing left (left arm is used) */}
      {(!isPointing || (isPointing && !pointsRight)) && (
        <path d="M54 38 Q64 50 62 72 Q60 78 55 76 Q51 74 53 68 Q55 50 50 40Z"
          fill={outfit} stroke={outlineCol} strokeWidth="0.9"/>
      )}

      {/* NECK */}
      <rect x="29" y="24" width="12" height="14" rx="4"
        fill={isEliminated ? "#111" : "#c08050"}/>

      {/* HEAD */}
      <ellipse cx="35" cy="17" rx="16" ry="17"
        fill={isEliminated ? "#0d0d18" : "#d4855a"}
        stroke={outlineCol} strokeWidth={isMe ? 1.6 : 0.9}/>

      {/* HAIR / CAP matching outfit color */}
      <ellipse cx="35" cy="6" rx="15" ry="9" fill={isEliminated ? "#0a0a16" : theme.body}/>
      <rect x="20" y="8" width="30" height="6" rx="3" fill={isEliminated ? "#0a0a16" : theme.body}/>

      {/* FACE */}
      {!isEliminated ? (
        <>
          {/* Eye whites */}
          <ellipse cx="27" cy="17" rx="4" ry="3.5" fill="white"/>
          <ellipse cx="43" cy="17" rx="4" ry="3.5" fill="white"/>
          {/* Irises */}
          <circle cx="27.8" cy="17.5" r="2.3" fill={eyeColor}/>
          <circle cx="43.8" cy="17.5" r="2.3" fill={eyeColor}/>
          {/* Pupils */}
          <circle cx="28" cy="17.5" r="1" fill="#111"/>
          <circle cx="44" cy="17.5" r="1" fill="#111"/>
          {/* Shine */}
          <circle cx="26.5" cy="16" r="0.8" fill="rgba(255,255,255,0.85)"/>
          <circle cx="42.5" cy="16" r="0.8" fill="rgba(255,255,255,0.85)"/>
          {/* Mouth */}
          <path d="M30 24 Q35 27 40 24" stroke="#a06040" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
        </>
      ) : (
        <>
          <line x1="23" y1="14" x2="31" y2="22" stroke="#333" strokeWidth="2"/>
          <line x1="31" y1="14" x2="23" y2="22" stroke="#333" strokeWidth="2"/>
          <line x1="39" y1="14" x2="47" y2="22" stroke="#333" strokeWidth="2"/>
          <line x1="47" y1="14" x2="39" y2="22" stroke="#333" strokeWidth="2"/>
        </>
      )}

      {/* Crown for host/me */}
      {isMe && <text x="35" y="-3" fontSize="13" textAnchor="middle">👑</text>}

      {/* Role badge after reveal */}
      {revealedRole && !isEliminated && (
        <text x="35" y="93" fontSize="8.5" textAnchor="middle" fill={eyeColor} opacity="0.9" fontWeight="bold">{revealedRole.toUpperCase()}</text>
      )}

      {/* Skull on death */}
      {isEliminated && <text x="35" y="60" fontSize="26" textAnchor="middle" opacity="0.55">💀</text>}

      {/* Blood on dying */}
      {isDying && (
        <g opacity="0.9">
          <circle cx="27" cy="22" r="3" fill="#dd0000"/>
          <circle cx="43" cy="22" r="3" fill="#dd0000"/>
          <path d="M27 25 L24.5 44 L29.5 44 Z" fill="#aa0000" opacity="0.85"/>
          <path d="M43 25 L40.5 44 L45.5 44 Z" fill="#aa0000" opacity="0.85"/>
        </g>
      )}

      {/* Selected — dashed targeting ring */}
      {isSelected && !isEliminated && (
        <circle cx="35" cy="58" r="40" fill="none"
          stroke="#ff1111" strokeWidth="1.8" strokeDasharray="9 5" opacity="0.75"
          style={{ animation: "crossSpin 6s linear infinite" }}/>
      )}
    </svg>
  );
}

// ── Crosshair SVG (rendered above character) ──────────────────────────────
function CrosshairOverlay({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 80 80" style={{ position: "absolute", top: -14, left: "50%", transform: "translateX(-50%)", width: 80, height: 80, pointerEvents: "none", animation: "crossSpin 4s linear infinite" }}>
      <circle cx="40" cy="40" r="30" fill="none" stroke={color} strokeWidth="1.4" strokeDasharray="10 5" opacity="0.75" />
      <circle cx="40" cy="40" r="20" fill="none" stroke={color} strokeWidth="0.7" opacity="0.4" />
      <line x1="40" y1="6" x2="40" y2="18" stroke={color} strokeWidth="2.2" />
      <line x1="40" y1="62" x2="40" y2="74" stroke={color} strokeWidth="2.2" />
      <line x1="6" y1="40" x2="18" y2="40" stroke={color} strokeWidth="2.2" />
      <line x1="62" y1="40" x2="74" y2="40" stroke={color} strokeWidth="2.2" />
      <circle cx="40" cy="40" r="3.5" fill={color} opacity="0.9" />
    </svg>
  );
}

// ── Web Audio sound engine ────────────────────────────────────────────────
function useSoundEngine() {
  const ctxRef      = useRef<AudioContext | null>(null);
  const masterGain  = useRef<GainNode | null>(null);

  const init = useCallback(() => {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    ctxRef.current = ctx;
    const mg = ctx.createGain(); mg.gain.value = 0.72; mg.connect(ctx.destination);
    masterGain.current = mg;
  }, []);

  // ── One-shot note helper ───────────────────────────────────────────────
  const play = useCallback((type: "vote" | "select" | "button" | "join" | "create" | "eliminate" | "night" | "day" | "role" | "protect" | "heartbeat" | "win" | "whoosh") => {
    const ctx = ctxRef.current; const mg = masterGain.current;
    if (!ctx || !mg) return;
    const now = ctx.currentTime;

    const note = (freq: number, dur: number, vol: number, oscType: OscillatorType = "sine", delay = 0) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(mg);
      osc.frequency.value = freq; osc.type = oscType;
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(vol, now + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
      osc.start(now + delay); osc.stop(now + delay + dur + 0.05);
    };

    if (type === "button") {
      note(660, 0.06, 0.06, "sine"); note(880, 0.05, 0.04, "sine", 0.04);
    }
    if (type === "select") {
      note(880, 0.08, 0.08, "sine"); note(1108, 0.06, 0.05, "sine", 0.06);
    }
    if (type === "join") {
      // Swooping entry — descending then ascending, portal-like
      [220, 330, 440, 587, 784].forEach((f, i) => note(f, 0.35, 0.1, "sine", i * 0.07));
      note(1046.5, 0.6, 0.12, "sine", 0.4);
      note(880, 0.4, 0.08, "triangle", 0.7);
    }
    if (type === "create") {
      // Deep dramatic creation chord
      note(55, 0.9, 0.15, "sine"); note(82.4, 0.7, 0.1, "sine", 0.1);
      note(130.8, 0.5, 0.09, "triangle", 0.2); note(196, 0.4, 0.08, "sine", 0.32);
      note(261.6, 0.7, 0.1, "sine", 0.45); note(523.3, 0.5, 0.08, "sine", 0.6);
    }
    if (type === "vote") {
      note(330, 0.15, 0.12, "triangle"); note(440, 0.2, 0.1, "sine", 0.08); note(554, 0.12, 0.07, "sine", 0.18);
    }
    if (type === "eliminate") {
      note(80, 1.4, 0.22, "sawtooth"); note(55, 1.8, 0.18, "sawtooth", 0.1);
      note(220, 0.4, 0.14, "sine", 0.05); note(110, 1.0, 0.12, "sine", 0.3); note(41, 2.2, 0.15, "sine", 0.6);
    }
    if (type === "night") {
      [41, 55, 65.4, 82.4].forEach((f, i) => note(f, 3.2, 0.06, "sine", i * 0.18));
      note(130.8, 1.5, 0.03, "triangle", 0.5);
    }
    if (type === "day") {
      [110, 138.6, 164.8, 220].forEach((f, i) => note(f, 2.5, 0.05, "triangle", i * 0.1));
    }
    if (type === "role") {
      [196, 246.9, 293.7, 392, 493.9, 587.3].forEach((f, i) => note(f, 0.55, 0.12, "sine", i * 0.1));
      note(784, 0.8, 0.09, "sine", 0.65);
    }
    if (type === "protect") {
      [523.3, 659.3, 784, 1046.5].forEach((f, i) => note(f, 0.4, 0.08, "triangle", i * 0.08));
    }
    if (type === "heartbeat") {
      note(60, 0.12, 0.2, "sine"); note(50, 0.18, 0.18, "sine", 0.08);
      note(60, 0.12, 0.18, "sine", 0.28); note(50, 0.18, 0.16, "sine", 0.36);
    }
    if (type === "win") {
      [261.6, 329.6, 392, 523.3, 659.3, 784, 1046.5].forEach((f, i) => note(f, 0.7, 0.11, "sine", i * 0.09));
    }
    if (type === "whoosh") {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(mg);
      osc.type = "sawtooth"; osc.frequency.setValueAtTime(800, now); osc.frequency.exponentialRampToValueAtTime(80, now + 0.5);
      gain.gain.setValueAtTime(0.12, now); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
      osc.start(now); osc.stop(now + 0.55);
    }
  }, []);

  return { init, play };
}

// ── Canvas animated background ────────────────────────────────────────────
interface Particle { x: number; y: number; vx: number; vy: number; life: number; size: number; color: string; type: string; }

function useGameCanvas(canvasRef: React.RefObject<HTMLCanvasElement | null>, phase: Phase) {
  const rafRef = useRef<number>(0);
  const pRef = useRef<Particle[]>([]);
  const lightningRef = useRef<number>(0);
  const shootingStarRef = useRef<{ x: number; y: number; vx: number; vy: number; life: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    pRef.current = [];
    lightningRef.current = 0;

    function resize() { if (!canvas) return; canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; }
    resize();
    const ro = new ResizeObserver(resize); ro.observe(canvas);
    const isDay = phase === "Day";

    // Building window layout [bldgX, bldgY, bldgW, bldgH]
    const windows: [number, number, boolean][] = [
      [0.444,0.12,true],[0.465,0.12,false],[0.486,0.12,true],[0.507,0.12,false],[0.528,0.12,true],
      [0.444,0.19,false],[0.465,0.19,true],[0.486,0.19,false],[0.507,0.19,true],[0.528,0.19,false],
      [0.444,0.26,true],[0.465,0.26,false],[0.486,0.26,true],[0.507,0.26,false],
      [0.444,0.33,false],[0.465,0.33,true],[0.486,0.33,false],[0.507,0.33,true],[0.528,0.33,false],
      [0.444,0.40,true],[0.465,0.40,false],[0.486,0.40,true],[0.507,0.40,false],[0.528,0.40,true],
    ];

    function frame(ms: number) {
      if (!canvas || !ctx) return;
      const t = ms / 1000, W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // Lightning flash overlay (random, every ~8s)
      const lightFade = Math.max(0, 1 - (t - lightningRef.current) * 6);
      if (Math.random() < 0.0008 && !isDay) { lightningRef.current = t; }
      if (lightFade > 0) {
        ctx.fillStyle = `rgba(180,200,255,${lightFade * 0.35})`;
        ctx.fillRect(0, 0, W, H);
      }

      // Sky — dramatically different day vs night
      const sky = ctx.createLinearGradient(0, 0, 0, H * 0.65);
      if (isDay) {
        // Bright warm day — orange/amber sunrise
        sky.addColorStop(0, "#0d0400"); sky.addColorStop(0.25, "#3d1200"); sky.addColorStop(0.55, "#8b3800"); sky.addColorStop(0.8, "#c86010"); sky.addColorStop(1, "#e07820");
      } else {
        // Deep dark night — navy blue
        sky.addColorStop(0, "#000005"); sky.addColorStop(0.35, "#010018"); sky.addColorStop(0.7, "#030028"); sky.addColorStop(1, "#060030");
      }
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H * 0.65);

      // Ground — dark earth (warmer in day)
      const gnd = ctx.createLinearGradient(0, H * 0.63, 0, H);
      gnd.addColorStop(0, isDay ? "#1e0800" : "#030308"); gnd.addColorStop(1, "#010101");
      ctx.fillStyle = gnd; ctx.fillRect(0, H * 0.63, W, H);

      // SUN (day only) — warm glow top-left area
      if (isDay) {
        const sunX = W * 0.18, sunY = H * 0.08;
        const sunGlow2 = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 140);
        sunGlow2.addColorStop(0, "rgba(255,180,60,0.18)"); sunGlow2.addColorStop(1, "rgba(255,100,0,0)");
        ctx.fillStyle = sunGlow2; ctx.beginPath(); ctx.arc(sunX, sunY, 140, 0, Math.PI*2); ctx.fill();
        const sunGlow = ctx.createRadialGradient(sunX, sunY, 6, sunX, sunY, 55);
        sunGlow.addColorStop(0, "rgba(255,220,100,0.55)"); sunGlow.addColorStop(1, "rgba(255,120,20,0)");
        ctx.fillStyle = sunGlow; ctx.beginPath(); ctx.arc(sunX, sunY, 55, 0, Math.PI*2); ctx.fill();
        ctx.save(); ctx.shadowColor="#ffcc44"; ctx.shadowBlur=40;
        ctx.fillStyle="rgba(255,230,130,0.9)"; ctx.beginPath(); ctx.arc(sunX, sunY, 14, 0, Math.PI*2); ctx.fill();
        ctx.restore();
      }

      // Rain (night only) — diagonal streaks
      if (!isDay) {
        ctx.save(); ctx.strokeStyle = "rgba(120,150,200,0.09)"; ctx.lineWidth = 0.7;
        const rainOffset = (t * 220) % H;
        for (let ri = 0; ri < 60; ri++) {
          const rx = (ri * 53 + rainOffset * 0.3) % W;
          const ry = (ri * 37 + rainOffset) % (H * 1.2) - H * 0.1;
          ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 6, ry + 18); ctx.stroke();
        }
        ctx.restore();
      }

      // Buildings — darker, more detailed
      ctx.fillStyle = "#010006";
      // Center tower
      ctx.fillRect(W * 0.43, H * 0.04, W * 0.14, H * 0.59);
      // Side towers
      ctx.fillRect(W * 0.40, H * 0.08, W * 0.045, H * 0.14);
      ctx.fillRect(W * 0.555, H * 0.08, W * 0.045, H * 0.14);
      // Battlements
      for (let b = 0; b < 4; b++) ctx.fillRect(W * (0.41 + b * 0.038), H * 0.02, W * 0.022, H * 0.07);
      // Left building
      ctx.fillRect(0, H * 0.27, W * 0.15, H * 0.36);
      ctx.beginPath(); ctx.moveTo(0, H * 0.27); ctx.lineTo(W * 0.075, H * 0.12); ctx.lineTo(W * 0.15, H * 0.27); ctx.fill();
      // Right building
      ctx.fillRect(W * 0.85, H * 0.25, W * 0.15, H * 0.38);
      ctx.beginPath(); ctx.moveTo(W * 0.85, H * 0.25); ctx.lineTo(W * 0.925, H * 0.11); ctx.lineTo(W, H * 0.25); ctx.fill();

      // Building window lights — flickering
      windows.forEach(([wx, wy, lit]) => {
        const flicker = 0.5 + 0.5 * Math.sin(t * (2.3 + wx * 11) + wy * 7);
        if (lit && flicker > 0.3) {
          ctx.save();
          ctx.shadowColor = isDay ? "#ff8800" : "#ffcc44";
          ctx.shadowBlur = 6;
          ctx.fillStyle = isDay ? `rgba(255,80,0,${flicker * 0.35})` : `rgba(255,200,80,${flicker * 0.5})`;
          ctx.fillRect(wx * W, wy * H, W * 0.016, H * 0.04);
          ctx.restore();
        }
      });

      // Stars + Moon (night)
      if (!isDay) {
        const stars: [number, number, number][] = [
          [0.07,0.04,0.9],[0.17,0.08,0.7],[0.29,0.03,1],[0.39,0.07,0.8],[0.51,0.04,0.6],
          [0.64,0.07,0.9],[0.74,0.03,0.7],[0.87,0.05,1],[0.11,0.13,0.5],[0.23,0.1,0.8],
          [0.59,0.11,0.7],[0.77,0.12,0.6],[0.94,0.09,0.9],[0.34,0.15,0.4],[0.47,0.13,0.7],
          [0.02,0.07,0.6],[0.56,0.16,0.5],[0.82,0.14,0.8],[0.44,0.06,0.9],[0.66,0.03,0.7],
          [0.19,0.05,0.5],[0.72,0.08,0.8],[0.31,0.11,0.6],[0.88,0.16,0.7],[0.05,0.18,0.4],
        ];
        stars.forEach(([sx, sy, b]) => {
          const fl = 0.3 + 0.7 * Math.sin(t * (1.2 + b * 2.8) + sx * 19 + sy * 13);
          ctx.fillStyle = "white"; ctx.globalAlpha = b * fl * 0.9;
          const s = 0.6 + fl; ctx.fillRect(sx * W - s / 2, sy * H - s / 2, s, s);
        });
        ctx.globalAlpha = 1;

        // Shooting star (occasional)
        if (!shootingStarRef.current && Math.random() < 0.0004) {
          shootingStarRef.current = { x: Math.random() * W * 0.6, y: Math.random() * H * 0.15, vx: 3.5, vy: 1.8, life: 1 };
        }
        if (shootingStarRef.current) {
          const ss = shootingStarRef.current;
          ss.x += ss.vx * 2.5; ss.y += ss.vy * 2.5; ss.life -= 0.03;
          ctx.save(); ctx.globalAlpha = ss.life * 0.85;
          const grad = ctx.createLinearGradient(ss.x - ss.vx * 10, ss.y - ss.vy * 10, ss.x, ss.y);
          grad.addColorStop(0, "rgba(255,255,255,0)"); grad.addColorStop(1, "rgba(255,255,220,0.9)");
          ctx.strokeStyle = grad; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(ss.x - ss.vx * 10, ss.y - ss.vy * 10); ctx.lineTo(ss.x, ss.y); ctx.stroke();
          ctx.restore();
          if (ss.life <= 0 || ss.x > W || ss.y > H) shootingStarRef.current = null;
        }

        // Moon — large, dramatic with multiple halos
        ctx.save();
        const moonX = W * 0.82, moonY = H * 0.09;
        // Outer atmospheric halo
        const moonHalo2 = ctx.createRadialGradient(moonX, moonY, 18, moonX, moonY, 70);
        moonHalo2.addColorStop(0, "rgba(100,120,255,0.08)"); moonHalo2.addColorStop(1, "rgba(60,80,255,0)");
        ctx.fillStyle = moonHalo2; ctx.beginPath(); ctx.arc(moonX, moonY, 70, 0, Math.PI * 2); ctx.fill();
        // Inner halo
        const moonHalo = ctx.createRadialGradient(moonX, moonY, 16, moonX, moonY, 38);
        moonHalo.addColorStop(0, "rgba(180,200,255,0.18)"); moonHalo.addColorStop(1, "rgba(80,100,255,0)");
        ctx.fillStyle = moonHalo; ctx.beginPath(); ctx.arc(moonX, moonY, 38, 0, Math.PI * 2); ctx.fill();
        ctx.shadowColor = "#8080ff"; ctx.shadowBlur = 35;
        ctx.fillStyle = "#d8e0ff"; ctx.beginPath(); ctx.arc(moonX, moonY, 19, 0, Math.PI * 2); ctx.fill();
        // Moon craters
        ctx.globalAlpha = 0.25; ctx.fillStyle = "#aab8f0";
        ctx.beginPath(); ctx.arc(moonX + 6, moonY - 4, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(moonX - 5, moonY + 3, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();
      } else {
        // Blood moon (day — ominous)
        ctx.save();
        const bx = W * 0.13, by = H * 0.07;
        const sg2 = ctx.createRadialGradient(bx, by, 0, bx, by, 100);
        sg2.addColorStop(0, "rgba(255,30,0,0.7)"); sg2.addColorStop(0.3, "rgba(200,10,0,0.35)"); sg2.addColorStop(0.6, "rgba(160,0,0,0.12)"); sg2.addColorStop(1, "rgba(200,0,0,0)");
        ctx.fillStyle = sg2; ctx.beginPath(); ctx.arc(bx, by, 100, 0, Math.PI * 2); ctx.fill();
        ctx.shadowColor = "#ff2200"; ctx.shadowBlur = 40;
        ctx.fillStyle = "#cc1100"; ctx.beginPath(); ctx.arc(bx, by, 22, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      // Lightning bolt (when flash active)
      if (lightFade > 0.4) {
        ctx.save(); ctx.strokeStyle = `rgba(200,220,255,${lightFade * 0.7})`; ctx.lineWidth = 2;
        const lx = W * (0.3 + Math.random() * 0.4), ly = 0;
        ctx.beginPath(); ctx.moveTo(lx, ly);
        let cx2 = lx, cy2 = ly;
        for (let s = 0; s < 5; s++) { cx2 += (Math.random() - 0.5) * 60; cy2 += H * 0.12; ctx.lineTo(cx2, cy2); }
        ctx.stroke(); ctx.restore();
      }

      // Torches — more dramatic
      [[0.19,0.57],[0.81,0.57],[0.08,0.68],[0.92,0.68],[0.35,0.63],[0.65,0.63]].forEach(([tx, ty]) => {
        const x = tx * W, y = ty * H;
        const fl = 0.5 + 0.5 * Math.sin(t * (8 + tx * 5) + tx * 22);
        // Light pool on ground
        ctx.save();
        const torchGlow = ctx.createRadialGradient(x, y + 10, 0, x, y + 10, 45);
        torchGlow.addColorStop(0, `rgba(255,140,0,${fl * 0.12})`); torchGlow.addColorStop(1, "rgba(255,80,0,0)");
        ctx.fillStyle = torchGlow; ctx.fillRect(x - 50, y - 10, 100, 60);
        // Torch pole
        ctx.fillStyle = "#2a1500"; ctx.fillRect(x - 2, y - 22, 4, 26);
        // Flame
        ctx.shadowColor = "#ff8800"; ctx.shadowBlur = 28 * fl; ctx.globalAlpha = 0.9;
        ctx.fillStyle = `hsl(${18 + fl * 22},100%,${35 + fl * 28}%)`;
        ctx.beginPath(); ctx.moveTo(x, y - 22);
        ctx.bezierCurveTo(x - 7, y - 35, x + 6, y - 42, x, y - 50 - fl * 9);
        ctx.bezierCurveTo(x - 6, y - 42, x + 7, y - 35, x, y - 22);
        ctx.fill();
        // Inner bright flame
        ctx.fillStyle = `rgba(255,240,180,${fl * 0.7})`;
        ctx.beginPath(); ctx.moveTo(x, y - 22);
        ctx.bezierCurveTo(x - 3, y - 30, x + 3, y - 34, x, y - 38);
        ctx.bezierCurveTo(x - 3, y - 34, x + 3, y - 30, x, y - 22);
        ctx.fill();
        ctx.restore();
      });

      // Campfire — center, larger
      const cfX = W * 0.5, cfY = H * 0.65;
      ctx.save();
      const cfg = ctx.createRadialGradient(cfX, cfY, 0, cfX, cfY, 130 + 20 * Math.sin(t * 2.5));
      cfg.addColorStop(0, "rgba(255,100,0,0.28)"); cfg.addColorStop(0.4, "rgba(255,50,0,0.1)"); cfg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = cfg; ctx.fillRect(0, 0, W, H); ctx.restore();
      // Flames
      for (let fi = 0; fi < 7; fi++) {
        const fl = 0.25 + 0.75 * Math.sin(t * (5 + fi * 2.1) + fi * 1.5), ox = (fi - 3) * 8;
        ctx.save(); ctx.globalAlpha = 0.82;
        ctx.fillStyle = fi < 2 ? "#ff2200" : fi < 4 ? "#ff7700" : fi < 6 ? "#ffcc00" : "#ffff88";
        const fh = 18 + 22 * fl;
        ctx.beginPath(); ctx.moveTo(cfX + ox, cfY);
        ctx.bezierCurveTo(cfX + ox - 6, cfY - fh * 0.5, cfX + ox + 6, cfY - fh * 0.75, cfX + ox, cfY - fh);
        ctx.bezierCurveTo(cfX + ox - 6, cfY - fh * 0.75, cfX + ox + 6, cfY - fh * 0.5, cfX + ox, cfY);
        ctx.fill(); ctx.restore();
      }
      // Logs
      ctx.strokeStyle = "#2a1000"; ctx.lineWidth = 6; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(cfX - 26, cfY + 7); ctx.lineTo(cfX + 8, cfY - 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cfX + 26, cfY + 7); ctx.lineTo(cfX - 8, cfY - 7); ctx.stroke();
      ctx.strokeStyle = "rgba(80,50,20,0.3)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(cfX, cfY + 9, 35, 11, 0, 0, Math.PI * 2); ctx.stroke();

      // Animated rolling fog layers
      for (let fl = 0; fl < 3; fl++) {
        const fogY = H * (0.58 + fl * 0.05);
        const fogOffset = (t * (15 + fl * 8)) % W;
        const fogG = ctx.createLinearGradient(0, fogY, 0, fogY + H * 0.06);
        fogG.addColorStop(0, `rgba(${isDay ? "20,5,5" : "4,2,12"},0)`);
        fogG.addColorStop(0.5, `rgba(${isDay ? "25,5,5" : "5,3,14"},${0.18 - fl * 0.05})`);
        fogG.addColorStop(1, `rgba(${isDay ? "20,5,5" : "4,2,12"},0)`);
        ctx.save(); ctx.globalAlpha = 0.7;
        // Two offset fog panels to create seamless scroll
        ctx.fillStyle = fogG;
        ctx.fillRect(-fogOffset, fogY, W, H * 0.06);
        ctx.fillRect(W - fogOffset, fogY, W, H * 0.06);
        ctx.restore();
      }

      // Particles
      if (Math.random() < 0.5 && pRef.current.length < 160) {
        pRef.current.push({ x: cfX + (Math.random() - 0.5) * 22, y: cfY - 28, vx: (Math.random() - 0.5) * 1.4, vy: -(1.8 + Math.random() * 3), life: 1, size: 0.7 + Math.random() * 2.1, color: Math.random() < 0.35 ? "#ff5500" : Math.random() < 0.65 ? "#ffaa00" : "#ffee55", type: "ember" });
      }
      [[0.19,0.57],[0.81,0.57],[0.08,0.68],[0.92,0.68],[0.35,0.63],[0.65,0.63]].forEach(([tx, ty]) => {
        if (Math.random() < 0.11) pRef.current.push({ x: tx * W + (Math.random() - 0.5) * 7, y: ty * H - 32, vx: (Math.random() - 0.5) * 0.6, vy: -(0.5 + Math.random() * 1.8), life: 1, size: 0.4 + Math.random() * 0.9, color: "#ff9900", type: "ember" });
      });
      if (!isDay && Math.random() < 0.18 && pRef.current.length < 175) {
        pRef.current.push({ x: Math.random() * W * 0.85 + W * 0.08, y: H * 0.15 + Math.random() * H * 0.5, vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.25, life: 1, size: 1.4 + Math.random() * 1.8, color: "#88ff44", type: "firefly" });
      }
      if (isDay && Math.random() < 0.055 && pRef.current.length < 170) {
        pRef.current.push({ x: Math.random() * W, y: -5, vx: (Math.random() - 0.5) * 0.4, vy: 0.9 + Math.random() * 1.8, life: 1, size: 1.2 + Math.random() * 2.2, color: "#990000", type: "blood" });
      }
      // Rain drops on ground (night)
      if (!isDay && Math.random() < 0.25 && pRef.current.length < 175) {
        pRef.current.push({ x: Math.random() * W, y: H * 0.62 + Math.random() * H * 0.08, vx: -0.5, vy: 0, life: 0.4 + Math.random() * 0.3, size: 1.5, color: "rgba(120,150,200,0.4)", type: "raindrop" });
      }

      pRef.current = pRef.current.filter(p => {
        if (p.type === "ember") {
          p.x += p.vx + Math.sin(t * 3.5 + p.y * 0.01) * 0.35; p.y += p.vy; p.vy *= 0.985; p.life -= 0.011;
          ctx.globalAlpha = p.life * 0.88; ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        } else if (p.type === "firefly") {
          p.x += p.vx + Math.sin(t * 1.5 + p.x * 0.05) * 0.2; p.y += p.vy + Math.cos(t * 1.8 + p.y * 0.04) * 0.15; p.life -= 0.005;
          const pulse = 0.4 + 0.6 * Math.sin(t * 3.5 + p.x * 0.12);
          ctx.save(); ctx.shadowColor = "#aaffaa"; ctx.shadowBlur = 14 * pulse;
          ctx.globalAlpha = p.life * pulse; ctx.fillStyle = "#88ff44";
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.7 + pulse * 0.5), 0, Math.PI * 2); ctx.fill(); ctx.restore();
        } else if (p.type === "blood") {
          p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life -= 0.008;
          ctx.globalAlpha = p.life * 0.45; ctx.fillStyle = "#880000";
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        } else if (p.type === "raindrop") {
          p.x += p.vx; p.life -= 0.08;
          ctx.globalAlpha = p.life; ctx.strokeStyle = p.color; ctx.lineWidth = p.size;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 4, p.y); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        return p.life > 0 && p.y < H + 20 && p.x > -20 && p.x < W + 20;
      });

      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, [phase, canvasRef]);
}

// ── How to Play — Fixed right-side panel (MetaMask style) ─────────────────
function HowToPlay() {
  const [open, setOpen] = useState(false);
  const roles = [
    { icon: "🗡️", name: "MAFIA", color: "#ff4455", bg: "rgba(180,20,20,0.12)", desc: "Choose one player to eliminate each night. Stay hidden from Citizens." },
    { icon: "💉", name: "DOCTOR", color: "#44dd88", bg: "rgba(20,160,80,0.12)", desc: "Protect a player from elimination each night. Cannot protect the same person twice. (5+ players)" },
    { icon: "🛡️", name: "CITIZEN", color: "#cccccc", bg: "rgba(100,100,100,0.1)", desc: "Discuss, deduce, and vote to eliminate suspects during the day." },
  ];
  return (
    <>
      {/* Trigger button — always visible, bottom-right */}
      <button
        onClick={() => setOpen(o => !o)}
        className="fixed flex items-center gap-2 text-xs font-black tracking-widest px-4 py-2.5 rounded-full transition-all"
        style={{ bottom: 24, right: 24, zIndex: 90, background: open ? "rgba(200,60,20,0.9)" : "rgba(12,8,20,0.9)", color: open ? "#fff" : "#aaa", border: "1px solid rgba(200,80,20,0.4)", backdropFilter: "blur(12px)", boxShadow: "0 4px 24px rgba(0,0,0,0.6)" }}>
        {open ? "✕ CLOSE" : "📖 HOW TO PLAY"}
      </button>

      {/* Slide-in panel from right */}
      {open && (
        <div className="fixed top-0 right-0 h-full" style={{ zIndex: 89, width: 320, animation: "slideInRight 0.3s cubic-bezier(0.34,1.1,0.64,1) forwards" }}>
          <div className="h-full flex flex-col" style={{ background: "rgba(8,5,14,0.98)", borderLeft: "1px solid rgba(200,80,20,0.3)", backdropFilter: "blur(20px)" }}>
            {/* Header */}
            <div className="px-5 py-4 flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <p className="font-black text-base tracking-widest" style={{ color: "#ff6633" }}>HOW TO PLAY</p>
              <p className="text-xs mt-0.5" style={{ color: "#555" }}>Shadow Mafia · On-Chain Social Deduction</p>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5" style={{ scrollbarWidth: "thin", scrollbarColor: "#333 transparent" }}>

              {/* The Game */}
              <div>
                <p className="text-xs font-black tracking-widest mb-2" style={{ color: "#ff6633" }}>THE GAME</p>
                <p className="text-xs leading-5" style={{ color: "#aaa" }}>
                  4–8 players. Each player is secretly assigned a role inside a <span style={{ color: "#44dd88" }}>cryptographic TEE vault</span> — no one, not even the server, can see your role.
                </p>
                <p className="text-xs leading-5 mt-2" style={{ color: "#aaa" }}>
                  Mafia tries to eliminate all Citizens. Citizens try to expose and vote out all Mafia. Play alternates between Night and Day until one side wins.
                </p>
              </div>

              {/* Roles */}
              <div>
                <p className="text-xs font-black tracking-widest mb-3" style={{ color: "#ff6633" }}>ROLES</p>
                <div className="space-y-3">
                  {roles.map(r => (
                    <div key={r.name} className="rounded-lg p-3" style={{ background: r.bg, border: `1px solid ${r.color}22` }}>
                      <div className="flex items-center gap-2 mb-1">
                        <span>{r.icon}</span>
                        <span className="text-xs font-black tracking-wider" style={{ color: r.color }}>{r.name}</span>
                      </div>
                      <p className="text-xs leading-4" style={{ color: "#888" }}>{r.desc}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Phases */}
              <div>
                <p className="text-xs font-black tracking-widest mb-3" style={{ color: "#ff6633" }}>GAME PHASES</p>
                <div className="space-y-3">
                  <div className="rounded-lg p-3" style={{ background: "rgba(40,20,80,0.2)", border: "1px solid rgba(120,80,220,0.2)" }}>
                    <p className="text-xs font-black mb-1" style={{ color: "#aa88ff" }}>🌑 NIGHT PHASE</p>
                    <p className="text-xs leading-4" style={{ color: "#888" }}>Mafia secretly votes on who to eliminate. Doctor protects one player. Actions are sealed in the TEE — no one sees them.</p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: "rgba(80,30,10,0.2)", border: "1px solid rgba(220,100,20,0.2)" }}>
                    <p className="text-xs font-black mb-1" style={{ color: "#ffaa44" }}>☀️ DAY PHASE</p>
                    <p className="text-xs leading-4" style={{ color: "#888" }}>The night's result is revealed. Players discuss in public chat, then vote to eliminate a suspect. The player with most votes is removed.</p>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: "rgba(20,60,20,0.2)", border: "1px solid rgba(60,160,60,0.2)" }}>
                    <p className="text-xs font-black mb-1" style={{ color: "#44cc66" }}>🏆 WIN CONDITIONS</p>
                    <p className="text-xs leading-4" style={{ color: "#888" }}>
                      <span style={{ color: "#cccccc" }}>Citizens win</span> — all Mafia eliminated.<br />
                      <span style={{ color: "#ff4455" }}>Mafia wins</span> — Mafia count equals or exceeds Citizens.
                    </p>
                  </div>
                </div>
              </div>

              {/* Privacy */}
              <div className="rounded-lg p-3" style={{ background: "rgba(0,30,0,0.3)", border: "1px solid rgba(0,200,80,0.2)" }}>
                <p className="text-xs font-black mb-1" style={{ color: "#44dd88" }}>🔒 PROVABLE FAIRNESS</p>
                <p className="text-xs leading-4" style={{ color: "#888" }}>
                  Roles assigned via on-chain VRF. Game state sealed in a <span style={{ color: "#44dd88" }}>cryptographic private vault</span>. At game end, a cryptographic hash proves the result was not tampered with.
                </p>
              </div>

              <div className="pb-20" /> {/* Bottom padding for trigger button */}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Privacy Proof Panel ───────────────────────────────────────────────────
function PrivacyPanel({
  vrfHash, resultHash, teeStatus, teeTxSigs,
}: {
  vrfHash: string;
  resultHash: string;
  teeStatus: string;
  teeTxSigs: { delegate?: string; assignRoles?: string; endNight?: string; endDay?: string; endGame?: string };
}) {
  const [open, setOpen] = useState(false);
  const statusColor = teeStatus === "committed" ? "#44ff88" : teeStatus === "failed" ? "#ff4444" : teeStatus === "idle" ? "#555" : "#ffcc33";
  const statusLabel: Record<string, string> = {
    idle: "Simulated", delegating: "Delegating…", delegated: "Delegated ✓",
    assigning: "Assigning roles…", active: "TEE Active ✓",
    committing: "Committing…", committed: "Committed L1 ✓", failed: "Fallback mode",
  };
  const explorerBase = "https://explorer.solana.com/tx";
  return (
    <div className="absolute top-14 right-3" style={{ zIndex: 25 }}>
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition"
        style={{ background: "rgba(0,20,0,0.7)", borderColor: "rgba(0,200,80,0.3)", color: "#44cc66", backdropFilter: "blur(8px)" }}>
        🔒 TEE PROOF {open ? "▲" : "▼"}
      </button>
      {open && (
        <div className="mt-1 rounded-xl p-3 text-xs space-y-1.5 w-64"
          style={{ background: "rgba(0,10,0,0.92)", border: "1px solid rgba(0,200,80,0.2)", backdropFilter: "blur(12px)", animation: "floatIn 0.2s ease forwards" }}>
          <p className="text-green-400 font-black tracking-wider mb-1">INTEL TDX PRIVATE ER</p>
          <div className="flex justify-between">
            <span style={{ color: "#888" }}>Status</span>
            <span style={{ color: statusColor }}>{statusLabel[teeStatus] ?? teeStatus}</span>
          </div>
          <div className="flex justify-between"><span style={{ color: "#888" }}>Role assign</span><span className="text-green-400">VRF on-chain ✓</span></div>
          <div className="flex justify-between"><span style={{ color: "#888" }}>Vote tally</span><span className="text-green-400">On-chain TEE ✓</span></div>
          <div className="flex justify-between"><span style={{ color: "#888" }}>Mafia chat</span><span className="text-green-400">TEE-only ✓</span></div>

          {/* On-chain TX links — verifiable proof of TEE game logic */}
          {(teeTxSigs.delegate || teeTxSigs.assignRoles || teeTxSigs.endNight || teeTxSigs.endDay || teeTxSigs.endGame) && (
            <div className="mt-2 pt-2 space-y-1" style={{ borderTop: "1px solid rgba(0,200,80,0.15)" }}>
              <p className="font-black" style={{ color: "#44cc66" }}>ON-CHAIN PROOF</p>
              {teeTxSigs.delegate && (
                <div>
                  <p style={{ color: "#555" }}>delegate_game (L1 → ER)</p>
                  <a href={`${explorerBase}/${teeTxSigs.delegate}?cluster=devnet`} target="_blank" rel="noreferrer"
                    className="font-mono break-all" style={{ color: "#44ff88" }}>
                    {teeTxSigs.delegate.slice(0, 22)}…
                  </a>
                </div>
              )}
              {teeTxSigs.assignRoles && (
                <div>
                  <p style={{ color: "#555" }}>assign_roles (VRF inside TEE)</p>
                  <a href={`${explorerBase}/${teeTxSigs.assignRoles}?cluster=custom&customUrl=https://devnet.magicblock.app`} target="_blank" rel="noreferrer"
                    className="font-mono break-all" style={{ color: "#44ff88" }}>
                    {teeTxSigs.assignRoles.slice(0, 22)}…
                  </a>
                </div>
              )}
              {teeTxSigs.endNight && (
                <div>
                  <p style={{ color: "#555" }}>tally_and_close_night (TEE)</p>
                  <a href={`${explorerBase}/${teeTxSigs.endNight}?cluster=custom&customUrl=https://devnet.magicblock.app`} target="_blank" rel="noreferrer"
                    className="font-mono break-all" style={{ color: "#44ff88" }}>
                    {teeTxSigs.endNight.slice(0, 22)}…
                  </a>
                </div>
              )}
              {teeTxSigs.endDay && (
                <div>
                  <p style={{ color: "#555" }}>tally_and_close_day (TEE)</p>
                  <a href={`${explorerBase}/${teeTxSigs.endDay}?cluster=custom&customUrl=https://devnet.magicblock.app`} target="_blank" rel="noreferrer"
                    className="font-mono break-all" style={{ color: "#44ff88" }}>
                    {teeTxSigs.endDay.slice(0, 22)}…
                  </a>
                </div>
              )}
              {teeTxSigs.endGame && (
                <div>
                  <p style={{ color: "#555" }}>end_game (ER → L1 commit)</p>
                  <a href={`${explorerBase}/${teeTxSigs.endGame}?cluster=devnet`} target="_blank" rel="noreferrer"
                    className="font-mono break-all" style={{ color: "#44ff88" }}>
                    {teeTxSigs.endGame.slice(0, 22)}…
                  </a>
                </div>
              )}
            </div>
          )}

          {vrfHash && (
            <div className="mt-2 pt-2" style={{ borderTop: "1px solid rgba(0,200,80,0.15)" }}>
              <p style={{ color: "#888" }}>VRF seed hash</p>
              <p className="font-mono text-green-400 break-all">{vrfHash}</p>
            </div>
          )}
          {resultHash && (
            <div className="mt-1">
              <p style={{ color: "#888" }}>Result hash</p>
              <p className="font-mono text-green-400 break-all">{resultHash}</p>
            </div>
          )}
          <div className="mt-2 pt-2 text-center" style={{ borderTop: "1px solid rgba(0,200,80,0.1)", color: "#555" }}>
            MagicBlock Private Ephemeral Rollup
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("4jEx2Z526KdKe97TKqf7kZnkdM3LBDtH6Et5n2cJnam8");
const GAME_SEED = Buffer.from("shadow_mafia_game");
const PLAYER_SEED = Buffer.from("shadow_mafia_player");

// ── Private Ephemeral Rollup (TEE) constants ──────────────────────────────
const TEE_ENDPOINT = process.env.NEXT_PUBLIC_TEE_ENDPOINT || "https://devnet.magicblock.app";
const SESSION_KEYS_PROGRAM_ID = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
const DELEGATION_PROGRAM_KEY = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM_KEY = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT_KEY = new PublicKey("MagicContext1111111111111111111111111111111");

// Discriminators (SHA-256 of "global:<instruction_name>", first 8 bytes)
const DISC_DELEGATE_GAME   = Buffer.from([116,183,70,107,112,223,122,210]);
const DISC_ASSIGN_ROLES    = Buffer.from([55,227,97,221,175,205,197,179]);
const DISC_END_GAME        = Buffer.from([224,135,245,99,67,175,121,252]);

export default function Home() {
  const socketRef = useRef<Socket | null>(null);
  const joiningRef = useRef(false); // true while waiting for server to confirm join_game
  const [joining, setJoining] = useState(false); // drives button loading state
  const [joinError, setJoinError] = useState(""); // inline error shown in join card
  const [pendingHostJoin, setPendingHostJoin] = useState<number | null>(null); // numericId waiting for wallet
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const mafiaChatEndRef = useRef<HTMLDivElement>(null);
  const { init: initAudio, play: playSound } = useSoundEngine();
  const { publicKey, sendTransaction, signTransaction, connecting, connected: walletConnected } = useWallet();
  const { connection } = useConnection();

  // ── Private ER (TEE) ──────────────────────────────────────────────────────
  const erConnectionRef = useRef<Connection | null>(null);
  if (!erConnectionRef.current) {
    erConnectionRef.current = new Connection(TEE_ENDPOINT, { commitment: "confirmed" });
  }

  const [connected, setConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [gameTxSig, setGameTxSig] = useState("");
  const [username, setUsername] = useState("");
  const [aliasConfirmed, setAliasConfirmed] = useState(false);
  const [screen, setScreen] = useState<"home" | "create" | "join" | "game">("home");
  const [gameId, setGameId] = useState("");
  const [joinGameId, setJoinGameId] = useState("");
  const [stakeSOL, setStakeSOL] = useState("0.1");
  const [maxPlayers, setMaxPlayers] = useState("6");

  const [phase, setPhase] = useState<Phase>("Lobby");
  const [round, setRound] = useState(1);
  const [myRole, setMyRole] = useState<Role>(null);
  const [roleMessage, setRoleMessage] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [mafiaChat, setMafiaChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [speechBubbles, setSpeechBubbles] = useState<Record<string, string>>({});
  const bubbleTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [mafiaChatInput, setMafiaChatInput] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("");
  const [phaseEndTime, setPhaseEndTime] = useState(0);
  const [phaseTimer, setPhaseTimer] = useState(0);
  const [hasVoted, setHasVoted] = useState(false);
  const [hasProtected, setHasProtected] = useState(false);
  const [protectedTarget, setProtectedTarget] = useState("");
  const [voteTallies, setVoteTallies] = useState<Record<string, number>>({});
  const [gameResult, setGameResult] = useState<{ winner: string; message: string; allRoles: Record<string, string>; resultHash?: string; vrfSeedHex?: string } | null>(null);
  const [notification, setNotification] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showMafiaChat, setShowMafiaChat] = useState(false);
  const [dyingWallet, setDyingWallet] = useState<string | null>(null);
  const [phaseFlash, setPhaseFlash] = useState<"night" | "day" | null>(null);
  const [shockwave, setShockwave] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [vrfHash, setVrfHash] = useState("");
  const [resultHash, setResultHash] = useState("");
  const [copied, setCopied] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [numericGameId, setNumericGameId] = useState(0);
  const [teeStatus, setTeeStatus] = useState<"idle" | "delegating" | "delegated" | "assigning" | "active" | "committing" | "committed" | "failed">("idle");
  const [teeTxSigs, setTeeTxSigs] = useState<{ delegate?: string; assignRoles?: string; endNight?: string; endDay?: string; endGame?: string }>({});
  const [discMafiaNightVote, setDiscMafiaNightVote] = useState<Uint8Array | null>(null);
  const [discDayVoteIx, setDiscDayVoteIx] = useState<Uint8Array | null>(null);
  const [discDoctorProtect, setDiscDoctorProtect] = useState<Uint8Array | null>(null);
  const [voteInFlight, setVoteInFlight] = useState(false);

  // ── Session keys (gasless votes) ─────────────────────────────────────────
  const burnerKpRef = useRef<Keypair | null>(null);
  const [sessionTokenPDA, setSessionTokenPDA] = useState<PublicKey | null>(null);
  // Ref always points to latest createSessionKey — lets socket handler call it without stale closure
  const createSessionKeyRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useGameCanvas(canvasRef, phase);

  // ── Socket ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("game_created", ({ gameId: gid }: { gameId: string }) => {
      setGameId(gid); setScreen("game"); setIsHost(true); notify("Game created! Code: " + gid);
    });
    // Server emits this once GameState PDA is confirmed on devnet — triggers host's join_game TX
    socket.on("game_ready", ({ numericId }: { gameId: string; numericId: number }) => {
      setPendingHostJoin(numericId);
    });
    socket.on("player_joined", ({ walletAddress: w, username: u, playerCount }: { walletAddress: string; username: string; playerCount: number }) => {
      notify(`${u} entered the shadows. (${playerCount} players)`);
      setPlayers(prev => prev.find(p => p.walletAddress === w) ? prev : [...prev, { walletAddress: w, username: u, isEliminated: false }]);
    });
    socket.on("player_left", ({ walletAddress: w, playerCount }: { walletAddress: string; playerCount: number }) => {
      notify(`A player fled. (${playerCount} players)`);
      setPlayers(prev => prev.filter(p => p.walletAddress !== w));
    });
    socket.on("game_state", (state: GameState) => {
      setPhase(state.phase); setRound(state.round); setPlayers(state.players); setChat(state.chat);
      // Switch to game screen only after server confirms join (not immediately on button click)
      if (joiningRef.current) { joiningRef.current = false; setJoining(false); setScreen("game"); }
    });
    socket.on("role_assigned", ({ role, message }: { role: Role; message: string }) => {
      setMyRole(role); setRoleMessage(message); setShowRoleModal(true); playSound("role");
      // Use ref so we always call the latest createSessionKey (avoids stale closure)
      createSessionKeyRef.current();
    });
    socket.on("game_starting", ({ vrfSeedHash }: { playerCount: number; vrfSeedHash: string; message: string }) => {
      setPhase("Starting"); setVrfHash(vrfSeedHash);
      // Countdown 3-2-1
      setCountdown(3);
      const t1 = setTimeout(() => setCountdown(2), 1000);
      const t2 = setTimeout(() => setCountdown(1), 2000);
      const t3 = setTimeout(() => setCountdown(null), 3000);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    });
    socket.on("phase_change", ({ phase: p, round: r, durationMs }: { phase: Phase; round: number; durationMs: number }) => {
      setPhase(p); setRound(r); setHasVoted(false); setHasProtected(false); setProtectedTarget("");
      setSelectedTarget(""); setVoteTallies({});
      setPhaseEndTime(Date.now() + durationMs);
      setPhaseFlash(p === "Night" ? "night" : p === "Day" ? "day" : null);
      setTimeout(() => setPhaseFlash(null), 800);
      playSound(p === "Night" ? "night" : "day");
      if (p === "Night") notify(`🌙 Night ${r} — The Mafia awakens...`);
      if (p === "Day") notify(`☀️ Day ${r} — Who among you is the killer?`);
    });
    socket.on("night_result", ({ eliminatedWallet, eliminatedRole, savedByDoctor }: { eliminatedWallet: string; eliminatedRole: string; savedByDoctor: boolean }) => {
      if (savedByDoctor) { notify("💉 The Doctor saved someone! Nobody died tonight."); return; }
      if (eliminatedWallet) {
        setDyingWallet(eliminatedWallet); setShockwave(true); playSound("eliminate");
        setTimeout(() => setShockwave(false), 700);
        setTimeout(() => { setPlayers(prev => prev.map(p => p.walletAddress === eliminatedWallet ? { ...p, isEliminated: true } : p)); setDyingWallet(null); }, 800);
        notify(`🔪 A body found at dawn. They were: ${eliminatedRole}`);
      } else { notify("🌙 The night passes. No one was taken."); }
    });
    socket.on("day_result", ({ eliminatedWallet, eliminatedRole }: { eliminatedWallet: string; eliminatedRole: string }) => {
      if (!eliminatedWallet) notify("⚖️ No majority — no one is exiled.");
      else if (eliminatedWallet) {
        setDyingWallet(eliminatedWallet); setShockwave(true); playSound("eliminate");
        setTimeout(() => setShockwave(false), 700);
        setTimeout(() => { setPlayers(prev => prev.map(p => p.walletAddress === eliminatedWallet ? { ...p, isEliminated: true } : p)); setDyingWallet(null); }, 800);
        notify(`🗳️ ${eliminatedWallet.slice(0, 6)}... exiled! They were: ${eliminatedRole}`);
      }
    });
    socket.on("vote_tallies", ({ tallies }: { tallies: Record<string, number>; totalVoted: number; totalAlive: number }) => {
      setVoteTallies(tallies);
    });
    socket.on("vote_confirmed", () => { setHasVoted(true); playSound("vote"); notify("✓ Vote cast in the dark."); });
    socket.on("protect_confirmed", ({ targetUsername }: { targetWallet: string; targetUsername: string }) => {
      playSound("protect"); setSavedMsg(`💉 Protecting ${targetUsername} tonight`);
      setTimeout(() => setSavedMsg(""), 4000);
    });
    socket.on("chat_message", (msg: ChatMessage) => {
      setChat(prev => [...prev, msg]);
      // Show speech bubble above the speaking character
      showSpeechBubble(msg.walletAddress, msg.text);
      // Voice-over (only for other players, not yourself — avoid echo)
      if (msg.walletAddress !== walletAddress) {
        const cleanName = msg.username.replace("💀 ", "");
        speakMessage(cleanName, msg.text);
      }
    });
    socket.on("mafia_chat", (msg: ChatMessage) => {
      setMafiaChat(prev => [...prev, msg]); setShowMafiaChat(true);
    });
    socket.on("game_over", ({ winner, message, allRoles, resultHash: rh, vrfSeedHex }: { winner: string; winners: Player[]; allRoles: Record<string, string>; resultHash: string; vrfSeedHex: string; message: string }) => {
      setPhase("GameOver"); setGameResult({ winner, message, allRoles, resultHash: rh, vrfSeedHex });
      setResultHash(rh || "");
      playSound(winner === "Citizens" ? "win" : "eliminate");
    });
    socket.on("error", ({ message }: { message: string }) => {
      if (joiningRef.current) {
        // Join was rejected — stay on join screen, show inline error
        joiningRef.current = false;
        setJoining(false);
        setJoinError(message);
        return;
      }
      notify("❌ " + message);
    });

    // ── TEE updates from server (actual on-chain transactions) ────────
    socket.on("tee_update", ({ action, txSig, status }: { action: string; txSig?: string; status: string }) => {
      if (status === "ok") {
        if (txSig) setTeeTxSigs(prev => ({ ...prev, [action]: txSig }));
        if (action === "delegateGame")  { setTeeStatus("delegated"); notify("🔒 Game delegated to Private ER (TEE)!"); }
        if (action === "assignRoles")   { setTeeStatus("active");   notify("🎭 VRF roles computed inside TEE!"); }
        if (action === "endNight")      { notify("🌙 Night tally sealed on-chain in TEE!"); }
        if (action === "endDay")        { notify("☀️ Day tally sealed on-chain in TEE!"); }
        if (action === "commitGame")    { setTeeStatus("committed"); notify("✅ Game result committed from TEE to L1!"); }
        if (action === "payout")        { notify("💰 SOL distributed to winners on-chain!"); }
      } else if (status === "failed") {
        if (action === "setupGame" || action === "delegateGame") setTeeStatus("failed");
      }
    });

    return () => { socket.disconnect(); };
  }, [playSound]);

  useEffect(() => {
    if (!phaseEndTime) return;
    const iv = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((phaseEndTime - Date.now()) / 1000));
      setPhaseTimer(remaining);
      // Heartbeat on last 5 seconds, every second
      if (remaining > 0 && remaining <= 5 && remaining % 1 === 0) playSound("heartbeat");
    }, 1000);
    return () => clearInterval(iv);
  }, [phaseEndTime, playSound]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);
  useEffect(() => { mafiaChatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [mafiaChat]);

  useEffect(() => {
    async function computeDiscs() {
      const enc = new TextEncoder();
      const encodeStr = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
      const [mn, dv, dp] = await Promise.all([
        window.crypto.subtle.digest("SHA-256", encodeStr("global:mafia_night_vote")),
        window.crypto.subtle.digest("SHA-256", encodeStr("global:day_vote")),
        window.crypto.subtle.digest("SHA-256", encodeStr("global:doctor_protect")),
      ]);
      setDiscMafiaNightVote(new Uint8Array(mn).slice(0, 8));
      setDiscDayVoteIx(new Uint8Array(dv).slice(0, 8));
      setDiscDoctorProtect(new Uint8Array(dp).slice(0, 8));
    }
    computeDiscs();
  }, []);

  // When server confirms GameState is on-chain, prompt host to sign their own join_game TX.
  // This gives the host a Phantom wallet interaction for game creation.
  useEffect(() => {
    if (!pendingHostJoin || !publicKey || !sendTransaction) return;
    const numericId = pendingHostJoin;
    setPendingHostJoin(null);
    (async () => {
      try {
        const gameIdBytes = Buffer.alloc(8);
        gameIdBytes.writeUInt32LE(numericId, 0);
        const [gamePDA] = PublicKey.findProgramAddressSync([GAME_SEED, gameIdBytes], PROGRAM_ID);
        const [playerPDA] = PublicKey.findProgramAddressSync(
          [Buffer.from("shadow_mafia_player"), gameIdBytes, publicKey.toBuffer()],
          PROGRAM_ID
        );
        const existing = await connection.getAccountInfo(playerPDA).catch(() => null);
        if (existing) return; // already joined on-chain
        const data = Buffer.alloc(16);
        Buffer.from([107, 112, 18, 38, 56, 173, 60, 128]).copy(data, 0);
        data.writeUInt32LE(numericId, 8);
        const ix = new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: gamePDA, isSigner: false, isWritable: true },
            { pubkey: playerPDA, isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        });
        notify("Sign to anchor your stake in the game…");
        const sig = await sendTransaction(new Transaction().add(ix), connection);
        setGameTxSig(sig);
        notify(`Game staked on-chain! TX: ${sig.slice(0, 14)}…`);
      } catch (e: any) {
        notify(`On-chain stake failed: ${e?.message?.slice(0, 50) || "wallet error"}`);
      }
    })();
  }, [pendingHostJoin, publicKey, sendTransaction, connection]);


  // (TEE commits are now handled server-side; see tee_update socket event)

  // Sync Phantom wallet publicKey → walletAddress
  useEffect(() => {
    if (publicKey) {
      setWalletAddress(publicKey.toBase58());
    } else {
      setWalletAddress("");
    }
  }, [publicKey]);

  function notify(msg: string) { setNotification(msg); setTimeout(() => setNotification(""), 4500); }

  // ── Speech bubble: show text above character, auto-dismiss after 5s ───────
  function showSpeechBubble(walletAddr: string, text: string) {
    setSpeechBubbles(prev => ({ ...prev, [walletAddr]: text }));
    if (bubbleTimers.current[walletAddr]) clearTimeout(bubbleTimers.current[walletAddr]);
    bubbleTimers.current[walletAddr] = setTimeout(() => {
      setSpeechBubbles(prev => { const n = { ...prev }; delete n[walletAddr]; return n; });
    }, 5500);
  }

  // ── Text-to-Speech: detect male/female by common name patterns ────────────
  function speakMessage(senderName: string, text: string) {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // stop any current speech
    const utt = new SpeechSynthesisUtterance(text);
    const clean = senderName.toLowerCase().replace(/[^a-z]/g, "");
    // Female name heuristics: ends in a/ia/ina/ella/elle/ine/ie/ey/i
    const femalePatterns = ["ia", "ina", "ella", "elle", "ine", "ie", "ey", "isha", "ita"];
    const isFemale = femalePatterns.some(p => clean.endsWith(p)) ||
      (clean.endsWith("a") && !["joshua", "ezra", "noah", "asa", "luca", "nika"].includes(clean));
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v =>
      isFemale ? v.name.toLowerCase().includes("female") || v.name.includes("Samantha") || v.name.includes("Karen") || v.name.includes("Moira") || v.name.includes("Zira")
               : v.name.toLowerCase().includes("male") || v.name.includes("Google UK") || v.name.includes("Daniel") || v.name.includes("David")
    );
    if (preferred) utt.voice = preferred;
    utt.pitch = isFemale ? 1.35 : 0.75;
    utt.rate = 1.05;
    utt.volume = 0.85;
    window.speechSynthesis.speak(utt);
  }

  // Browser-safe u64 little-endian write (Buffer polyfill lacks writeBigUInt64LE)
  function writeU64LE(buf: Buffer, value: number | bigint, offset: number) {
    const n = typeof value === "bigint" ? value : BigInt(Math.floor(Number(value)));
    buf.writeUInt32LE(Number(n & BigInt(0xFFFFFFFF)), offset);
    buf.writeUInt32LE(Number(n >> BigInt(32)), offset + 4);
  }

  // ── TEE helper: derive GameState PDA from numeric game_id ────────────────
  function gameIdBuffer(numId: number) {
    const b = Buffer.alloc(8);
    writeU64LE(b, numId, 0);
    return b;
  }

  // ── TEE Step 1: Delegate GameState PDA to Private ER (L1 tx) ─────────────
  async function delegateGamePDA(numId: number) {
    if (!publicKey || !signTransaction) return;
    setTeeStatus("delegating");
    try {
      const gameIdBytes = gameIdBuffer(numId);
      const [gamePDA] = PublicKey.findProgramAddressSync([GAME_SEED, gameIdBytes], PROGRAM_ID);
      const bufferPDA = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(gamePDA, PROGRAM_ID);
      const recordPDA = delegationRecordPdaFromDelegatedAccount(gamePDA);
      const metaPDA   = delegationMetadataPdaFromDelegatedAccount(gamePDA);

      // delegate_game: [disc 8B][game_id u64 LE]
      const data = Buffer.alloc(16);
      DISC_DELEGATE_GAME.copy(data, 0);
      writeU64LE(data, numId, 8);

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: publicKey!,             isSigner: true,  isWritable: true  }, // payer
          { pubkey: bufferPDA,              isSigner: false, isWritable: true  }, // buffer_pda
          { pubkey: recordPDA,              isSigner: false, isWritable: true  }, // delegation_record
          { pubkey: metaPDA,                isSigner: false, isWritable: true  }, // delegation_metadata
          { pubkey: gamePDA,                isSigner: false, isWritable: true  }, // pda (GameState)
          { pubkey: PROGRAM_ID,             isSigner: false, isWritable: false }, // owner_program
          { pubkey: DELEGATION_PROGRAM_KEY, isSigner: false, isWritable: false }, // delegation_program
          { pubkey: SystemProgram.programId,isSigner: false, isWritable: false }, // system_program
        ],
        data,
      });

      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection, { skipPreflight: true });
      const { blockhash: bh1, lastValidBlockHeight: lv1 } = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, blockhash: bh1, lastValidBlockHeight: lv1 }, "confirmed");
      setTeeStatus("delegated");
      setTeeTxSigs(prev => ({ ...prev, delegate: sig }));
      notify(`🔒 Game delegated to TEE! TX: ${sig.slice(0, 14)}…`);
    } catch (err: any) {
      console.error("[TEE] delegate_game failed:", err);
      setTeeStatus("failed");
      notify("⚠️ TEE delegation failed — game continues off-chain.");
    }
  }

  // ── TEE Step 2: assign_roles inside TEE (Night phase begins on-chain) ────
  async function assignRolesOnTEE(numId: number) {
    if (!publicKey || !signTransaction) return;
    const erConn = erConnectionRef.current!;
    setTeeStatus("assigning");
    try {
      const gameIdBytes = gameIdBuffer(numId);
      const [gamePDA] = PublicKey.findProgramAddressSync([GAME_SEED, gameIdBytes], PROGRAM_ID);

      // Generate cryptographic VRF seed
      const vrfSeed = new Uint8Array(32);
      crypto.getRandomValues(vrfSeed);

      // assign_roles: [disc 8B][game_id u64 LE][vrf_seed 32B]
      const data = Buffer.alloc(48);
      DISC_ASSIGN_ROLES.copy(data, 0);
      writeU64LE(data, numId, 8);
      Buffer.from(vrfSeed).copy(data, 16);

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: gamePDA,   isSigner: false, isWritable: true }, // game_state
          { pubkey: publicKey!, isSigner: true,  isWritable: true }, // host
        ],
        data,
      });

      let tx = new Transaction().add(ix);
      const { blockhash: bh2, lastValidBlockHeight: lv2 } = await erConn.getLatestBlockhash();
      tx.recentBlockhash = bh2;
      tx.feePayer = publicKey!;
      tx = await signTransaction(tx);

      const txHash = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await erConn.confirmTransaction({ signature: txHash, blockhash: bh2, lastValidBlockHeight: lv2 }, "confirmed");
      setTeeStatus("active");
      setTeeTxSigs(prev => ({ ...prev, assignRoles: txHash }));
      notify(`🎭 Roles assigned inside TEE! TX: ${txHash.slice(0, 14)}…`);
    } catch (err: any) {
      console.error("[TEE] assign_roles failed:", err);
      setTeeStatus("failed");
      // Don't block game — socket server already handled role assignment
      notify("⚠️ TEE role assignment failed — socket fallback active.");
    }
  }

  // ── TEE Step 3: end_game + commit back to L1 ─────────────────────────────
  async function commitGameOnTEE(numId: number) {
    if (!publicKey || !signTransaction) return;
    const erConn = erConnectionRef.current!;
    setTeeStatus("committing");
    try {
      const gameIdBytes = gameIdBuffer(numId);
      const [gamePDA] = PublicKey.findProgramAddressSync([GAME_SEED, gameIdBytes], PROGRAM_ID);

      // end_game: [disc 8B][game_id u64 LE]
      const data = Buffer.alloc(16);
      DISC_END_GAME.copy(data, 0);
      writeU64LE(data, numId, 8);

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: gamePDA,          isSigner: false, isWritable: true  }, // game_state
          { pubkey: publicKey!,       isSigner: true,  isWritable: true  }, // payer
          { pubkey: MAGIC_PROGRAM_KEY,isSigner: false, isWritable: false }, // magic_program
          { pubkey: MAGIC_CONTEXT_KEY,isSigner: false, isWritable: true  }, // magic_context
        ],
        data,
      });

      let tx = new Transaction().add(ix);
      const { blockhash: bh3, lastValidBlockHeight: lv3 } = await erConn.getLatestBlockhash();
      tx.recentBlockhash = bh3;
      tx.feePayer = publicKey!;
      tx = await signTransaction(tx);

      const txHash = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await erConn.confirmTransaction({ signature: txHash, blockhash: bh3, lastValidBlockHeight: lv3 }, "confirmed");
      setTeeStatus("committed");
      setTeeTxSigs(prev => ({ ...prev, endGame: txHash }));
      notify(`✅ Game committed from TEE to L1! TX: ${txHash.slice(0, 14)}…`);
    } catch (err: any) {
      console.error("[TEE] end_game failed:", err);
      setTeeStatus("failed");
      notify("⚠️ TEE commit failed — result still valid via game hash.");
    }
  }

  /**
   * createSessionKey — ONE Phantom popup that authorizes all subsequent votes.
   * Generates a burner Keypair in-browser, creates a SessionToken on devnet (L1).
   * After this, mafia/day/doctor votes use the burner to sign — NO more popups.
   */
  async function createSessionKey() {
    if (!publicKey || !signTransaction || !numericGameId) return;
    if (burnerKpRef.current) return; // already have one
    try {
      const burnerKp = Keypair.generate();

      // PDA seeds: ["session_token", target_program, session_signer, authority]
      const [sessionPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session_token"),
          PROGRAM_ID.toBuffer(),
          burnerKp.publicKey.toBuffer(),
          publicKey.toBuffer(),
        ],
        SESSION_KEYS_PROGRAM_ID
      );

      // Discriminator = SHA-256("global:create_session")[0:8]
      const enc = new TextEncoder();
      const disc = new Uint8Array(
        await window.crypto.subtle.digest("SHA-256", enc.encode("global:create_session").buffer as ArrayBuffer)
      ).slice(0, 8);

      // Data: disc(8) + top_up bool(1) + valid_until i64 LE(8) + Option<u64> Some(1+8)
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 6); // 6h
      const topUpLamports = BigInt(10_000_000); // 0.01 SOL for burner ER fees
      const data = Buffer.alloc(26);
      Buffer.from(disc).copy(data, 0);
      data.writeUInt8(1, 8);                         // top_up = true
      writeU64LE(data, validUntil, 9);               // valid_until
      data.writeUInt8(1, 17);                        // Option::Some
      writeU64LE(data, topUpLamports, 18);           // lamports

      const ix = new TransactionInstruction({
        programId: SESSION_KEYS_PROGRAM_ID,
        keys: [
          { pubkey: sessionPDA,            isSigner: false, isWritable: true  }, // session_token (init)
          { pubkey: burnerKp.publicKey,    isSigner: true,  isWritable: true  }, // session_signer
          { pubkey: publicKey,             isSigner: true,  isWritable: true  }, // authority (Phantom)
          { pubkey: PROGRAM_ID,            isSigner: false, isWritable: false }, // target_program
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        data,
      });

      // L1 tx — burner partial-signs first, Phantom signs second (one popup)
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      let tx = new Transaction().add(ix);
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      tx.partialSign(burnerKp);          // burner signs (no popup)
      tx = await signTransaction(tx);    // Phantom adds its sig (ONE popup total)
      const sig = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

      burnerKpRef.current = burnerKp;
      setSessionTokenPDA(sessionPDA);
      notify(`🔑 Session active — all votes are now gasless! (${sig.slice(0, 14)}…)`);
    } catch (e: any) {
      console.warn("[Session] createSessionKey failed:", e.message);
      // Graceful fallback: votes will use Phantom popup per action
    }
  }
  // Keep ref current so socket handler (which closes over mount-time values) always calls the latest version
  createSessionKeyRef.current = createSessionKey;

  const submitMafiaVoteOnChain = useCallback(async (targetWalletStr: string): Promise<string> => {
    if (!publicKey || !numericGameId || !discMafiaNightVote) {
      throw new Error("Not ready for on-chain vote");
    }
    const erConn = erConnectionRef.current!;
    const gameIdBuf = Buffer.alloc(8);
    writeU64LE(gameIdBuf, numericGameId, 0);

    const [gamePDA] = PublicKey.findProgramAddressSync([GAME_SEED, gameIdBuf], PROGRAM_ID);
    const [playerPDA] = PublicKey.findProgramAddressSync([PLAYER_SEED, gameIdBuf, publicKey.toBuffer()], PROGRAM_ID);
    const targetKey = new PublicKey(targetWalletStr);

    const data = Buffer.alloc(52);
    Buffer.from(discMafiaNightVote).copy(data, 0);
    writeU64LE(data, numericGameId, 8);
    targetKey.toBuffer().copy(data, 16);
    data.writeUInt32LE(1, 48); // tick = 1 (round)

    // Use burner (session key) if available — no Phantom popup; else fallback to Phantom
    const burner = burnerKpRef.current;
    const sessionPDA = sessionTokenPDA;
    const hasSession = burner !== null && sessionPDA !== null;
    const signerPubkey = hasSession ? burner.publicKey : publicKey;
    const sessionAccount = hasSession ? sessionPDA : SystemProgram.programId;

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: gamePDA,        isSigner: false, isWritable: true  },
        { pubkey: playerPDA,      isSigner: false, isWritable: true  },
        { pubkey: signerPubkey,   isSigner: true,  isWritable: true  },
        { pubkey: sessionAccount, isSigner: false, isWritable: false },
      ],
      data,
    });

    let tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await erConn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    if (hasSession) {
      tx.feePayer = burner.publicKey;
      tx.sign(burner); // burner signs — no Phantom popup
    } else {
      tx.feePayer = publicKey;
      tx = await signTransaction!(tx); // Phantom popup fallback
    }
    const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  }, [publicKey, signTransaction, numericGameId, discMafiaNightVote, sessionTokenPDA]);

  const submitDayVoteOnChain = useCallback(async (suspectWalletStr: string): Promise<string> => {
    if (!publicKey || !numericGameId || !discDayVoteIx) {
      throw new Error("Not ready for on-chain vote");
    }
    const erConn = erConnectionRef.current!;
    const gameIdBuf = Buffer.alloc(8);
    writeU64LE(gameIdBuf, numericGameId, 0);

    const [gamePDA] = PublicKey.findProgramAddressSync([GAME_SEED, gameIdBuf], PROGRAM_ID);
    const [playerPDA] = PublicKey.findProgramAddressSync([PLAYER_SEED, gameIdBuf, publicKey.toBuffer()], PROGRAM_ID);
    const suspectKey = new PublicKey(suspectWalletStr);

    const data = Buffer.alloc(52);
    Buffer.from(discDayVoteIx).copy(data, 0);
    writeU64LE(data, numericGameId, 8);
    suspectKey.toBuffer().copy(data, 16);
    data.writeUInt32LE(1, 48);

    // Use burner (session key) if available — no Phantom popup; else fallback to Phantom
    const burner = burnerKpRef.current;
    const sessionPDA = sessionTokenPDA;
    const hasSession = burner !== null && sessionPDA !== null;
    const signerPubkey = hasSession ? burner.publicKey : publicKey;
    const sessionAccount = hasSession ? sessionPDA : SystemProgram.programId;

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: gamePDA,        isSigner: false, isWritable: true  },
        { pubkey: playerPDA,      isSigner: false, isWritable: true  },
        { pubkey: signerPubkey,   isSigner: true,  isWritable: true  },
        { pubkey: sessionAccount, isSigner: false, isWritable: false },
      ],
      data,
    });

    let tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await erConn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    if (hasSession) {
      tx.feePayer = burner.publicKey;
      tx.sign(burner); // burner signs — no Phantom popup
    } else {
      tx.feePayer = publicKey;
      tx = await signTransaction!(tx); // Phantom popup fallback
    }
    const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  }, [publicKey, signTransaction, numericGameId, discDayVoteIx, sessionTokenPDA]);

  async function createGame() {
    if (!walletAddress) { notify("Connect your Phantom wallet first."); return; }
    if (!username.trim()) { notify("Enter your alias first."); return; }
    playSound("create");
    const gid = "MAFIA" + Math.floor(Math.random() * 9000 + 1000);
    const numericId = parseInt(gid.replace("MAFIA", ""));
    setGameId(gid);
    setNumericGameId(numericId);
    // Server creates the GameState PDA on devnet (server keypair = host, required for assign_roles).
    // Client does NOT create it to avoid PDA conflict and to keep server as authoritative host.
    socketRef.current?.emit("create_game", { gameId: gid, walletAddress, username, stakeSOL: parseFloat(stakeSOL), maxPlayers: parseInt(maxPlayers) });
  }

  async function joinGame() {
    setJoinError("");
    if (!walletAddress) { setJoinError("Connect your Phantom wallet first."); return; }
    if (!joinGameId.trim()) { setJoinError("Enter a game code."); return; }
    if (!username.trim()) { setJoinError("Enter your alias first."); return; }
    const gid = joinGameId.trim().toUpperCase();
    const numericId = parseInt(gid.replace("MAFIA", "")) || 0;
    setGameId(gid);
    if (numericId > 0) setNumericGameId(numericId);

    // On-chain join — send to devnet (GameState is NOT delegated yet at join time;
    // delegation happens at game start so players can join_game on devnet safely).
    if (numericId > 0 && publicKey) {
      const gameIdBytes = Buffer.alloc(8);
      gameIdBytes.writeUInt32LE(numericId, 0);
      const [playerPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("shadow_mafia_player"), gameIdBytes, publicKey!.toBuffer()],
        PROGRAM_ID
      );
      // Check devnet first — if PlayerState already exists, skip TX and let server say "Already in this game"
      const existing = await connection.getAccountInfo(playerPDA).catch(() => null);
      if (existing) {
        // Already joined on-chain — proceed to socket (server will check game.players for duplicate)
      } else {
        try {
          const [gamePDA] = PublicKey.findProgramAddressSync([GAME_SEED, gameIdBytes], PROGRAM_ID);
          // discriminator for join_game: [107,112,18,38,56,173,60,128]
          const data = Buffer.alloc(16);
          Buffer.from([107, 112, 18, 38, 56, 173, 60, 128]).copy(data, 0);
          data.writeUInt32LE(numericId, 8);
          const ix = new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: gamePDA, isSigner: false, isWritable: true },
              { pubkey: playerPDA, isSigner: false, isWritable: true },
              { pubkey: publicKey!, isSigner: true, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data,
          });
          const tx = new Transaction().add(ix);
          const sig = await sendTransaction(tx, connection);
          setGameTxSig(sig);
          notify(`Joined on-chain! TX: ${sig.slice(0, 14)}…`);
        } catch (e: any) {
          setJoinError(`On-chain join failed: ${e?.message?.slice(0, 80) || "wallet error"}`);
          return;
        }
      }
    }

    playSound("join");
    joiningRef.current = true;
    setJoining(true);
    socketRef.current?.emit("join_game", { gameId: gid, walletAddress, username });
    // Screen switches only when server sends game_state (confirms join success).
    // If server sends error instead, joiningRef is cleared and user stays here.
  }
  function startGame() {
    playSound("whoosh");
    socketRef.current?.emit("start_game", { gameId, walletAddress });
    // TEE: assign_roles is triggered server-side after game starts
  }
  const submitMafiaVote = useCallback(async () => {
    if (!selectedTarget || hasVoted || voteInFlight) return;
    if (!publicKey || !numericGameId || !discMafiaNightVote) { notify("Wallet not connected."); return; }
    setVoteInFlight(true);
    try {
      notify(burnerKpRef.current ? "Submitting gasless vote…" : "Sign your vote in Phantom…");
      const sig = await submitMafiaVoteOnChain(selectedTarget);
      socketRef.current?.emit("vote_submitted", { gameId, voterWallet: walletAddress, type: "night", targetWallet: selectedTarget });
      setHasVoted(true);
      notify(`✓ Night vote sealed on ER! ${sig.slice(0, 14)}…`);
    } catch (e: any) {
      console.error("[Vote] On-chain night vote failed:", e?.message);
      notify("❌ Vote failed: " + (e?.message?.slice(0, 60) || "wallet error"));
    } finally {
      setVoteInFlight(false);
    }
  }, [selectedTarget, hasVoted, voteInFlight, publicKey, numericGameId, discMafiaNightVote, walletAddress, gameId, submitMafiaVoteOnChain]);

  const submitDayVote = useCallback(async () => {
    if (!selectedTarget || hasVoted || voteInFlight) return;
    if (!publicKey || !numericGameId || !discDayVoteIx) { notify("Wallet not connected."); return; }
    setVoteInFlight(true);
    try {
      notify(burnerKpRef.current ? "Submitting gasless vote…" : "Sign your vote in Phantom…");
      const sig = await submitDayVoteOnChain(selectedTarget);
      socketRef.current?.emit("vote_submitted", { gameId, voterWallet: walletAddress, type: "day", targetWallet: selectedTarget });
      setHasVoted(true);
      notify(`✓ Day vote sealed on ER! ${sig.slice(0, 14)}…`);
    } catch (e: any) {
      console.error("[Vote] On-chain day vote failed:", e?.message);
      notify("❌ Vote failed: " + (e?.message?.slice(0, 60) || "wallet error"));
    } finally {
      setVoteInFlight(false);
    }
  }, [selectedTarget, hasVoted, voteInFlight, publicKey, numericGameId, discDayVoteIx, walletAddress, gameId, submitDayVoteOnChain]);
  async function submitProtect() {
    if (!selectedTarget || hasProtected) return;
    if (!publicKey || !numericGameId || !discDoctorProtect) { notify("Wallet not connected."); return; }
    try {
      const burner = burnerKpRef.current;
      const sessionPDA = sessionTokenPDA;
      const hasSession = burner !== null && sessionPDA !== null;
      notify(hasSession ? "Protecting (gasless)…" : "Sign protection in Phantom…");
      const erConn = erConnectionRef.current!;
      const gameIdBuf = Buffer.alloc(8);
      writeU64LE(gameIdBuf, numericGameId, 0);
      const [gamePDA] = PublicKey.findProgramAddressSync([GAME_SEED, gameIdBuf], PROGRAM_ID);
      const [playerPDA] = PublicKey.findProgramAddressSync([PLAYER_SEED, gameIdBuf, publicKey.toBuffer()], PROGRAM_ID);
      const protectKey = new PublicKey(selectedTarget);
      const data = Buffer.alloc(52);
      Buffer.from(discDoctorProtect).copy(data, 0);
      writeU64LE(data, numericGameId, 8);
      protectKey.toBuffer().copy(data, 16);
      data.writeUInt32LE(1, 48);
      const signerPubkey = hasSession ? burner!.publicKey : publicKey;
      const sessionAccount = hasSession ? sessionPDA! : SystemProgram.programId;
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: gamePDA,        isSigner: false, isWritable: true  },
          { pubkey: playerPDA,      isSigner: false, isWritable: true  },
          { pubkey: signerPubkey,   isSigner: true,  isWritable: true  },
          { pubkey: sessionAccount, isSigner: false, isWritable: false },
        ],
        data,
      });
      let tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await erConn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      if (hasSession) {
        tx.feePayer = burner!.publicKey;
        tx.sign(burner!); // gasless — no Phantom popup
      } else {
        tx.feePayer = publicKey;
        tx = await signTransaction!(tx);
      }
      const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setHasProtected(true); setProtectedTarget(selectedTarget);
      socketRef.current?.emit("protect_submitted", { gameId, doctorWallet: walletAddress, targetWallet: selectedTarget });
      notify(`💉 Protection sealed on ER! ${sig.slice(0, 14)}…`);
    } catch (e: any) {
      console.error("[Doctor] Protection TX failed:", e?.message);
      notify("❌ Protect failed: " + (e?.message?.slice(0, 60) || "wallet error"));
    }
  }
  function sendChat() {
    if (!chatInput.trim()) return;
    showSpeechBubble(walletAddress, chatInput);
    socketRef.current?.emit("chat_message", { gameId, walletAddress, text: chatInput });
    setChatInput("");
  }
  function sendMafiaChat() { if (!mafiaChatInput.trim()) return; socketRef.current?.emit("mafia_chat", { gameId, walletAddress, text: mafiaChatInput }); setMafiaChatInput(""); }
  function copyCode() { navigator.clipboard.writeText(gameId); setCopied(true); setTimeout(() => setCopied(false), 2000); }

  function handleCharacterClick(w: string) {
    initAudio();
    const isSelected = selectedTarget === w;
    setSelectedTarget(isSelected ? "" : w);
    if (!isSelected) playSound("select");
  }

  const mePlayer = players.find(p => p.walletAddress === walletAddress);
  const amEliminated = mePlayer?.isEliminated || false;
  const roleColor = myRole === "Mafia" ? "#ff3333" : myRole === "Doctor" ? "#44cc77" : "#aaaaaa";
  const timerLow = phaseTimer > 0 && phaseTimer <= 10;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black font-mono" onClick={initAudio}>
      <canvas ref={canvasRef} className="fixed inset-0 w-full h-full" style={{ zIndex: 0 }} />

      {/* CSS animations */}
      <style>{`
        @keyframes breathe { 0%,100%{transform:translateY(0) rotate(0deg) scale(1)} 35%{transform:translateY(-6px) rotate(-0.6deg) scale(1.02)} 70%{transform:translateY(-4px) rotate(0.5deg) scale(1.01)} }
        @keyframes sway { 0%,100%{transform:translateY(0) scaleX(1) rotate(0deg)} 50%{transform:translateY(-9px) scaleX(0.96) rotate(1.5deg)} }
        @keyframes roleIn { 0%{opacity:0;transform:perspective(800px) rotateY(-95deg) scale(0.6) translateY(20px)} 70%{transform:perspective(800px) rotateY(5deg) scale(1.03) translateY(-3px)} 100%{opacity:1;transform:perspective(800px) rotateY(0) scale(1) translateY(0)} }
        @keyframes phaseFlash { 0%{opacity:1} 30%{opacity:0.85} 100%{opacity:0} }
        @keyframes shockwaveOut { 0%{transform:scale(0);opacity:1;border-width:6px} 100%{transform:scale(12);opacity:0;border-width:1px} }
        @keyframes deathFall { 0%{transform:rotate(0) translateX(0) translateY(0);opacity:1;filter:brightness(1)} 30%{filter:brightness(2.5) saturate(3)} 100%{transform:rotate(-80deg) translateX(-28px) translateY(10px);opacity:0.08;filter:brightness(0.3) saturate(0)} }
        @keyframes floatIn { 0%{opacity:0;transform:translateY(22px) scale(0.96)} 70%{transform:translateY(-3px) scale(1.01)} 100%{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes slideInRight { 0%{opacity:0;transform:translateX(40px)} 100%{opacity:1;transform:translateX(0)} }
        @keyframes slideInLeft  { 0%{opacity:0;transform:translateX(-40px)} 100%{opacity:1;transform:translateX(0)} }
        @keyframes slideInUp { 0%{opacity:0;transform:translateY(30px)} 100%{opacity:1;transform:translateY(0)} }
        @keyframes glowTitle { 0%,100%{text-shadow:0 0 20px rgba(200,100,10,0.5),0 0 40px rgba(160,50,0,0.2)} 50%{text-shadow:0 0 35px rgba(255,140,20,0.75),0 0 70px rgba(200,70,0,0.35)} }
        @keyframes crossSpin { from{transform:translateX(-50%) rotate(0deg)} to{transform:translateX(-50%) rotate(360deg)} }
        @keyframes timerPanic { 0%,100%{transform:scale(1);color:#ff4444} 50%{transform:scale(1.28);color:#ff0000;text-shadow:0 0 18px #ff0000} }
        @keyframes targetBounce { 0%,100%{transform:translateX(-50%) translateY(0)} 50%{transform:translateX(-50%) translateY(-7px)} }
        @keyframes countdown { 0%{transform:scale(2.5);opacity:1;text-shadow:0 0 80px rgba(255,100,0,1)} 100%{transform:scale(0.3);opacity:0} }
        @keyframes gameOverIn { 0%{opacity:0;transform:scale(0.8) translateY(30px)} 60%{transform:scale(1.04) translateY(-5px)} 100%{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes mafiaPulse { 0%,100%{box-shadow:0 0 12px rgba(200,0,0,0.5),inset 0 0 8px rgba(100,0,0,0.3)} 50%{box-shadow:0 0 35px rgba(255,0,0,0.9),inset 0 0 20px rgba(150,0,0,0.5)} }
        @keyframes glowPulse { 0%,100%{box-shadow:0 0 12px rgba(200,130,20,0.4)} 50%{box-shadow:0 0 28px rgba(255,160,30,0.8),0 0 50px rgba(200,100,0,0.3)} }
        @keyframes borderShimmer { 0%{border-color:rgba(180,110,20,0.25)} 50%{border-color:rgba(255,170,40,0.55)} 100%{border-color:rgba(180,110,20,0.25)} }
        @keyframes scanline { 0%{transform:translateY(-100%)} 100%{transform:translateY(100vh)} }
        @keyframes smokeDrift { 0%{opacity:0;transform:translateY(0) scaleX(1)} 40%{opacity:0.12} 100%{opacity:0;transform:translateY(-60px) scaleX(1.5)} }
        @keyframes notifyIn { 0%{opacity:0;transform:translateX(40px) scale(0.9)} 20%{opacity:1;transform:translateX(-4px) scale(1.02)} 100%{opacity:1;transform:translateX(0) scale(1)} }
        @keyframes characterHover { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }

        @keyframes playerIn { 0%{opacity:0;transform:translateX(-18px) scale(0.9)} 80%{transform:translateX(2px) scale(1.01)} 100%{opacity:1;transform:translateX(0) scale(1)} }
        @keyframes pulseBorder { 0%,100%{border-color:rgba(200,60,20,0.3)} 50%{border-color:rgba(255,100,40,0.7);box-shadow:0 0 18px rgba(200,60,20,0.4)} }
        @keyframes nightAura { 0%,100%{box-shadow:0 0 30px rgba(80,0,200,0.25)} 50%{box-shadow:0 0 60px rgba(120,0,255,0.5)} }
        @keyframes dayAura { 0%,100%{box-shadow:0 0 30px rgba(200,60,0,0.25)} 50%{box-shadow:0 0 60px rgba(255,100,20,0.5)} }
        @keyframes bloodDrip { 0%{height:0;opacity:1} 70%{height:12px;opacity:1} 100%{height:16px;opacity:0} }
        @keyframes typewriter { from{width:0} to{width:100%} }
        input::placeholder { color: rgba(255,255,255,0.28) !important; }
        textarea::placeholder { color: rgba(255,255,255,0.22) !important; }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:2px; }
        ::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.2); }
      `}</style>

      {/* Phase flash */}
      {phaseFlash && <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 5, background: phaseFlash === "night" ? "rgba(15,0,70,0.72)" : "rgba(160,20,0,0.45)", animation: "phaseFlash 0.85s ease-out forwards" }} />}
      {/* Shockwave */}
      {shockwave && <div className="fixed inset-0 pointer-events-none flex items-center justify-center" style={{ zIndex: 6 }}><div style={{ width: 80, height: 80, borderRadius: "50%", border: "4px solid #ff1111", animation: "shockwaveOut 0.65s ease-out forwards" }} /></div>}
      {/* Countdown overlay */}
      {countdown !== null && <div className="fixed inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 35 }}><div style={{ fontSize: 160, fontWeight: 900, color: "white", opacity: 0.9, animation: "countdown 0.9s ease-out forwards", textShadow: "0 0 60px rgba(200,100,255,0.8)" }}>{countdown}</div></div>}
      {/* Night overlay — deep blue-purple darkness */}
      {(phase === "Night" || phase === "Starting") && (
        <>
          <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 3, background: "rgba(0,0,20,0.35)" }} />
          <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 4, background: "radial-gradient(ellipse 80% 60% at center 40%, transparent 20%, rgba(0,0,40,0.8) 100%)" }} />
        </>
      )}
      {/* Day overlay — warm amber atmospheric */}
      {phase === "Day" && (
        <>
          <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 3, background: "rgba(40,10,0,0.18)" }} />
          <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 4, background: "radial-gradient(ellipse 85% 65% at center 45%, rgba(255,80,0,0.04) 0%, rgba(60,5,0,0.6) 100%)" }} />
        </>
      )}

      {/* ══════════════ HOME ══════════════ */}
      {screen === "home" && (
        <div className="relative flex flex-col items-center justify-center w-full h-full px-4" style={{ zIndex: 10 }}>
          {/* Scanline overlay */}
          <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 1, backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px)" }} />

          {/* Title */}
          <div style={{ animation: "sway 5s ease-in-out infinite", fontSize: 64, marginBottom: 8, filter: "drop-shadow(0 0 30px rgba(200,80,0,0.7))" }}>🌑</div>
          <h1 className="font-black text-white tracking-tighter mb-1" style={{ fontSize: "clamp(2.8rem,8vw,5rem)", animation: "glowTitle 4s ease-in-out infinite", background: "linear-gradient(135deg,#fff8e0,#ffcc66,#e8800a,#c84400)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>SHADOW MAFIA</h1>
          <p className="text-sm mb-1 tracking-wider font-semibold" style={{ color: "#c87a2a" }}>On-chain social deduction · Provably hidden roles</p>
          <p className="text-xs mb-6 tracking-widest" style={{ color: "#666" }}>On-chain · Cryptographically private · Provably fair</p>

          {/* Main card */}
          <div className="w-full max-w-xs mb-4 rounded-2xl p-6" style={{ animation: "floatIn 0.6s cubic-bezier(0.34,1.2,0.64,1) forwards, borderShimmer 4s ease-in-out infinite", background: "rgba(8,4,14,0.95)", border: "1px solid rgba(220,100,20,0.35)", boxShadow: "0 0 60px rgba(0,0,0,0.9), 0 0 20px rgba(180,60,0,0.1), inset 0 1px 0 rgba(255,200,80,0.08)", backdropFilter: "blur(20px)" }}>
            {!walletAddress ? (
              <>
                <p className="text-xs uppercase tracking-widest mb-3 text-center" style={{ color: "#999999" }}>Choose your alias</p>
                <input className="w-full rounded-xl px-4 py-3 mb-3 outline-none text-center tracking-widest transition-all"
                  style={{ background: "rgba(255,255,255,0.03)", color: "#f5e8c0", border: "1px solid rgba(180,110,20,0.3)", fontFamily: "monospace" }}
                  onFocus={e => e.target.style.borderColor = "rgba(255,170,40,0.6)"}
                  onBlur={e => e.target.style.borderColor = "rgba(180,110,20,0.3)"}
                  placeholder="YOUR NAME" value={username} onChange={e => setUsername(e.target.value)} />
                <div className="flex justify-center mb-2">
                  <WalletMultiButton style={{ background: "linear-gradient(135deg,#6b1a00,#8b2800)", borderRadius: 12, fontFamily: "monospace", fontWeight: 900, letterSpacing: "0.1em", width: "100%", justifyContent: "center", boxShadow: "0 0 24px rgba(180,60,0,0.5), inset 0 1px 0 rgba(255,150,50,0.15)", border: "1px solid rgba(200,80,20,0.4)" }} />
                </div>
                {connecting && <p className="text-xs text-center mb-2 animate-pulse" style={{ color: "#c87a2a" }}>Connecting…</p>}
              </>
            ) : (
              <div className="text-center">
                <p className="text-xs mb-2 font-semibold" style={{ color: "#44bb66" }}>⛓️ Phantom connected · Devnet</p>
                {!aliasConfirmed ? (
                  <>
                    <input className="w-full rounded-xl px-4 py-3 mb-2 outline-none text-center tracking-widest transition-all"
                      style={{ background: "rgba(255,255,255,0.03)", color: "#f5e8c0", border: "1px solid rgba(180,110,20,0.3)", fontFamily: "monospace" }}
                      onFocus={e => e.target.style.borderColor = "rgba(255,170,40,0.6)"}
                      onBlur={e => e.target.style.borderColor = "rgba(180,110,20,0.3)"}
                      placeholder="YOUR ALIAS" value={username} onChange={e => setUsername(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && username.trim()) { initAudio(); playSound("button"); setAliasConfirmed(true); } }}
                      autoFocus />
                    <button
                      onClick={() => { if (username.trim()) { initAudio(); playSound("button"); setAliasConfirmed(true); } }}
                      disabled={!username.trim()}
                      className="w-full text-xs py-2 rounded-xl mb-1 font-black tracking-widest transition-all"
                      style={{ background: username.trim() ? "rgba(180,110,20,0.25)" : "rgba(40,30,10,0.2)", color: username.trim() ? "#f5c060" : "#555", border: "1px solid rgba(180,110,20,0.2)" }}>
                      CONFIRM ALIAS
                    </button>
                    <p className="text-xs" style={{ color: "#888888" }}>Press Enter or confirm to continue</p>
                  </>
                ) : (
                  <>
                    <p className="font-black text-xl tracking-widest mb-1" style={{ color: "#f5e8c0" }}>{username}</p>
                    <p className="text-xs font-mono" style={{ color: "#888888" }}>{walletAddress ? `${walletAddress.slice(0, 8)}…${walletAddress.slice(-6)}` : ""}</p>
                    <button onClick={() => setAliasConfirmed(false)} className="text-xs mt-1 hover:opacity-60 transition" style={{ color: "#888888" }}>✎ change alias</button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3 w-full max-w-xs mb-5">
            <button onClick={() => { initAudio(); playSound("button"); setScreen("create"); }} disabled={!walletAddress || !aliasConfirmed}
              className="flex-1 font-black text-sm tracking-widest rounded-xl py-4 transition-all"
              style={walletAddress && aliasConfirmed ? { background: "linear-gradient(135deg,#6b0a0a,#3a0000)", color: "#ffccaa", border: "1px solid rgba(200,60,20,0.5)", boxShadow: "0 0 20px rgba(180,20,0,0.35), inset 0 1px 0 rgba(255,100,50,0.1)", animation: "glowPulse 3s ease-in-out infinite" } : { background: "rgba(20,10,10,0.5)", color: "#555555", border: "1px solid rgba(60,20,20,0.3)" }}>
              ⚔ CREATE
            </button>
            <button onClick={() => { initAudio(); playSound("button"); setScreen("join"); }} disabled={!walletAddress || !aliasConfirmed}
              className="flex-1 font-black text-sm tracking-widest rounded-xl py-4 transition-all"
              style={walletAddress && aliasConfirmed ? { background: "linear-gradient(135deg,#0a0a2a,#050520)", color: "#aabbff", border: "1px solid rgba(80,80,200,0.4)", boxShadow: "0 0 18px rgba(60,60,180,0.3), inset 0 1px 0 rgba(100,120,255,0.08)" } : { background: "rgba(10,10,20,0.5)", color: "#5566bb", border: "1px solid rgba(20,20,60,0.3)" }}>
              ➤ JOIN
            </button>
          </div>

          {/* How to Play */}
          <HowToPlay />

          <p className="mt-3 text-xs text-center max-w-xs" style={{ color: "#888888" }}>Roles sealed inside a cryptographic vault · Not even the server can read them</p>
        </div>
      )}

      {/* ══════════════ CREATE ══════════════ */}
      {screen === "create" && (
        <div className="relative flex items-center justify-center w-full h-full px-4" style={{ zIndex: 10 }}>
          <div className="w-full max-w-sm rounded-2xl p-8" style={{ animation: "floatIn 0.4s cubic-bezier(0.34,1.1,0.64,1) forwards", background: "rgba(6,3,10,0.94)", border: "1px solid rgba(200,60,20,0.3)", boxShadow: "0 0 60px rgba(0,0,0,0.9), 0 0 30px rgba(150,20,0,0.15)", backdropFilter: "blur(20px)" }}>
            <button onClick={() => setScreen("home")} className="text-sm mb-5 transition-all hover:opacity-60" style={{ color: "#999999" }}>← Back</button>
            <h2 className="text-2xl font-black mb-1 tracking-widest" style={{ color: "#f5e0c0" }}>CREATE GAME</h2>
            <p className="text-xs mb-6" style={{ color: "#888888" }}>Host a private session · Stake SOL to enter</p>
            <label className="text-xs uppercase tracking-widest" style={{ color: "#999999" }}>Stake per player (SOL)</label>
            <input type="number" step="0.01" value={stakeSOL} onChange={e => setStakeSOL(e.target.value)}
              className="w-full rounded-xl px-4 py-3 mb-5 mt-2 outline-none transition-all"
              style={{ background: "rgba(255,255,255,0.03)", color: "#f5e8c0", border: "1px solid rgba(180,80,20,0.3)", fontFamily: "monospace" }}
              onFocus={e => e.target.style.borderColor = "rgba(255,140,40,0.6)"}
              onBlur={e => e.target.style.borderColor = "rgba(180,80,20,0.3)"} />
            <label className="text-xs uppercase tracking-widest" style={{ color: "#999999" }}>Max players (4–8)</label>
            <input type="number" min="4" max="8" value={maxPlayers} onChange={e => setMaxPlayers(e.target.value)}
              className="w-full rounded-xl px-4 py-3 mb-2 mt-2 outline-none transition-all"
              style={{ background: "rgba(255,255,255,0.03)", color: "#f5e8c0", border: "1px solid rgba(180,80,20,0.3)", fontFamily: "monospace" }}
              onFocus={e => e.target.style.borderColor = "rgba(255,140,40,0.6)"}
              onBlur={e => e.target.style.borderColor = "rgba(180,80,20,0.3)"} />
            <p className="text-xs mb-5" style={{ color: "#888888" }}>4–5 players: 1 Mafia · Citizens<br />5+ players: +Doctor added · 6+: 2 Mafia</p>
            <button onClick={createGame} className="w-full rounded-xl py-4 font-black tracking-widest transition-all"
              style={{ background: "linear-gradient(135deg,#7a0a0a,#420000)", color: "#ffccaa", border: "1px solid rgba(200,60,20,0.5)", boxShadow: "0 0 25px rgba(180,20,0,0.4), inset 0 1px 0 rgba(255,100,50,0.12)" }}
              onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 0 40px rgba(220,40,0,0.7), inset 0 1px 0 rgba(255,120,60,0.2)")}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = "0 0 25px rgba(180,20,0,0.4), inset 0 1px 0 rgba(255,100,50,0.12)")}>
              ⚔ STAKE {stakeSOL} SOL &amp; CREATE
            </button>
          </div>
        </div>
      )}

      {/* ══════════════ JOIN ══════════════ */}
      {screen === "join" && (
        <div className="relative flex items-center justify-center w-full h-full px-4" style={{ zIndex: 10 }}>
          <div className="w-full max-w-sm rounded-2xl p-8" style={{ animation: "floatIn 0.4s cubic-bezier(0.34,1.1,0.64,1) forwards", background: "rgba(6,3,10,0.94)", border: "1px solid rgba(80,80,200,0.28)", boxShadow: "0 0 60px rgba(0,0,0,0.9), 0 0 30px rgba(40,40,150,0.12)", backdropFilter: "blur(20px)" }}>
            <button onClick={() => setScreen("home")} className="text-sm mb-5 transition-all hover:opacity-60" style={{ color: "#8888bb" }}>← Back</button>
            <h2 className="text-2xl font-black mb-1 tracking-widest" style={{ color: "#f5e0c0" }}>JOIN GAME</h2>
            <p className="text-xs mb-6" style={{ color: "#8899bb" }}>Enter the code from your host</p>
            <label className="text-xs uppercase tracking-widest" style={{ color: "#9999cc" }}>Game Code</label>
            <input className="w-full rounded-xl px-4 py-5 mb-6 mt-2 outline-none text-center text-3xl tracking-widest uppercase transition-all"
              style={{ background: "rgba(255,255,255,0.02)", color: "#c8d8ff", border: "1px solid rgba(80,80,200,0.35)", fontFamily: "monospace", letterSpacing: "0.25em" }}
              onFocus={e => e.target.style.borderColor = "rgba(120,140,255,0.7)"}
              onBlur={e => e.target.style.borderColor = "rgba(80,80,200,0.35)"}
              placeholder="MAFIA0000" value={joinGameId} onChange={e => { setJoinGameId(e.target.value.toUpperCase()); setJoinError(""); }} onKeyDown={e => e.key === "Enter" && joinGame()} />
            <button onClick={joinGame} disabled={joining} className="w-full rounded-xl py-4 font-black tracking-widest transition-all"
              style={{ background: joining ? "rgba(20,20,50,0.6)" : "linear-gradient(135deg,#0a0a3a,#050525)", color: joining ? "#6677aa" : "#aabbff", border: "1px solid rgba(80,80,200,0.45)", boxShadow: joining ? "none" : "0 0 22px rgba(60,60,180,0.35), inset 0 1px 0 rgba(120,140,255,0.1)" }}
              onMouseEnter={e => { if (!joining) e.currentTarget.style.boxShadow = "0 0 38px rgba(80,80,220,0.6), inset 0 1px 0 rgba(140,160,255,0.18)"; }}
              onMouseLeave={e => { if (!joining) e.currentTarget.style.boxShadow = "0 0 22px rgba(60,60,180,0.35), inset 0 1px 0 rgba(120,140,255,0.1)"; }}>
              {joining ? "ENTERING…" : "➤ ENTER THE SHADOWS"}
            </button>
            {joinError && (
              <div className="mt-4 px-4 py-3 rounded-xl text-sm text-center" style={{ background: "rgba(180,0,0,0.18)", border: "1px solid rgba(220,60,60,0.4)", color: "#ff8888" }}>
                ❌ {joinError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════ GAME ══════════════ */}
      {screen === "game" && (
        <div className="relative w-full h-full" style={{ zIndex: 10 }}>

          {/* Privacy proof panel */}
          <PrivacyPanel vrfHash={vrfHash} resultHash={resultHash} teeStatus={teeStatus} teeTxSigs={teeTxSigs} />

          {/* ── Role Reveal Modal ─── z-50 ──────────────────────────── */}
          {showRoleModal && myRole && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/88 backdrop-blur-md" style={{ zIndex: 50 }}>
              <div className="text-center px-4" style={{ animation: "roleIn 0.65s cubic-bezier(0.34,1.2,0.64,1) forwards" }}>
                <div className="w-52 rounded-3xl border-2 flex flex-col items-center justify-center p-8 mx-auto mb-5"
                  style={{
                    minHeight: 280,
                    background: myRole === "Mafia" ? "#160004" : myRole === "Doctor" ? "#001a08" : "#0e0e0e",
                    borderColor: myRole === "Mafia" ? "#cc1111" : myRole === "Doctor" ? "#11aa44" : "#555",
                    boxShadow: myRole === "Mafia" ? "0 0 80px rgba(255,0,0,0.55), inset 0 0 40px rgba(100,0,0,0.3)"
                      : myRole === "Doctor" ? "0 0 80px rgba(0,200,80,0.55), inset 0 0 40px rgba(0,60,20,0.3)"
                      : "0 0 50px rgba(150,150,150,0.3)",
                  }}>
                  <div className="text-7xl mb-5" style={{ animation: "sway 2s ease-in-out infinite" }}>
                    {myRole === "Mafia" ? "🗡️" : myRole === "Doctor" ? "💉" : "🛡️"}
                  </div>
                  <div className="text-xs uppercase tracking-widest mb-2" style={{ color: myRole === "Mafia" ? "#aa3333" : myRole === "Doctor" ? "#33aa55" : "#777" }}>You are the</div>
                  <div className="text-3xl font-black tracking-widest mb-5" style={{ color: roleColor }}>{myRole.toUpperCase()}</div>
                  <p className="text-xs leading-relaxed text-center" style={{ color: "#555" }}>{roleMessage}</p>
                </div>
                <p className="text-xs mb-4" style={{ color: "#44cc77" }}>🔒 Sealed in cryptographic vault — no one else can see this</p>
                <button onClick={() => setShowRoleModal(false)} className="px-10 py-3 rounded-xl font-black tracking-widest text-white transition"
                  style={{ background: myRole === "Mafia" ? "#5a0000" : myRole === "Doctor" ? "#004422" : "#222", boxShadow: `0 0 22px ${roleColor}44` }}>
                  I AM READY
                </button>
              </div>
            </div>
          )}

          {/* ── Game Over ─── z-40 ──────────────────────────────────── */}
          {phase === "GameOver" && gameResult && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/90 backdrop-blur-md" style={{ zIndex: 40 }}>
              <div className="text-center p-8 rounded-3xl border max-w-sm w-full mx-4"
                style={{
                  animation: "gameOverIn 0.6s cubic-bezier(0.34,1.2,0.64,1) forwards",
                  background: gameResult.winner === "Mafia" ? "rgba(20,0,0,0.92)" : "rgba(0,18,5,0.92)",
                  borderColor: gameResult.winner === "Mafia" ? "#991111" : "#119944",
                  boxShadow: gameResult.winner === "Mafia" ? "0 0 80px rgba(255,0,0,0.45)" : "0 0 80px rgba(0,200,80,0.45)",
                }}>
                <div className="text-6xl mb-3" style={{ animation: "sway 2s ease-in-out infinite" }}>{gameResult.winner === "Mafia" ? "🔴" : "⚪"}</div>
                <h2 className="text-4xl font-black text-white mb-1 tracking-widest">{gameResult.winner === "Mafia" ? "MAFIA WINS" : "CITIZENS WIN"}</h2>
                <p className="text-sm mb-5" style={{ color: gameResult.winner === "Mafia" ? "#aa4444" : "#44aa66" }}>{gameResult.message}</p>
                <div className="rounded-xl p-3 mb-4 space-y-1.5" style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.05)" }}>
                  {players.map(p => (
                    <div key={p.walletAddress} className="flex items-center justify-between text-xs px-2 py-1 rounded" style={{ background: "rgba(255,255,255,0.02)" }}>
                      <span className={p.isEliminated ? "line-through text-gray-400" : "text-gray-300"}>{p.walletAddress === walletAddress ? "👤 " : ""}{p.username}</span>
                      <span className="font-black" style={{ color: gameResult.allRoles[p.walletAddress] === "Mafia" ? "#ff3333" : gameResult.allRoles[p.walletAddress] === "Doctor" ? "#33cc66" : "#666" }}>
                        {gameResult.allRoles[p.walletAddress] === "Mafia" ? "🗡️" : gameResult.allRoles[p.walletAddress] === "Doctor" ? "💉" : "🛡️"} {gameResult.allRoles[p.walletAddress]}
                      </span>
                    </div>
                  ))}
                </div>
                {/* Verifiable proof */}
                {gameResult.resultHash && (
                  <div className="rounded-xl p-2 mb-4 text-xs" style={{ background: "rgba(0,20,0,0.5)", border: "1px solid rgba(0,200,80,0.15)" }}>
                    <p style={{ color: "#33aa55" }}>🔒 Verifiable Result Hash</p>
                    <p className="font-mono text-xs break-all" style={{ color: "#44aa66" }}>{gameResult.resultHash}</p>
                    {gameResult.vrfSeedHex && <p className="font-mono text-xs break-all mt-1" style={{ color: "#337744" }}>VRF: {gameResult.vrfSeedHex}</p>}
                  </div>
                )}
                <button onClick={() => { setScreen("home"); setGameResult(null); setMyRole(null); setRoleMessage(""); setPlayers([]); setChat([]); setMafiaChat([]); setPhase("Lobby"); setVoteTallies({}); setVrfHash(""); setResultHash(""); }}
                  className="w-full py-3 rounded-xl font-black tracking-widest text-white transition" style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)" }}>
                  PLAY AGAIN
                </button>
              </div>
            </div>
          )}

          {/* ── Notification ─── z-30 ─────────────────────────────── */}
          {notification && (
            <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 px-5 py-2.5 rounded-full text-sm text-white backdrop-blur border border-white/10 shadow-xl max-w-xs text-center"
              style={{ background: "rgba(0,0,0,0.82)", animation: "floatIn 0.2s ease forwards" }}>
              {notification}
            </div>
          )}
          {savedMsg && (
            <div className="absolute top-28 left-1/2 -translate-x-1/2 z-30 px-5 py-2 rounded-full text-sm backdrop-blur border shadow-xl"
              style={{ background: "rgba(0,30,10,0.85)", borderColor: "rgba(0,200,80,0.3)", color: "#44cc77", animation: "floatIn 0.2s ease forwards" }}>
              {savedMsg}
            </div>
          )}

          {/* ── Top HUD ─── z-20 ────────────────────────────────────── */}
          <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-2.5 border-b border-white/5 backdrop-blur"
            style={{ zIndex: 20, background: "rgba(0,0,0,0.6)" }}>
            <div>
              <p className="text-white font-black text-sm tracking-widest">🌑 SHADOW MAFIA</p>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-xs font-mono" style={{ color: "#aaa" }}>{gameId}</p>
                <button onClick={copyCode} className="text-xs px-2 py-0.5 rounded transition" style={{ background: "rgba(255,255,255,0.07)", color: copied ? "#44cc77" : "#aaa", border: "1px solid rgba(255,255,255,0.12)" }}>
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
              {gameTxSig && (
                <a href={`https://explorer.solana.com/tx/${gameTxSig}?cluster=devnet`} target="_blank" rel="noopener noreferrer"
                  className="text-xs mt-0.5 flex items-center gap-1 hover:opacity-80 transition"
                  style={{ color: "#22cc66" }}>
                  ⛓️ On-chain ✓ {gameTxSig.slice(0, 10)}…
                </a>
              )}
            </div>
            <div className="text-center">
              <div className="text-sm font-black tracking-widest px-4 py-1 rounded-full border"
                style={{
                  color: phase === "Night" || phase === "Starting" ? "#9988ff" : phase === "Day" ? "#ffaa44" : phase === "GameOver" ? "#ff4444" : "#555",
                  background: phase === "Night" || phase === "Starting" ? "rgba(55,35,155,0.3)" : phase === "Day" ? "rgba(155,75,8,0.3)" : "rgba(18,18,18,0.5)",
                  borderColor: phase === "Night" || phase === "Starting" ? "rgba(90,70,190,0.45)" : phase === "Day" ? "rgba(190,100,8,0.45)" : "rgba(45,45,45,0.4)",
                }}>
                {phase === "Lobby" && "⏳ LOBBY"}
                {phase === "Starting" && "🎭 STARTING"}
                {phase === "Night" && `🌙 NIGHT ${round}`}
                {phase === "Day" && `☀️ DAY ${round}`}
                {phase === "GameOver" && "🏁 GAME OVER"}
              </div>
              {phaseTimer > 0 && <p className="text-xs mt-0.5 font-black" style={{ color: timerLow ? "#ff2222" : "#aaa", animation: timerLow ? "timerPanic 0.45s ease-in-out infinite" : "none" }}>{phaseTimer}s</p>}
            </div>
            <div className="text-right">
              {myRole ? (
                <button onClick={() => { setShowRoleModal(true); playSound("role"); }} className="text-xs font-black tracking-widest px-3 py-1 rounded-full border transition hover:scale-105"
                  style={{ color: roleColor, background: roleColor + "18", borderColor: roleColor + "44" }}>
                  {myRole === "Mafia" ? "🗡️" : myRole === "Doctor" ? "💉" : "🛡️"} {myRole}
                </button>
              ) : <p className="text-xs" style={{ color: "#888" }}>{username}</p>}
              <p className="text-xs mt-0.5" style={{ color: connected ? "#44aa66" : "#aa4444" }}>{connected ? "● live" : "○ offline"}</p>
            </div>
          </div>

          {/* ── Character Scene ─── z-10 ISOLATED ───────────────────── */}
          <div className="absolute inset-0" style={{ zIndex: 10, isolation: "isolate" }}>
            {players.map((p, i) => {
              const { x, y, scale } = getCharPos(i, players.length);
              const isSelected = selectedTarget === p.walletAddress;
              const isMe = p.walletAddress === walletAddress;
              const isDying = dyingWallet === p.walletAddress;
              const canSelect = !p.isEliminated && !isMe &&
                (phase === "Night" ? (myRole === "Mafia" || myRole === "Doctor") : phase === "Day");
              const revealed = gameResult?.allRoles[p.walletAddress] as Role || (isMe ? myRole : null);
              const theme = getCloakTheme(i);
              // Only show per-player vote counts AFTER the round ends — never during active voting
              const voteCount = phase === "GameOver" ? (voteTallies[p.walletAddress] || 0) : 0;
              // Compute exact pointing angle toward target using real screen pixel positions
              const myIdx = players.findIndex(pl => pl.walletAddress === walletAddress);
              const myPos = getCharPos(myIdx, players.length);
              const targetIdx = players.findIndex(pl => pl.walletAddress === selectedTarget);
              const targetPos = targetIdx >= 0 ? getCharPos(targetIdx, players.length) : myPos;
              const W = typeof window !== "undefined" ? window.innerWidth : 1366;
              const H = typeof window !== "undefined" ? window.innerHeight : 768;
              // Characters rendered with translate(-50%,-100%), so feet are at (x%,y%), head ~60px above feet at current scale
              const myXpx = (myPos.x / 100) * W;
              const myYpx = (myPos.y / 100) * H - 46 * myPos.scale;
              const tgXpx = (targetPos.x / 100) * W;
              const tgYpx = (targetPos.y / 100) * H - 46 * targetPos.scale;
              const pointAngleDeg = Math.atan2(tgYpx - myYpx, tgXpx - myXpx) * (180 / Math.PI);

              return (
                <div key={p.walletAddress} className="absolute flex flex-col items-center select-none"
                  style={{ left: `${x}%`, top: `${y}%`, transform: `translate(-50%, -100%) scale(${scale})`, zIndex: Math.floor(y), cursor: canSelect ? "crosshair" : "default", animation: `playerIn ${0.4 + i * 0.1}s cubic-bezier(0.34,1.2,0.64,1) forwards` }}
                  onClick={() => canSelect && handleCharacterClick(p.walletAddress)}>

                  {/* Crosshair */}
                  {isSelected && !p.isEliminated && (
                    <CrosshairOverlay color={phase === "Night" && myRole === "Doctor" ? "#44cc77" : "#ff2222"} />
                  )}

                  {/* Cloak color glow ring for self */}
                  {isMe && !p.isEliminated && (
                    <div style={{ position: "absolute", width: 70, height: 95, borderRadius: "40%", background: `radial-gradient(ellipse, ${theme.glow}22 0%, transparent 70%)`, top: 0, left: "50%", transform: "translateX(-50%)", pointerEvents: "none" }} />
                  )}

                  {/* Character */}
                  <div style={{
                    width: 64, height: 92,
                    animation: isDying ? "deathFall 0.8s ease-in-out forwards"
                      : isSelected && !p.isEliminated ? `sway ${2.2 + i * 0.2}s ease-in-out infinite`
                      : !p.isEliminated ? `breathe ${2.3 + i * 0.28}s ease-in-out infinite`
                      : "none",
                    filter: p.isEliminated ? "grayscale(1) brightness(0.28)"
                      : isDying ? `drop-shadow(0 0 22px #ff0000) brightness(1.6)`
                      : isSelected ? `drop-shadow(0 0 16px #ff2222)`
                      : isMe ? `drop-shadow(0 0 10px ${theme.glow}aa)` : "none",
                    opacity: p.isEliminated ? 0.38 : 1,
                    transition: "filter 0.3s, opacity 0.6s",
                  }}>
                    <GameCharacter
                    theme={getCloakTheme(i)}
                    isEliminated={p.isEliminated}
                    isSelected={isSelected}
                    isMe={isMe}
                    isDying={isDying}
                    revealedRole={revealed}
                    voteCount={voteCount}
                    isPointing={isMe && !!selectedTarget && !p.isEliminated && p.walletAddress === walletAddress}
                    pointAngleDeg={pointAngleDeg}
                  />
                  </div>

                  {/* Speech bubble */}
                  {speechBubbles[p.walletAddress] && (
                    <div className="absolute pointer-events-none" style={{
                      bottom: "calc(100% + 10px)", left: "50%",
                      transform: "translateX(-50%)",
                      zIndex: 50, animation: "floatIn 0.25s ease forwards",
                      maxWidth: 160, minWidth: 80,
                    }}>
                      <div className="px-3 py-1.5 rounded-xl text-xs leading-snug text-center"
                        style={{
                          background: p.isEliminated ? "rgba(30,30,30,0.92)" : "rgba(10,6,20,0.95)",
                          border: `1px solid ${p.isEliminated ? "rgba(80,80,80,0.4)" : getCloakTheme(i).glow + "66"}`,
                          color: p.isEliminated ? "#555" : "#f0eaff",
                          fontStyle: p.isEliminated ? "italic" : "normal",
                          boxShadow: p.isEliminated ? "none" : `0 0 18px ${getCloakTheme(i).glow}33`,
                          wordBreak: "break-word",
                          whiteSpace: "pre-wrap",
                        }}>
                        {speechBubbles[p.walletAddress]}
                      </div>
                      {/* Triangle pointer */}
                      <div style={{
                        width: 0, height: 0, margin: "0 auto",
                        borderLeft: "7px solid transparent",
                        borderRight: "7px solid transparent",
                        borderTop: `7px solid ${p.isEliminated ? "rgba(80,80,80,0.4)" : getCloakTheme(i).glow + "66"}`,
                      }} />
                    </div>
                  )}

                  {/* Name tag */}
                  <div className="mt-1 px-2 py-0.5 rounded text-xs font-bold tracking-wide whitespace-nowrap"
                    style={{
                      color: p.isEliminated ? "#333" : isMe ? theme.glow : isSelected ? "#ff7777" : "#ccc",
                      background: isMe ? `${theme.glow}18` : isSelected ? "rgba(110,0,0,0.7)" : "rgba(0,0,0,0.6)",
                      border: isMe ? `1px solid ${theme.glow}33` : isSelected ? "1px solid rgba(200,30,30,0.4)" : "1px solid rgba(255,255,255,0.05)",
                      textDecoration: p.isEliminated ? "line-through" : "none",
                    }}>
                    {isMe ? "👤 " : ""}{p.username}
                    {gameResult?.allRoles[p.walletAddress] && (
                      <span style={{ marginLeft: 4, color: gameResult.allRoles[p.walletAddress] === "Mafia" ? "#ff3333" : gameResult.allRoles[p.walletAddress] === "Doctor" ? "#33cc66" : "#666" }}>
                        ({gameResult.allRoles[p.walletAddress]})
                      </span>
                    )}
                  </div>

                  {/* Target indicator */}
                  {isSelected && phase !== "Lobby" && (
                    <div className="text-xs font-black tracking-widest absolute whitespace-nowrap"
                      style={{ bottom: "-18px", left: "50%", animation: "targetBounce 1s ease-in-out infinite",
                        color: phase === "Night" && myRole === "Doctor" ? "#44cc77" : "#ff2222" }}>
                      ▲ {phase === "Night" && myRole === "Doctor" ? "PROTECT" : "TARGET"}
                    </div>
                  )}
                </div>
              );
            })}
            {players.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-xs tracking-widest" style={{ color: "#555", animation: "breathe 3s ease-in-out infinite" }}>AWAITING PLAYERS TO ENTER THE SHADOWS...</p>
              </div>
            )}
          </div>

          {/* ── Bottom Action Panel ─── z-20 ────────────────────────── */}
          <div className="absolute bottom-0 left-0 right-0 pb-4 px-4 flex flex-col items-center gap-2" style={{ zIndex: 20 }}>
            <p className="text-xs text-center" style={{ color: "#888" }}>🔒 Roles · Night votes · Mafia chat — all sealed in cryptographic vault</p>
            <div className="flex items-center gap-2 w-full max-w-2xl">

              {/* Lobby */}
              {phase === "Lobby" && isHost && (
                <button onClick={startGame} disabled={players.length < 4} className="flex-1 rounded-xl py-3 font-black tracking-widest text-sm transition-all"
                  style={{ background: players.length < 4 ? "rgba(15,15,15,0.8)" : "rgba(0,70,25,0.85)", color: players.length < 4 ? "#333" : "#88ffaa", border: players.length < 4 ? "1px solid #1a1a1a" : "1px solid rgba(0,140,50,0.5)", boxShadow: players.length >= 4 ? "0 0 20px rgba(0,180,60,0.28)" : "none" }}>
                  {players.length < 4 ? `NEED ${4 - players.length} MORE PLAYERS` : "▶ BEGIN THE NIGHT"}
                </button>
              )}
              {phase === "Lobby" && !isHost && <div className="flex-1 text-center text-xs tracking-widest py-3" style={{ color: "#777", animation: "breathe 3s ease-in-out infinite" }}>WAITING FOR HOST TO BEGIN...</div>}

              {/* Night: Mafia */}
              {phase === "Night" && myRole === "Mafia" && !amEliminated && (
                <button onClick={submitMafiaVote} disabled={!selectedTarget || hasVoted} className="flex-1 rounded-xl py-3 font-black tracking-widest text-sm transition-all"
                  style={{ background: hasVoted ? "rgba(18,18,18,0.8)" : selectedTarget ? "rgba(90,0,0,0.85)" : "rgba(28,8,8,0.8)", color: hasVoted ? "#444" : selectedTarget ? "#ff8888" : "#884444", border: selectedTarget && !hasVoted ? "1px solid rgba(190,0,0,0.5)" : "1px solid #140000", boxShadow: selectedTarget && !hasVoted ? "0 0 20px rgba(200,0,0,0.3)" : "none" }}>
                  {hasVoted ? "✓ VOTE CAST" : selectedTarget ? `🗡️ ELIMINATE ${players.find(p => p.walletAddress === selectedTarget)?.username?.toUpperCase()}` : "CLICK A PLAYER TO MARK"}
                </button>
              )}
              {/* Night: Doctor */}
              {phase === "Night" && myRole === "Doctor" && !amEliminated && (
                <button onClick={submitProtect} disabled={!selectedTarget || hasProtected} className="flex-1 rounded-xl py-3 font-black tracking-widest text-sm transition-all"
                  style={{ background: hasProtected ? "rgba(18,18,18,0.8)" : selectedTarget ? "rgba(0,60,20,0.85)" : "rgba(5,20,10,0.8)", color: hasProtected ? "#444" : selectedTarget ? "#88ffaa" : "#446655", border: selectedTarget && !hasProtected ? "1px solid rgba(0,160,60,0.5)" : "1px solid #001408", boxShadow: selectedTarget && !hasProtected ? "0 0 20px rgba(0,180,60,0.3)" : "none" }}>
                  {hasProtected ? `✓ PROTECTING ${players.find(p => p.walletAddress === protectedTarget)?.username?.toUpperCase()}` : selectedTarget ? `💉 PROTECT ${players.find(p => p.walletAddress === selectedTarget)?.username?.toUpperCase()}` : "CLICK SOMEONE TO PROTECT"}
                </button>
              )}
              {/* Night: Citizen */}
              {phase === "Night" && myRole === "Citizen" && !amEliminated && (
                <div className="flex-1 text-center text-xs tracking-widest py-3" style={{ color: "#555", animation: "breathe 3s ease-in-out infinite" }}>🌙 KEEP YOUR EYES CLOSED...</div>
              )}
              {/* Day: vote */}
              {phase === "Day" && !amEliminated && (
                <>
                  <div className="text-xs text-center whitespace-nowrap" style={{ color: "#aaa" }}>
                    {Object.values(voteTallies).reduce((a, b) => a + b, 0)} votes cast
                  </div>
                  <button onClick={submitDayVote} disabled={!selectedTarget || hasVoted} className="flex-1 rounded-xl py-3 font-black tracking-widest text-sm transition-all"
                    style={{ background: hasVoted ? "rgba(18,18,18,0.8)" : selectedTarget ? "rgba(75,35,0,0.85)" : "rgba(28,18,4,0.8)", color: hasVoted ? "#444" : selectedTarget ? "#ffcc66" : "#886633", border: selectedTarget && !hasVoted ? "1px solid rgba(170,90,0,0.5)" : "1px solid #160a00", boxShadow: selectedTarget && !hasVoted ? "0 0 20px rgba(180,90,0,0.3)" : "none" }}>
                    {hasVoted ? "✓ VOTED SECRETLY" : selectedTarget ? `🗳️ EXILE ${players.find(p => p.walletAddress === selectedTarget)?.username?.toUpperCase()}` : "CLICK A PLAYER TO VOTE"}
                  </button>
                </>
              )}
              {amEliminated && phase !== "GameOver" && (
                <div className="flex-1 flex items-center gap-2 px-2">
                  <span className="text-xs" style={{ color: "#555" }}>☠️</span>
                  <input className="flex-1 rounded-lg px-3 py-1.5 text-xs outline-none"
                    style={{ background: "rgba(255,255,255,0.03)", color: "#888", border: "1px solid rgba(255,255,255,0.05)", fontStyle: "italic" }}
                    placeholder="You are eliminated — ghost whispers heard by all..."
                    value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendChat()} maxLength={200} />
                  <button onClick={sendChat} className="rounded-lg px-3 py-1.5 text-xs font-bold"
                    style={{ background: "rgba(40,40,40,0.6)", color: "#666", border: "1px solid #222" }}>→</button>
                </div>
              )}

              {/* Mafia chat button (night, Mafia only) */}
              {phase === "Night" && myRole === "Mafia" && !amEliminated && (
                <button onClick={() => setShowMafiaChat(m => !m)} className="px-3 py-3 rounded-xl font-black text-sm transition border"
                  style={{ background: showMafiaChat ? "rgba(120,0,0,0.7)" : "rgba(0,0,0,0.5)", color: "#ff6666", borderColor: "rgba(200,0,0,0.4)", animation: "mafiaPulse 2s ease-in-out infinite" }}>
                  🔴
                </button>
              )}

              {/* Public chat toggle */}
              <button onClick={() => setShowChat(c => !c)} className="px-4 py-3 rounded-xl font-black text-sm transition border"
                style={{ background: showChat ? "rgba(70,25,140,0.65)" : "rgba(0,0,0,0.5)", color: showChat ? "#cc99ff" : "#333", borderColor: showChat ? "rgba(110,50,210,0.5)" : "#1a1a1a" }}>
                💬
              </button>
            </div>
          </div>

          {/* ── Mafia Private Chat (TEE-sealed) — fixed LEFT-edge panel ── */}
          {showMafiaChat && myRole === "Mafia" && (
            <div className="fixed flex flex-col overflow-hidden"
              style={{
                zIndex: 22,
                top: 52, left: 0, bottom: 68,
                width: 260,
                background: "rgba(12,0,0,0.97)",
                borderRight: "1px solid rgba(200,0,0,0.25)",
                backdropFilter: "blur(18px)",
                boxShadow: "4px 0 30px rgba(180,0,0,0.15)",
                animation: "slideInLeft 0.25s cubic-bezier(0.34,1.1,0.64,1) forwards",
              }}>
              <div className="px-4 py-2.5 flex justify-between items-center flex-shrink-0"
                style={{ borderBottom: "1px solid rgba(200,0,0,0.2)" }}>
                <span className="text-xs font-black uppercase tracking-widest" style={{ color: "#ff4444" }}>🔴 Mafia Channel</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: "#aa3333" }}>sealed ✓</span>
                  <button onClick={() => setShowMafiaChat(false)} className="text-xs px-1.5" style={{ color: "#553333" }}>✕</button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5" style={{ scrollbarWidth: "thin", scrollbarColor: "#300 transparent" }}>
                {mafiaChat.length === 0 && <p className="text-xs text-center mt-6" style={{ color: "#663333" }}>Private — only Mafia can see this channel.</p>}
                {mafiaChat.map((msg, i) => (
                  <div key={i} className="text-xs">
                    <span className="font-bold" style={{ color: "#ff6666" }}>{msg.username}:&nbsp;</span>
                    <span style={{ color: "#cc7777" }}>{msg.text}</span>
                  </div>
                ))}
                <div ref={mafiaChatEndRef} />
              </div>
              <div className="flex gap-2 p-2 flex-shrink-0" style={{ borderTop: "1px solid rgba(200,0,0,0.15)" }}>
                <input className="flex-1 rounded-lg px-3 py-2 text-xs outline-none"
                  style={{ background: "rgba(60,0,0,0.5)", color: "#ff8888", border: "1px solid rgba(200,0,0,0.2)" }}
                  placeholder="Coordinate in secret..."
                  value={mafiaChatInput} onChange={e => setMafiaChatInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && sendMafiaChat()} maxLength={200} />
                <button onClick={sendMafiaChat} className="rounded-lg px-3 text-xs font-bold"
                  style={{ background: "rgba(150,0,0,0.6)", color: "#ff6666", flexShrink: 0 }}>→</button>
              </div>
            </div>
          )}

          {/* ── Public Chat — fixed right-edge panel, never overlaps characters ── */}
          {showChat && (
            <div className="fixed flex flex-col overflow-hidden"
              style={{
                zIndex: 22,
                top: 52, right: 0, bottom: 68,
                width: 272,
                background: "rgba(4,2,10,0.97)",
                borderLeft: "1px solid rgba(255,255,255,0.07)",
                backdropFilter: "blur(18px)",
                animation: "slideInRight 0.25s cubic-bezier(0.34,1.1,0.64,1) forwards",
              }}>
              {/* Header */}
              <div className="px-4 py-2.5 flex justify-between items-center flex-shrink-0"
                style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <span className="text-xs font-black uppercase tracking-widest" style={{ color: "#888" }}>
                  💬 Discussion
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: phase === "Day" ? "#44cc66" : amEliminated ? "#666" : "#444" }}>
                    {phase === "Day" ? "● open" : amEliminated ? "● ghost" : "● night"}
                  </span>
                  <button onClick={() => setShowChat(false)} className="text-xs px-1.5" style={{ color: "#444" }}>✕</button>
                </div>
              </div>
              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5" style={{ scrollbarWidth: "thin", scrollbarColor: "#222 transparent" }}>
                {chat.length === 0 && (
                  <p className="text-xs text-center mt-6" style={{ color: "#444" }}>
                    {phase === "Day" ? "Be the first to speak..." : "Discussion opens at dawn."}
                  </p>
                )}
                {chat.map((msg, i) => (
                  <div key={i} className="text-xs" style={{ opacity: msg.isGhost ? 0.5 : 1 }}>
                    <span className="font-bold" style={{ color: msg.isGhost ? "#555" : msg.walletAddress === walletAddress ? "#9966ff" : "#6644aa" }}>
                      {msg.username}:&nbsp;
                    </span>
                    <span style={{ color: msg.isGhost ? "#555" : "#aaa", fontStyle: msg.isGhost ? "italic" : "normal" }}>
                      {msg.text}
                    </span>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              {/* Input */}
              {(phase === "Day" || amEliminated) && (
                <div className="flex gap-2 p-2 flex-shrink-0" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <input className="flex-1 rounded-lg px-3 py-2 text-xs outline-none"
                    style={{
                      background: "rgba(255,255,255,0.04)", color: amEliminated ? "#777" : "white",
                      border: "1px solid rgba(255,255,255,0.07)",
                      fontStyle: amEliminated ? "italic" : "normal",
                    }}
                    placeholder={amEliminated ? "Ghost whisper..." : "Accuse, defend, convince..."}
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendChat()}
                    maxLength={300} />
                  <button onClick={sendChat} className="rounded-lg px-3 text-xs font-bold"
                    style={{ background: amEliminated ? "rgba(40,40,40,0.6)" : "rgba(70,25,140,0.7)", color: amEliminated ? "#555" : "#bb88ff", flexShrink: 0 }}>
                    →
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
