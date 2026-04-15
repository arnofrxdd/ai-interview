'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Participant, Track } from 'livekit-client';
import { useTracks } from '@livekit/components-react';
import { ThreeDOrb } from './ThreeDOrb';
import { ScoreEntry, ConvEntry, BehaviorState } from './interview2';

// ─── TYPES ──────────────────────────────────────────────────────────────────

type AppPhase = 'setup' | 'connecting' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'ended' | 'report';

interface AriaPremiumUIProps {
  phase: AppPhase;
  candidateName: string;
  setCandidateName: (n: string) => void;
  cvFileName: string;
  handleCvFile: (f: File) => void;
  jdText: string;
  setJdText: (t: string) => void;
  isParsing: boolean;
  setupErr: string;
  startCall: () => void;
  isCallActive: boolean;
  isAriaSpeaking: boolean;
  hasGreeted: boolean;
  onEndCall: () => void;
  onToggleMute: () => void;
  isMuted: boolean;
  participant?: Participant;
  numTopics: number;
  setNumTopics: (n: number) => void;
  duration: number;
  setDuration: (n: number) => void;
  voice: string;
  setVoice: (v: string) => void;
  scores: ScoreEntry[];
  conv: ConvEntry[];
  behavior: BehaviorState;
  avgScore: number;
}

// ─── ORB COMPONENT ───────────────────────────────────────────────────────────

