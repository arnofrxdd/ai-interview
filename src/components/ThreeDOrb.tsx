'use client';

import React, { useMemo } from 'react';

// ─── TYPES ──────────────────────────────────────────────────────────────────

type AppPhase = 'setup' | 'connecting' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'ended' | 'report';

interface ThreeDOrbProps {
  phase: AppPhase;
  isAriaSpeaking: boolean;
  hasGreeted: boolean;
  volume: number;
  voice?: string;
}

// ─── PALETTES ────────────────────────────────────────────────────────────────

const VOICE_PALETTES: Record<string, string[]> = {
  thalia: ['#fe5165', '#ff8d7e', '#be93e4', '#ffbd8b'],
  orpheus: ['#5190fe', '#83c5be', '#be93e4', '#93e4d1'],
  atlas: ['#ffbd8b', '#fe5165', '#ff8d7e', '#be93e4'],
  asteria: ['#93e4d1', '#be93e4', '#5190fe', '#83c5be'],
};

export const ThreeDOrb: React.FC<ThreeDOrbProps> = ({ phase, isAriaSpeaking, volume, voice = 'thalia', hasGreeted }) => {
  const colors = useMemo(() => {
    return VOICE_PALETTES[voice] || VOICE_PALETTES.thalia;
  }, [voice]);

  // Normalize volume for CSS
  const orbScale = 1 + volume * 0.4;
  const entropy = volume * 15;

  return (
    <div className={`premium-2d-container ${!hasGreeted ? 'is-loading' : ''}`}>
      {/* SVG Liquid Filter */}
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          <filter id="liquify">
            <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="2" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale={hasGreeted ? 12 + volume * 30 : 6} />
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
                opacity: hasGreeted ? 0.9 : 0.4,
                transform: hasGreeted ? `
                  translate(${Math.sin((i + 1) * 1.5) * (entropy + 40)}px, ${Math.cos((i + 1) * 1.5) * (entropy + 40)}px)
                  scale(${1 + volume * 0.3})
                ` : `scale(0.85)`
              }} 
            />
          ))}
          <div className="blob extra-blur" style={{ background: colors[0], opacity: 0.6 }} />
        </div>

        {/* Loading Overlay */}
        {!hasGreeted && (
          <div className="loading-ring-container">
            <div className="loading-ring" />
            <div className="loading-ring delay-1" />
          </div>
        )}

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

        .is-loading .orb-canvas {
          filter: contrast(1.1) brightness(1.05) url(#liquify);
          box-shadow: 0 20px 60px rgba(0,0,0,0.05);
          opacity: 0.8;
        }

        .loading-ring-container {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 5;
        }

        .loading-ring {
          position: absolute;
          width: 80%;
          height: 80%;
          border: 1px solid rgba(0,0,0,0.05);
          border-radius: 50%;
          animation: orbPulse 2.5s infinite ease-out;
        }
        .delay-1 { animation-delay: 1.25s; }

        @keyframes orbPulse {
          0% { transform: scale(0.6); opacity: 0; }
          50% { opacity: 0.2; }
          100% { transform: scale(1.3); opacity: 0; }
        }

        .orb-canvas {
          width: 280px;
          height: 280px;
          border-radius: 50%;
          position: relative;
          overflow: hidden;
          background: #ffffff;
          box-shadow: 
            0 40px 100px rgba(0,0,0,0.08),
            inset 0 0 40px rgba(255,255,255,0.8);
          filter: url(#liquify);
          transition: transform 0.2s cubic-bezier(0.3, 1.5, 0.3, 1), filter 0.6s ease;
        }

        .mesh-gradient {
          position: absolute;
          inset: -80px;
          filter: blur(75px);
          display: flex;
          align-items: center;
          justify-content: center;
          animation: rotateMesh 25s linear infinite;
        }

        .is-loading .mesh-gradient {
          animation-duration: 45s;
        }

        .blob {
          position: absolute;
          width: 320px;
          height: 320px;
          border-radius: 50%;
          mix-blend-mode: normal;
          animation: float 12s infinite ease-in-out;
          transition: all 1s ease-in-out;
        }

        .extra-blur {
          width: 400px;
          height: 400px;
          filter: blur(100px);
          animation: float 18s infinite reverse ease-in-out;
        }

        .blob-0 { top: -20%; left: -20%; animation-delay: 0s; }
        .blob-1 { top: -20%; right: -20%; animation-delay: -3s; }
        .blob-2 { bottom: -20%; left: -20%; animation-delay: -6s; }
        .blob-3 { bottom: -15%; right: -15%; animation-delay: -9s; }

        .glass-surface {
          position: absolute;
          inset: 0;
          background: radial-gradient(circle at 35% 35%, rgba(255,255,255,0.4), transparent 80%);
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,0.5);
          pointer-events: none;
          z-index: 2;
        }

        .noise-texture {
          position: absolute;
          inset: 0;
          opacity: 0.28;
          pointer-events: none;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
          mix-blend-mode: overlay;
          z-index: 3;
        }

        @keyframes float {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(50px, -40px) scale(1.1); }
          66% { transform: translate(-40px, 60px) scale(0.9); }
        }

        @keyframes rotateMesh {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
