'use client';

import React, { useMemo } from 'react';

// ─── TYPES ──────────────────────────────────────────────────────────────────

type AppPhase = 'setup' | 'connecting' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'ended' | 'report';

interface ThreeDOrbProps {
  phase: AppPhase;
  isAriaSpeaking: boolean;
  volume: number;
  voice?: string;
}

// ─── PALETTES ────────────────────────────────────────────────────────────────

const VOICE_PALETTES: Record<string, string[]> = {
  thalia: ['#ff9a9e', '#fecfef', '#ffecd2', '#fcb69f'],
  orpheus: ['#243949', '#517fa4', '#4facfe', '#00f2fe'],
  atlas: ['#f6d365', '#fda085', '#f093fb', '#f5576c'],
  asteria: ['#e0c3fc', '#8ec5fc', '#43e97b', '#38f9d7'],
};

export const ThreeDOrb: React.FC<ThreeDOrbProps> = ({ phase, isAriaSpeaking, volume, voice = 'thalia' }) => {
  const colors = useMemo(() => {
    return VOICE_PALETTES[voice] || VOICE_PALETTES.thalia;
  }, [voice]);

  // Normalize volume for CSS
  const orbScale = 1 + volume * 0.4;
  const entropy = volume * 20;

  return (
    <div className="premium-2d-container">
      {/* SVG Liquid Filter */}
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          <filter id="liquify">
            <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="2" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale={8 + volume * 25} />
          </filter>
        </defs>
      </svg>

      <div className="orb-canvas" style={{ transform: `scale(${orbScale})` }}>
        {/* Animated Mesh Core */}
        <div className="mesh-gradient">
          {colors.map((color, i) => (
            <div 
              key={i} 
              className={`blob blob-${i % 4}`} 
              style={{ 
                background: color,
                opacity: 0.7 + (volume * 0.3),
                transform: `
                  translate(${Math.sin((i + 1) * 1.5) * (entropy + 20)}px, ${Math.cos((i + 1) * 1.5) * (entropy + 20)}px)
                  scale(${1 + volume * 0.2})
                ` 
              }} 
            />
          ))}
          {/* Add extra depth blobs */}
          <div className="blob blob-extra" style={{ background: colors[0], filter: 'blur(60px)', opacity: 0.4 }} />
        </div>

        {/* Gloss Overlay */}
        <div className="glass-surface" />
        
        {/* Grain Texture */}
        <div className="noise-texture" />
      </div>

      <style jsx>{`
        .premium-2d-container {
          width: 400px;
          height: 400px;
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .orb-canvas {
          width: 280px;
          height: 280px;
          border-radius: 50%;
          position: relative;
          overflow: hidden;
          background: #fff;
          box-shadow: 0 40px 80px rgba(0,0,0,0.08), inset 0 0 40px rgba(255,255,255,0.5);
          filter: url(#liquify);
          transition: transform 0.2s cubic-bezier(0.3, 1.5, 0.3, 1);
        }

        .mesh-gradient {
          position: absolute;
          inset: -60px;
          filter: blur(40px);
          display: flex;
          align-items: center;
          justify-content: center;
          animation: rotateMesh 20s linear infinite;
        }

        .blob {
          position: absolute;
          width: 260px;
          height: 260px;
          border-radius: 50%;
          mix-blend-mode: screen;
          animation: float 10s infinite ease-in-out;
          transition: all 0.4s ease-out;
        }

        .blob-0 { top: -10%; left: -10%; animation-delay: 0s; }
        .blob-1 { top: -10%; right: -10%; animation-delay: -2s; }
        .blob-2 { bottom: -10%; left: -10%; animation-delay: -4s; }
        .blob-3 { bottom: -10%; right: -10%; animation-delay: -6s; }
        .blob-extra { width: 300px; height: 300px; animation-duration: 15s; }

        .glass-surface {
          position: absolute;
          inset: 0;
          background: radial-gradient(circle at 35% 35%, rgba(255,255,255,0.5), transparent 70%);
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,0.5);
          pointer-events: none;
        }

        .noise-texture {
          position: absolute;
          inset: 0;
          opacity: 0.12;
          pointer-events: none;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
          mix-blend-mode: overlay;
        }

        @keyframes float {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(40px, -30px) scale(1.15); }
          66% { transform: translate(-30px, 50px) scale(0.85); }
        }

        @keyframes rotateMesh {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