const Orb = ({ phase, isAriaSpeaking, hasGreeted, volume, voice }: { phase: AppPhase; isAriaSpeaking: boolean; hasGreeted: boolean; volume: number; voice: string }) => {
  return (
    <div className="orb-wrapper" style={{ height: 400, width: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <ThreeDOrb phase={phase} isAriaSpeaking={isAriaSpeaking} hasGreeted={hasGreeted} volume={volume} voice={voice} />
    </div>
  );
};

// ─── MAIN PREMIUM UI ─────────────────────────────────────────────────────────

export const AriaPremiumUI: React.FC<AriaPremiumUIProps> = (props) => {
  const {
    phase, candidateName, setCandidateName, cvFileName, handleCvFile,
    jdText, setJdText, isParsing, setupErr, startCall,
    isCallActive, isAriaSpeaking, hasGreeted, onEndCall, onToggleMute, isMuted,
    participant
  } = props;

  // Track Audio Level for the Orb
  const [volume, setVolume] = useState(0);

  // Analyze audio levels
  useEffect(() => {
    if (!participant) return;
    
    let audioCtx: AudioContext;
    let analyzer: AnalyserNode;
    let stream: MediaStream;
    let animationFrame: number;

    const startAnalyzing = async () => {
      try {
        // We get the stream from the participant's tracks
        const tracks = Array.from(participant.trackPublications.values())
          .filter(p => p.track && p.kind === Track.Kind.Audio)
          .map(p => p.track?.mediaStreamTrack);

        if (tracks.length === 0 || !tracks[0]) return;

        stream = new MediaStream([tracks[0]]);
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        analyzer = audioCtx.createAnalyser();
        analyzer.fftSize = 256;
        source.connect(analyzer);

        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        
        const update = () => {
          analyzer.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
          }
          const average = sum / dataArray.length;
          setVolume(average / 128); // Normalize to roughly 0-1
          animationFrame = requestAnimationFrame(update);
        };
        update();
      } catch (e) {
        console.warn('Audio analysis failed:', e);
      }
    };

    startAnalyzing();

    return () => {
      cancelAnimationFrame(animationFrame);
      if (audioCtx) audioCtx.close();
    };
  }, [participant]);

  const JD_PRESETS = [
    { id: 'frontend', label: 'Frontend', icon: '⚛️', text: 'Role: Senior Frontend Engineer.\nRequirements: Deep React mastery, state management architectures, web performance optimization, and refined UI engineering.' },
    { id: 'backend', label: 'Backend', icon: '⚙️', text: 'Role: Senior Backend Architect.\nRequirements: Distributed systems, database design (Relational & NoSQL), system scalability, and high-security API design.' },
    { id: 'fullstack', label: 'Fullstack', icon: '⚡', text: 'Role: Senior Fullstack Engineer.\nRequirements: End-to-end technical ownership, DX (Developer Experience), modern cloud infra, and cohesive full-stack architectures.' },
    { id: 'ai', label: 'AI/ML', icon: '🧠', text: 'Role: AI/ML Engineer.\nRequirements: LLM integration (RAG, Fine-tuning), vector databases, latency optimization for real-time inference, and algorithmic honesty.' },
    { id: 'devops', label: 'DevOps', icon: '☁️', text: 'Role: SRE / Infrastructure Lead.\nRequirements: K8s orchestration, CI/CD pipelines, system reliability, cloud cost optimization, and observability.' },
  ];

  const VOICES = [
    { id: 'thalia', label: 'Thalia', gender: 'F', desc: 'Poised / Professional', preview: 'Greetings. I am Thalia. I will be conducting your technical evaluation today.' },
    { id: 'orpheus', label: 'Orpheus', gender: 'M', desc: 'Direct / Stoic', preview: 'I am Orpheus. Let us begin the interrogation. I expect precision in your answers.' },
    { id: 'atlas', label: 'Atlas', gender: 'M', desc: 'Bright / Energetic', preview: 'Hey there! I am Atlas. Ready to dive deep into your architecture and see how you solve complex problems?' },
    { id: 'asteria', label: 'Asteria', gender: 'F', desc: 'Cool / Analytical', preview: 'I am Asteria. I will be analyzing your technical depth through a series of edge-case challenges.' },
  ];

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const playPreview = async (voiceId: string, text: string) => {
    try {
      // Stop existing audio
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }

      const res = await fetch('/ai-interview/api/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: voiceId }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Preview failed: ${errText}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.play();

      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
      };
    } catch (e) {
      console.error('Failed to play Deepgram preview:', e);
    }
  };

  if (phase === 'report') {
    const outcome = props.avgScore >= 8 ? 'Exceptional' : props.avgScore >= 6 ? 'Strong Match' : props.avgScore >= 4 ? 'Developing' : 'Not Recommended';
    const outcomeColor = props.avgScore >= 8 ? '#4ade80' : props.avgScore >= 6 ? '#fbbf24' : '#f87171';

    return (
      <div className="premium-root report-mode">
        <div className="noise-overlay" />
        <div className="report-container">
          <header className="report-header">
            <div className="header-meta">
              <span className="premium-logo small">Aria</span>
              <span className="sep">/</span>
              <span className="report-title">Technical Evaluation Dossier</span>
            </div>
            <div className="header-actions">
              <button className="secondary-btn" onClick={() => window.print()}>Export PDF</button>
              <button className="primary-btn" onClick={() => window.location.reload()}>New Session</button>
            </div>
          </header>

          <main className="report-grid">
            {/* COLUMN 1: EXECUTIVE SUMMARY */}
            <div className="report-card primary">
              <div className="card-label">Executive Summary</div>
              <div className="summary-hero">
                <div className="candidate-info">
                  <h2 className="report-name">{candidateName}</h2>
                  <div className="outcome-badge" style={{ background: outcomeColor + '20', color: outcomeColor }}>{outcome}</div>
                </div>
                <div className="score-gauge">
                  <svg viewBox="0 0 100 100">
                    <circle className="gauge-bg" cx="50" cy="50" r="45" />
                    <circle 
                      className="gauge-val" 
                      cx="50" cy="50" r="45" 
                      style={{ stroke: outcomeColor, strokeDasharray: `${props.avgScore * 28.27} 282.7` }} 
                    />
                  </svg>
                  <div className="gauge-text">
                    <span className="val">{props.avgScore.toFixed(1)}</span>
                    <span className="total">/10</span>
                  </div>
                </div>
              </div>
              
              <div className="behavioral-metrics">
                <div className="metric">
                  <label>Soft Skills</label>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${props.behavior.softSkills * 10}%` }} /></div>
                </div>
                <div className="metric">
                  <label>Communication</label>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${props.behavior.communication * 10}%` }} /></div>
                </div>
                <div className="metric">
                  <label>Confidence</label>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${props.behavior.confidence * 10}%` }} /></div>
                </div>
              </div>
            </div>

            {/* COLUMN 2: TECHNICAL COMPETENCIES */}
            <div className="report-card technical">
              <div className="card-label">Technical Competencies</div>
              <div className="competency-list">
                {props.scores.map((s, i) => (
                  <div key={i} className="comp-item">
                    <div className="comp-header">
                      <span className="comp-name">{s.topicName}</span>
                      <span className="comp-score" style={{ color: s.score >= 7 ? '#4ade80' : s.score >= 5 ? '#fbbf24' : '#f87171' }}>{s.score}/10</span>
                    </div>
                    <div className="comp-meta">
                      <span className={`depth-tag ${s.depth}`}>{s.depth} depth</span>
                      <span className="acc-tag">Accuracy: {s.accuracy}/10</span>
                    </div>
                    <p className="comp-feedback">{s.feedback}</p>
                  </div>
                ))}
                {props.scores.length === 0 && <div className="empty-state">No technical data captured.</div>}
              </div>
            </div>

            {/* FULL WIDTH: CRITICAL HIGHLIGHTS */}
            <div className="report-card full Highlights">
              <div className="card-label">Critical Interview Segments</div>
              <div className="transcript-highlights">
                {props.conv.filter(c => c.text.length > 50).slice(-6).map((c, i) => (
                  <div key={i} className={`highlight-item ${c.role}`}>
                    <div className="role-tag">{c.role === 'ai' ? 'Aria' : 'Candidate'}</div>
                    <div className="text">{c.text}</div>
                  </div>
                ))}
              </div>
            </div>
          </main>
        </div>

        <style jsx>{`
          .report-mode { background: #f8f9fa; display: block; overflow-y: auto; }
          .report-container { max-width: 1100px; margin: 0 auto; padding: 40px 24px; animation: reportSlideUp 0.6s cubic-bezier(0.2, 1, 0.3, 1); }
          .report-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
          .header-meta { display: flex; align-items: center; gap: 12px; }
          .premium-logo.small { font-family: 'Fraunces', serif; font-size: 24px; font-weight: 300; }
          .sep { color: #ddd; }
          .report-title { font-family: 'Geist Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #888; }
          
          .header-actions { display: flex; gap: 12px; }
          .primary-btn { background: #000; color: #fff; border: none; padding: 10px 20px; border-radius: 10px; font-weight: 600; font-size: 13px; cursor: pointer; transition: all 0.2s; }
          .secondary-btn { background: #fff; color: #555; border: 1px solid #eee; padding: 10px 20px; border-radius: 10px; font-weight: 600; font-size: 13px; cursor: pointer; transition: all 0.2s; }
          .primary-btn:hover { background: #333; transform: translateY(-1px); }
          .secondary-btn:hover { border-color: #000; color: #000; }

          .report-grid { display: grid; grid-template-columns: 1fr 1.5fr; gap: 24px; }
          .report-card { background: #fff; border: 1px solid #eef0f2; border-radius: 24px; padding: 32px; box-shadow: 0 4px 20px rgba(0,0,0,0.02); }
          .report-card.full { grid-column: span 2; }
          .card-label { font-family: 'Geist Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #aaa; margin-bottom: 24px; }

          .summary-hero { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
          .report-name { font-family: 'Fraunces', serif; font-size: 36px; font-weight: 400; margin-bottom: 8px; letter-spacing: -0.02em; }
          .outcome-badge { display: inline-block; padding: 4px 12px; border-radius: 100px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }

          .score-gauge { position: relative; width: 100px; height: 100px; }
          .gauge-bg { fill: none; stroke: #f0f0f0; stroke-width: 8; }
          .gauge-val { fill: none; stroke-width: 8; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dasharray 1s ease-out; }
          .gauge-text { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
          .gauge-text .val { font-family: 'Fraunces', serif; font-size: 24px; font-weight: 400; line-height: 1; }
          .gauge-text .total { font-size: 10px; color: #aaa; margin-top: 2px; }

          .behavioral-metrics { display: flex; flex-direction: column; gap: 16px; border-top: 1px solid #f5f7f9; pt: 24px; pt: 24px; padding-top: 24px; }
          .metric label { display: block; font-size: 11px; font-weight: 500; color: #666; margin-bottom: 6px; }
          .bar-track { height: 6px; background: #f0f2f5; border-radius: 100px; overflow: hidden; }
          .bar-fill { height: 100%; background: #000; border-radius: 100px; transition: width 1s ease-out; }

          .competency-list { display: flex; flex-direction: column; gap: 24px; }
          .comp-item { border-bottom: 1px solid #f5f7f9; padding-bottom: 20px; }
          .comp-item:last-child { border-bottom: none; padding-bottom: 0; }
          .comp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
          .comp-name { font-size: 15px; font-weight: 600; }
          .comp-score { font-family: 'Fraunces', serif; font-size: 18px; }
          
          .comp-meta { display: flex; gap: 8px; margin-bottom: 12px; }
          .depth-tag, .acc-tag { font-size: 9px; font-weight: 600; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; border: 1px solid #eee; color: #888; }
          .depth-tag.deep { background: #f0fdf4; color: #16a34a; border-color: #dcfce7; }
          .comp-feedback { font-size: 13px; color: #555; lineHeight: 1.6; line-height: 1.6; }

          .transcript-highlights { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
          .highlight-item { padding: 16px; border-radius: 16px; background: #fafbfc; border-left: 2px solid #000; }
          .highlight-item.ai { background: #f0f7ff; border-left-color: #007aff; }
          .role-tag { font-family: 'Geist Mono', monospace; font-size: 8px; text-transform: uppercase; color: #aaa; margin-bottom: 8px; }
          .highlight-item .text { font-size: 12px; color: #333; line-height: 1.5; }

          @keyframes reportSlideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        `}</style>
      </div>
    );
  }

  if (phase === 'setup') {
    return (
      <div className="premium-root">
        <div className="noise-overlay" />
        <div className={`bg-blobs voice-${props.voice}`}>
          <div className="blob blob-1" />
          <div className="blob blob-2" />
        </div>

        <div className="setup-container">
          <header className="setup-header">
            <h1 className="premium-logo">Aria</h1>
            <p className="premium-subtitle">The next generation of technical evaluation.</p>
          </header>

          <div className="setup-dossier">
            {/* LAYER 1: IDENTITY */}
            <div className="dossier-layer">
              <div className="layer-title">Evaluation Target</div>
              <div className="layer-grid">
                <div className="input-group">
                  <label>Candidate Name</label>
                  <input 
                    type="text" 
                    placeholder="Full Name"
                    value={candidateName}
                    onChange={(e) => setCandidateName(e.target.value)}
                  />
                </div>
                <div className="input-group">
                  <label>Experience Dossier (CV)</label>
                  <div className="premium-dropzone" onClick={() => (document.getElementById('cv-up') as any)?.click()}>
                    <input id="cv-up" type="file" accept=".pdf,.txt" hidden onChange={(e) => e.target.files?.[0] && handleCvFile(e.target.files[0])} />
                    {isParsing ? 'Analyzing...' : cvFileName ? `✓ ${cvFileName}` : 'Upload Document'}
                  </div>
                </div>
              </div>
            </div>

            {/* LAYER 2: VOICE PERSONA */}
            <div className="dossier-layer">
              <div className="layer-title">Interviewer Persona</div>
              <div className="voice-grid">
                {VOICES.map(v => (
                  <button 
                    key={v.id} 
                    className={`voice-card ${props.voice === v.id ? 'active' : ''}`}
                    onClick={() => {
                      props.setVoice(v.id);
                      playPreview(v.id, v.preview);
                    }}
                  >
                    <div className={`voice-swatch ${v.id}`} />
                    <div className="voice-info">
                      <div className="voice-name">{v.label} <span className="gender">{v.gender}</span></div>
                      <div className="voice-desc">{v.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* LAYER 3: REQUIREMENTS */}
            <div className="dossier-layer">
              <div className="layer-header">
                <div className="layer-title">Role Requirements</div>
                <div className="jd-presets">
                  {JD_PRESETS.map(p => (
                    <button 
                      key={p.id} 
                      className="preset-chip"
                      onClick={() => setJdText(p.text)}
                    >
                      {p.icon} {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <textarea 
                className="jd-editor"
                placeholder="Paste Job Description or select a preset..."
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
              />
            </div>

            {/* LAYER 4: PARAMETERS */}
            <div className="dossier-layer footer">
              <div className="params-grid">
                <div className="input-group">
                  <label>Concepts</label>
                  <div className="premium-segments">
                    {[3, 5, 8, 10].map(n => (
                      <button key={n} className={props.numTopics === n ? 'active' : ''} onClick={() => props.setNumTopics(n)}>{n}</button>
                    ))}
                  </div>
                </div>
                <div className="input-group">
                  <label>Time (m)</label>
                  <div className="premium-segments">
                    {[5, 10, 15, 20].map(m => (
                      <button key={m} className={props.duration === m ? 'active' : ''} onClick={() => props.setDuration(m)}>{m}</button>
                    ))}
                  </div>
                </div>
                <button className="premium-start" onClick={startCall} disabled={isParsing}>
                  {isParsing ? 'Processing...' : 'Initiate Evaluation'}
                </button>
              </div>
              {setupErr && <div className="premium-err">{setupErr}</div>}
            </div>
          </div>
        </div>

        <style jsx>{`
          .premium-root {
            @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,600;1,9..144,300;1,9..144,400&family=Geist+Mono:wght@300;400;500&family=Geist:wght@300;400;500;600&display=swap');
            min-height: 100vh;
            background: #ffffff;
            color: #0c0d10;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: 'Geist', sans-serif;
            position: relative;
            overflow: hidden;
          }
          .noise-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            opacity: 0.04; z-index: 10; pointer-events: none;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
          }
          .bg-blobs {
            position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 1;
            filter: blur(140px); opacity: 0.15; transition: all 1s ease-in-out;
          }
          .blob { position: absolute; border-radius: 50%; width: 60vw; height: 60vw; }
          .blob-1 { background: #ff9a9e; top: -20%; left: -20%; animation: float 20s infinite; }
          .blob-2 { background: #a1c4fd; bottom: -20%; right: -20%; animation: float 25s infinite reverse; }

          /* Voice Themes */
          .voice-orpheus .blob-1 { background: #243949; } .voice-orpheus .blob-2 { background: #4facfe; }
          .voice-atlas .blob-1 { background: #f6d365; } .voice-atlas .blob-2 { background: #f5576c; }
          .voice-asteria .blob-1 { background: #e0c3fc; } .voice-asteria .blob-2 { background: #38f9d7; }

          .setup-container {
            width: 100%; max-width: 640px;
            animation: fadeIn 0.8s ease-out;
            position: relative; z-index: 20;
            padding: 40px 24px;
          }
          .setup-header { text-align: center; margin-bottom: 32px; }
          .premium-logo { font-family: 'Fraunces', serif; font-size: 52px; font-weight: 300; margin-bottom: 4px; letter-spacing: -0.04em; color: #000; }
          .premium-subtitle { color: #666; font-size: 15px; letter-spacing: -0.01em; }

          .setup-dossier {
            background: #ffffff;
            border: 1px solid #e2e2e2;
            box-shadow: 0 20px 60px rgba(0,0,0,0.06);
            border-radius: 32px;
            overflow: hidden;
            display: flex; flex-direction: column;
          }
          .dossier-layer {
            padding: 24px 32px;
            border-bottom: 1px solid #f0f0f0;
          }
          .dossier-layer.footer { background: #fafafa; border-bottom: none; }
          .layer-title {
            font-family: 'Geist Mono', monospace; font-size: 10px; text-transform: uppercase;
            letter-spacing: 0.12em; color: #999; margin-bottom: 16px;
          }
          .layer-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
          .input-group label { display: block; font-size: 12px; font-weight: 500; color: #444; margin-bottom: 8px; margin-left: 2px; }
          
          input, .jd-editor {
            width: 100%; background: #fdfdfd; border: 1px solid #eee; border-radius: 12px;
            padding: 14px 16px; color: #111; font-size: 14px; outline: none; transition: all 0.2s;
          }
          input:focus, .jd-editor:focus { border-color: #000; background: #fff; box-shadow: 0 0 0 4px rgba(0,0,0,0.02); }
          .jd-editor { min-height: 120px; resize: none; font-family: inherit; line-height: 1.6; }

          .layer-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
          .jd-presets { display: flex; gap: 8px; }
          .preset-chip {
            background: #f5f5f5; border: 1px solid #eee; border-radius: 100px;
            padding: 4px 10px; font-size: 11px; font-weight: 500; color: #666;
            cursor: pointer; transition: all 0.2s;
          }
          .preset-chip:hover { border-color: #000; background: #fff; color: #000; }

          .voice-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          .voice-card {
            display: flex; align-items: center; gap: 12px; padding: 12px;
            background: #fdfdfd; border: 1px solid #f0f0f0; border-radius: 16px;
            cursor: pointer; transition: all 0.2s; text-align: left;
          }
          .voice-card:hover { border-color: #000; background: #fff; }
          .voice-card.active { border-color: #000; background: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.04); }
          
          .voice-swatch { width: 32px; height: 32px; border-radius: 10px; flex-shrink: 0; }
          .voice-swatch.thalia { background: linear-gradient(135deg, #ff9a9e, #fecfef); }
          .voice-swatch.orpheus { background: linear-gradient(135deg, #243949, #4facfe); }
          .voice-swatch.atlas { background: linear-gradient(135deg, #f6d365, #f5576c); }
          .voice-swatch.asteria { background: linear-gradient(135deg, #e0c3fc, #38f9d7); }

          .voice-name { font-size: 13px; font-weight: 600; color: #111; display: flex; align-items: center; gap: 6px; }
          .gender { font-size: 9px; font-weight: 500; color: #999; padding: 2px 4px; background: #f0f0f0; border-radius: 4px; }
          .voice-desc { font-size: 11px; color: #777; }

          .premium-dropzone {
            background: #fdfdfd; border: 1px dashed #ddd; border-radius: 12px;
            padding: 13px; cursor: pointer; font-size: 13px; color: #777;
            text-align: center; transition: all 0.2s;
          }
          .premium-dropzone:hover { border-color: #000; background: #fff; color: #000; }

          .params-grid { display: flex; align-items: flex-end; gap: 24px; }
          .premium-segments {
            display: flex; background: #eee; border-radius: 12px; padding: 3px; gap: 2px;
          }
          .premium-segments button {
            flex: 1; min-width: 44px; border: none; background: transparent; color: #777;
            font-family: 'Geist Mono', monospace; font-size: 11px; padding: 7px 0;
            border-radius: 10px; cursor: pointer; transition: all 0.2s;
          }
          .premium-segments button.active { background: #fff; color: #000; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }

          .premium-start {
            flex: 1; background: #000; color: #fff; border: none; border-radius: 14px;
            padding: 14px; font-weight: 600; font-size: 14px; cursor: pointer;
            transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px;
          }
          .premium-start:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(0,0,0,0.15); }
          .premium-start:disabled { opacity: 0.3; cursor: not-allowed; }

          .premium-err { font-size: 11px; color: #ff4d4d; margin-top: 12px; font-family: 'Geist Mono', monospace; }

          @keyframes float { 0%, 100% { transform: translate(0,0); } 50% { transform: translate(10%, 10%); } }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

          /* LIVE VIEW STYLES */
          .premium-live {
            @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,600;1,9..144,300;1,9..144,400&family=Geist+Mono:wght@300;400;500&family=Geist:wght@300;400;500;600&display=swap');
            height: 100vh; background: #ffffff; color: #000;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: 'Geist', sans-serif; position: relative; overflow: hidden;
          }
          .live-header { position: absolute; top: 32px; width: 100%; display: flex; justify-content: center; z-index: 20; }
          .phase-indicator { display: flex; align-items: center; gap: 10px; font-size: 10px; letter-spacing: 0.1em; font-weight: 600; color: #666; background: #f4f4f4; padding: 8px 16px; border-radius: 100px; border: 1px solid #eee; }
          .dot { width: 6px; height: 6px; border-radius: 50%; background: #ccc; }
          .dot.warmup { background: #ff9a9e; box-shadow: 0 0 10px #ff9a9e; }
          .dot.interview { background: #4facfe; box-shadow: 0 0 10px #4facfe; }
          .dot.wrapup { background: #84fab0; box-shadow: 0 0 10px #84fab0; }
          .dot.closing { background: #f6d365; box-shadow: 0 0 10px #f6d365; }

          .orb-wrapper { display: flex; flex-direction: column; align-items: center; gap: 40px; position: relative; z-index: 15; }
          .status-text { font-size: 14px; font-weight: 500; color: #999; letter-spacing: -0.01em; transition: all 0.3s; }

          .live-controls { position: absolute; bottom: 48px; display: flex; gap: 16px; z-index: 30; }
          .control-btn { width: 56px; height: 56px; border-radius: 50%; border: 1px solid #eee; background: #fff; color: #111; cursor: pointer; font-size: 20px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
          .control-btn:hover { background: #f9f9f9; transform: translateY(-2px); box-shadow: 0 4px 15px rgba(0,0,0,0.08); }
          .control-btn.muted { background: #fff5f5; border-color: #ffdada; color: #ff4d4d; }
          .control-btn.end { border-color: #eee; }
          .control-btn.end:hover { background: #000; color: #fff; }
        `}</style>
      </div>
    );
  }

  // Live View
  return (
    <div className="premium-live">
      <div className="noise-overlay" />
      <div className={`bg-blobs voice-${props.voice}`}>
        <div className="blob blob-1" />
        <div className="blob blob-2" />
      </div>
      <div className="live-header">
        <div className="phase-indicator">
          <span className={`dot ${phase}`} />
          {phase.toUpperCase()}
        </div>
      </div>

      <div className="orb-wrapper">
        <Orb phase={phase} isAriaSpeaking={isAriaSpeaking} hasGreeted={hasGreeted} volume={volume} voice={props.voice} />
        <div className="status-text">
          {!hasGreeted ? 'Initializing Persona...' : isAriaSpeaking ? 'Aria is speaking...' : 'Aria is listening...'}
        </div>
      </div>

      <div className="live-controls">
        <button className={`control-btn ${isMuted ? 'muted' : ''}`} onClick={onToggleMute}>
          {isMuted ? '🔇' : '🎤'}
        </button>
        <button className="control-btn end" onClick={onEndCall}>
          ✕
        </button>
      </div>

      {/* RE-USING THE SAME STYLE BLOCK FOR SIMPLICITY */}
      <style jsx>{`
        .premium-live {
          @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,600;1,9..144,300;1,9..144,400&family=Geist+Mono:wght@300;400;500&family=Geist:wght@300;400;500;600&display=swap');
          height: 100vh; background: #ffffff; color: #000;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          font-family: 'Geist', sans-serif; position: relative; overflow: hidden;
        }
        .noise-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; opacity: 0.04; z-index: 10; pointer-events: none; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E"); }
        .bg-blobs { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 1; filter: blur(140px); opacity: 0.15; transition: all 1s ease-in-out; }
        .blob { position: absolute; border-radius: 50%; width: 60vw; height: 60vw; }
        .blob-1 { background: #ff9a9e; top: -20%; left: -20%; animation: float 20s infinite; }
        .blob-2 { background: #a1c4fd; bottom: -20%; right: -20%; animation: float 25s infinite reverse; }

        /* Voice Themes */
        .voice-orpheus .blob-1 { background: #243949; } .voice-orpheus .blob-2 { background: #4facfe; }
        .voice-helios .blob-1 { background: #f6d365; } .voice-helios .blob-2 { background: #f5576c; }
        .voice-stella .blob-1 { background: #e0c3fc; } .voice-stella .blob-2 { background: #38f9d7; }

        @keyframes float { 0%, 100% { transform: translate(0,0); } 50% { transform: translate(10%, 10%); } }

        .live-header { position: absolute; top: 32px; width: 100%; display: flex; justify-content: center; z-index: 20; }
        .phase-indicator { display: flex; align-items: center; gap: 10px; font-size: 10px; letter-spacing: 0.1em; font-weight: 600; color: #666; background: #f4f4f4; padding: 8px 16px; border-radius: 100px; border: 1px solid #eee; }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: #ccc; }
        .dot.warmup { background: #ff9a9e; box-shadow: 0 0 10px #ff9a9e; }
        .dot.interview { background: #4facfe; box-shadow: 0 0 10px #4facfe; }
        .dot.wrapup { background: #84fab0; box-shadow: 0 0 10px #84fab0; }
        .dot.closing { background: #f6d365; box-shadow: 0 0 10px #f6d365; }

        .orb-wrapper { display: flex; flex-direction: column; align-items: center; gap: 40px; position: relative; z-index: 15; }
        .status-text { font-size: 14px; font-weight: 500; color: #999; letter-spacing: -0.01em; transition: all 0.3s; }

        .live-controls { position: absolute; bottom: 48px; display: flex; gap: 16px; z-index: 30; }
        .control-btn { width: 56px; height: 56px; border-radius: 50%; border: 1px solid #eee; background: #fff; color: #111; cursor: pointer; font-size: 20px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
        .control-btn:hover { background: #f9f9f9; transform: translateY(-2px); box-shadow: 0 4px 15px rgba(0,0,0,0.08); }
        .control-btn.muted { background: #fff5f5; border-color: #ffdada; color: #ff4d4d; }
        .control-btn.end { border-color: #eee; }
        .control-btn.end:hover { background: #000; color: #fff; }
      `}</style>
    </div>
  );
};
