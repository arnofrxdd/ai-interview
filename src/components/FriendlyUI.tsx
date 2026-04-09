import React, { Fragment } from 'react';

type Props = {
  phase: any;
  setPhase: (p: any) => void;
  candidateName: string;
  setCandidateName: (n: string) => void;
  cvText: string;
  setCvText: (t: string) => void;
  jdText: string;
  setJdText: (t: string) => void;
  cvFileName: string;
  isParsing: boolean;
  setupErr: string;
  numQuestions: number;
  setNumQuestions: (n: number) => void;
  interviewDuration: number;
  setInterviewDuration: (d: number) => void;
  isCallActive: boolean;
  callStatus: string;
  isMuted: boolean;
  micLevel: number;
  duration: number;
  isCallEnded: boolean;
  logs: any[];
  scores: any[];
  currentTopic: string;
  interviewTimeLeft: number;
  behavior: any;
  usage: any;
  historySummary: string;
  strategy: any;
  observerStatus: string;
  silenceTimeLeft: number | null;
  silenceDuration: number;
  warmupTurns: number;
  WARMUP_TURNS_REQUIRED: number;
  handleCvFile: (f: File) => void;
  startCall: () => void;
  toggleMute: () => void;
  endCall: () => void;
  computeVoiceCost: (u: any) => number;
  computeIntelCost: (u: any) => number;
  ScoreBadge: React.FC<{ score: number }>;
  fmtTime: (s: number) => string;
  PhaseDot: React.FC<{ phase: any; current: any; label: string }>;
  useFriendlyUI: boolean;
  setUseFriendlyUI: (v: boolean) => void;
};

export const FriendlyUI: React.FC<Props> = (props) => {
  const {
    phase, candidateName, cvText, setCvText, jdText, setJdText, cvFileName, isParsing,
    setupErr, numQuestions, setNumQuestions, interviewDuration, setInterviewDuration,
    isCallActive, callStatus, isMuted, micLevel, duration, isCallEnded, logs, scores,
    currentTopic, interviewTimeLeft, behavior, usage, historySummary, strategy,
    observerStatus, silenceTimeLeft, silenceDuration, warmupTurns, WARMUP_TURNS_REQUIRED,
    handleCvFile, startCall, toggleMute, endCall, computeVoiceCost, computeIntelCost,
    ScoreBadge, fmtTime, setCandidateName, useFriendlyUI, setUseFriendlyUI
  } = props;

  const totalCost = computeVoiceCost(usage) + computeIntelCost(usage);
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b.score, 0) / scores.length : 0;
  const isSpeaking = callStatus === 'Speaking...';

  // Last score for sub-scoring metrics
  const lastScore = scores[scores.length - 1];
  
  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Playfair+Display:ital,wght@0,700;1,400&display=swap');
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    .f-root {
      --f-bg: #050507;
      --f-glass: rgba(12, 12, 16, 0.85);
      --f-border: rgba(255, 255, 255, 0.06);
      --f-accent: #3b82f6;
      --f-green: #34d399;
      --f-red: #f87171;
      --f-text: #ffffff;
      --f-text-dim: #94a3b8;
      --f-font: 'Outfit', sans-serif;
      --f-serif: 'Playfair Display', serif;
      
      font-family: var(--f-font);
      background: var(--f-bg);
      color: var(--f-text);
      height: 100vh;
      width: 100vw;
      max-height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      position: fixed;
      top: 0;
      left: 0;
    }

    }
    
    /* SETUP VIEW */

    /* SETUP VIEW */
    .f-setup {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 40px; gap: 32px; max-width: 1000px; margin: 0 auto; z-index: 10; overflow-y: auto;
    }
    .f-title-group { text-align: center; }
    .f-title { font-family: var(--f-serif); font-size: 52px; margin-bottom: 12px; font-weight: 700; background: linear-gradient(to bottom, #fff, #94a3b8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .f-subtitle { color: var(--f-text-dim); font-size: 18px; }

    .f-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; width: 100%; }
    .f-card {
      background: var(--f-glass); border: 1px solid var(--f-border); backdrop-filter: blur(20px);
      border-radius: 28px; padding: 32px; display: flex; flex-direction: column; gap: 16px; transition: 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .f-card:hover { border-color: rgba(59, 130, 246, 0.4); transform: translateY(-4px); box-shadow: 0 20px 40px rgba(0,0,0,0.4); }

    .f-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; color: var(--f-accent); }
    .f-textarea { 
      background: rgba(0,0,0,0.3); border: 1px solid var(--f-border); border-radius: 16px; 
      padding: 18px; color: white; font-family: var(--f-font); font-size: 15px; 
      min-height: 180px; outline: none; transition: 0.3s;
    }
    .f-textarea:focus { border-color: var(--f-accent); background: rgba(0,0,0,0.5); box-shadow: 0 0 0 4px rgba(59,130,246,0.1); }

    .f-start-btn {
      background: #ffffff; color: #000; border: none; padding: 20px 60px; 
      border-radius: 100px; font-weight: 800; font-size: 18px; cursor: pointer;
      transition: 0.4s; box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    }
    .f-start-btn:hover:not(:disabled) { transform: scale(1.05); background: #eee; box-shadow: 0 20px 50px rgba(59, 130, 246, 0.3); }
    .f-start-btn:disabled { opacity: 0.3; cursor: not-allowed; }

    /* LIVE VIEW */
    .f-live {
      display: grid;
      grid-template-columns: 340px 1fr 340px;
      height: 100vh;
      width: 100vw;
      position: relative;
      overflow: hidden;
    }

    .f-side { background: rgba(8, 8, 12, 0.4); border-right: 1px solid var(--f-border); display: flex; flex-direction: column; height: 100%; overflow: hidden; }
    .f-side-r { border-left: 1px solid var(--f-border); border-right: none; }

    .f-main { display: flex; flex-direction: column; position: relative; height: 100%; overflow: hidden; background: radial-gradient(circle at center, rgba(59, 130, 246, 0.03) 0%, transparent 70%); }
    
    .f-header {
      padding: 24px 32px; border-bottom: 1px solid var(--f-border);
      display: flex; justify-content: space-between; align-items: center;
      background: rgba(0,0,0,0.2); backdrop-filter: blur(10px); z-index: 50;
    }

    .f-persona-card {
      padding: 32px 24px; text-align: center; border-bottom: 1px solid var(--f-border);
      background: linear-gradient(180deg, rgba(59, 130, 246, 0.05), transparent);
    }
    
    /* LIP SYNC AVATAR */
    .f-avatar-box {
        width: 120px; height: 120px; margin: 0 auto 20px; position: relative;
        display: flex; align-items: center; justify-content: center;
    }
    .f-avatar-circle {
        position: absolute; inset: 0; border-radius: 50%;
        background: linear-gradient(135deg, #1e293b, #020617);
        border: 2px solid var(--f-border); transition: 0.5s;
    }
    .f-avatar-circle.speaking { 
        border-color: var(--f-accent);
        box-shadow: 0 0 40px rgba(59, 130, 246, 0.3);
    }
    .f-mouth {
        width: 40px; height: 12px; border: 2px solid var(--f-text-dim);
        border-radius: 50% / 100% 100% 0 0; border-bottom: 0;
        position: relative; transition: 0.3s;
    }
    .f-mouth.speaking {
        height: 24px; width: 32px; border: 3px solid var(--f-accent);
        border-radius: 50%; animation: f-sync 0.15s infinite alternate ease-in-out;
    }
    @keyframes f-sync { from { transform: scaleY(0.6) scaleX(1.1); } to { transform: scaleY(1.1) scaleX(0.8); } }
    
    .f-eye-row { display: flex; gap: 24px; position: absolute; top: 40px; }
    .f-eye { width: 6px; height: 6px; background: var(--f-text-dim); border-radius: 50%; }
    .f-eye.speaking { background: var(--f-accent); box-shadow: 0 0 10px var(--f-accent); }

    .f-behavior-tag {
      display: inline-block; padding: 6px 16px; border-radius: 100px;
      font-size: 11px; font-weight: 800; text-transform: uppercase;
      background: rgba(59, 130, 246, 0.15); color: var(--f-accent);
      margin-top: 12px; letter-spacing: 0.05em;
    }

    .f-transcript {
      flex: 1; overflow-y: auto; padding: 40px; display: flex; flex-direction: column; gap: 28px;
    }
    .f-bubble { max-width: 85%; padding: 20px 24px; border-radius: 24px; font-size: 16px; line-height: 1.6; }
    .f-ai-bubble { align-self: flex-start; background: var(--f-glass); border: 1px solid var(--f-border); box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
    .f-user-bubble { align-self: flex-end; background: var(--f-accent); color: white; border-bottom-right-radius: 2px; }

    .f-bottom-bar {
      padding: 24px 40px; border-top: 1px solid var(--f-border);
      display: flex; justify-content: space-between; align-items: center;
      background: rgba(2, 2, 4, 0.8); backdrop-filter: blur(20px); z-index: 50;
    }

    .f-controls { display: flex; gap: 16px; }
    .f-btn {
      padding: 14px 28px; border-radius: 14px; font-weight: 700; font-size: 14px;
      cursor: pointer; border: 1px solid var(--f-border); transition: 0.3s;
    }
    .f-btn-primary { background: var(--f-accent); border: none; color: white; }
    .f-btn-secondary { background: rgba(255,255,255,0.04); color: white; }
    .f-btn-danger { background: rgba(239, 68, 68, 0.1); color: #f87171; border-color: rgba(239, 68, 68, 0.2); }

    /* STAT BOXES & SUB-SCORING */
    .f-stat-box { padding: 24px; border-bottom: 1px solid var(--f-border); flex-shrink: 0; }
    .f-stat-val { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
    .f-stat-lbl { font-size: 11px; color: var(--f-text-dim); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; }

    .f-sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
    .f-sub-score { background: rgba(255,255,255,0.02); padding: 12px; border-radius: 12px; border: 1px solid var(--f-border); }
    .f-sub-val { font-size: 14px; font-weight: 700; color: #fff; }
    .f-sub-lbl { font-size: 8px; color: var(--f-text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }

    /* MOOD METER */
    .f-mood-meter {
        height: 6px; background: rgba(255,255,255,0.05); border-radius: 10px;
        margin-top: 16px; position: relative; overflow: hidden;
    }
    .f-mood-fill {
        position: absolute; left: 0; top: 0; height: 100%; transition: 1.5s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .fade { animation: f-fadeUp 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) forwards; }
    @keyframes f-fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

    /* SCROLLBAR */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--f-border); border-radius: 10px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--f-text-dim); }

    .f-scroll { overflow-y: auto; flex: 1; }
  `;

  if (phase === 'setup') return (
    <div className="f-root">
      <style>{CSS}</style>
      <div className="f-setup fade">
        <div className="f-title-group">
          <h1 className="f-title">Hello, Candidate.</h1>
          <p className="f-subtitle">Aria v5 is ready to explore your profile.</p>
        </div>

        <div className="f-grid">
          <div className="f-card">
            <div className="f-label">Background Intelligence (CV)</div>
            {!cvText ? (
              <div 
                style={{ flex: 1, border: '2px dashed var(--f-border)', borderRadius: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', minHeight: 140 }}
                onClick={() => { const i = document.createElement('input'); i.type = 'file'; i.onchange = (e: any) => handleCvFile(e.target.files[0]); i.click(); }}
              >
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>{isParsing ? '⌛' : '📄'}</div>
                    <div style={{ fontSize: 14, color: 'var(--f-text-dim)', fontWeight: 500 }}>{isParsing ? 'Analyzing Profile...' : 'Upload your Resume'}</div>
                </div>
              </div>
            ) : (
                <div style={{ background: 'rgba(52,211,153,.05)', padding: 20, borderRadius: 16, border: '1px solid rgba(52,211,153,.2)', color: 'var(--f-green)', fontSize: 15, fontWeight: 600 }}>
                   ✅ Resume Loaded: {cvFileName}
                </div>
            )}
            <textarea className="f-textarea" placeholder="Or paste background details..." value={cvText} onChange={e => setCvText(e.target.value)} />
          </div>

          <div className="f-card">
            <div className="f-label">Role Focus (JD)</div>
            <textarea className="f-textarea" placeholder="Paste the Job Description or Role requirements..." value={jdText} onChange={e => setJdText(e.target.value)} />
            <div style={{ marginTop: 'auto' }}>
                <div className="f-label" style={{ marginBottom: 12 }}>Interview Depth</div>
                <div style={{ display: 'flex', gap: 12 }}>
                   {[3, 5, 8, 10].map(n => (
                     <button key={n} className="f-btn f-btn-secondary" style={{ flex: 1, padding: '12px', border: numQuestions === n ? '2px solid white' : '1px solid var(--f-border)' }} onClick={() => setNumQuestions(n)}>{n} Qs</button>
                   ))}
                </div>
            </div>
          </div>
        </div>

        {setupErr && <div style={{ color: 'var(--f-red)', fontSize: 14, fontWeight: 600 }}>⚠️ {setupErr}</div>}
        
        <div style={{ width: '100%', maxWidth: 460, textAlign: 'center' }}>
             <input 
                className="f-textarea" 
                style={{ minHeight: 'auto', marginBottom: 20, width: '100%', border: '1px solid var(--f-accent)', textAlign: 'center', fontSize: 18 }}
                placeholder="Enter Your Full Name" 
                value={candidateName} 
                onChange={e => setCandidateName(e.target.value)} 
             />
             <button className="f-start-btn" style={{ width: '100%' }} disabled={isParsing || (!cvText && !jdText)} onClick={startCall}>
                Start Assessment
             </button>
        </div>
      </div>
    </div>
  );

  if (phase === 'connecting') return (
    <div className="f-root" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <style>{CSS}</style>
      <div className="fade" style={{ textAlign: 'center' }}>
          <div className="f-avatar-box" style={{ width: 140, height: 140 }}>
              <div className="f-avatar-circle speaking" />
              <div className="f-eye-row"><div className="f-eye speaking" /><div className="f-eye speaking" /></div>
              <div className="f-mouth speaking" />
          </div>
          <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>Aria is Entering...</h2>
          <p style={{ color: 'var(--f-text-dim)', fontSize: 18 }}>Setting up your digital interview suite</p>
      </div>
    </div>
  );


  if (isCallEnded || phase === 'report') return (
    <div className="f-root">
      <style>{CSS}</style>
      <div className="f-scroll" style={{ padding: '60px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="fade" style={{ maxWidth: 900, width: '100%' }}>
              <div style={{ textAlign: 'center', marginBottom: 60 }}>
                  <div style={{ fontSize: 13, color: 'var(--f-accent)', fontWeight: 800, letterSpacing: '0.2em', marginBottom: 16 }}>ASSESSMENT COMPLETE</div>
                  <h1 style={{ fontSize: 56, fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>{candidateName}</h1>
                  <p style={{ fontSize: 18, color: 'var(--f-text-dim)', marginTop: 12 }}>Final Behavioral & Technical Audit Profile</p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24, marginBottom: 40 }}>
                  <div className="f-card" style={{ padding: 32, textAlign: 'center' }}>
                      <div className="f-stat-lbl">Overall Score</div>
                      <div style={{ fontSize: 64, fontWeight: 800, color: avgScore >= 7 ? 'var(--f-green)' : avgScore >= 5 ? 'var(--f-accent)' : 'var(--f-red)', marginTop: 12 }}>
                          {avgScore.toFixed(1)}<span style={{ fontSize: 24, color: 'var(--f-text-dim)', marginLeft: 4 }}>/10</span>
                      </div>
                  </div>
                  <div className="f-card" style={{ padding: 32 }}>
                      <div className="f-stat-lbl">Aria Personnel Status</div>
                      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 16, color: '#fff' }}>
                        {behavior.moodScore < 35 ? 'ENCOURAGING' : behavior.moodScore > 65 ? 'CLINICAL' : 'NEUTRAL'}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--f-text-dim)', marginTop: 8 }}>Final persona drift detected during session.</div>
                  </div>
                  <div className="f-card" style={{ padding: 32 }}>
                      <div className="f-stat-lbl">AI Resources Used</div>
                      <div style={{ fontSize: 32, fontWeight: 800, marginTop: 12, color: 'var(--f-green)' }}>${totalCost.toFixed(5)}</div>
                      <div style={{ fontSize: 12, color: 'var(--f-text-dim)', marginTop: 8 }}>Total Realtime processing cost.</div>
                  </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '350px 1fr', gap: 32 }}>
                  <div className="f-card" style={{ padding: 32 }}>
                      <div className="f-label" style={{ marginBottom: 24 }}>Behavioral Footprint</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                          <div>
                              <div className="f-sub-lbl">Core Style</div>
                              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--f-accent)' }}>{behavior.style.toUpperCase()}</div>
                          </div>
                          <div>
                              <div className="f-sub-lbl">Soft Skills Mastery</div>
                              <div style={{ fontSize: 20, fontWeight: 700 }}>{behavior.softSkills}/10</div>
                          </div>
                          <div>
                              <div className="f-sub-lbl">Communication Quality</div>
                              <div style={{ fontSize: 20, fontWeight: 700 }}>{behavior.communication}/10</div>
                          </div>
                      </div>
                  </div>

                  <div className="f-card" style={{ padding: 32 }}>
                      <div className="f-label" style={{ marginBottom: 24 }}>Technical Evaluation Feed</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                          {scores.map((s, i) => (
                              <div key={i} style={{ padding: 20, background: 'rgba(255,255,255,0.02)', borderRadius: 16, border: '1px solid var(--f-border)' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                                      <div style={{ fontWeight: 700, fontSize: 16 }}>{s.topic}</div>
                                      <ScoreBadge score={s.score} />
                                  </div>
                                  <div style={{ fontSize: 13, color: 'var(--f-text-dim)', lineHeight: 1.6 }}>{s.feedback}</div>
                              </div>
                          ))}
                      </div>
                  </div>
              </div>

              <div style={{ marginTop: 60, textAlign: 'center' }}>
                  <button className="f-btn f-btn-primary" style={{ padding: '20px 60px', fontSize: 16 }} onClick={() => window.location.reload()}>
                      Finish & Exit Session
                  </button>
              </div>
          </div>
      </div>
    </div>
  );

  return (
    <div className="f-root">
      <style>{CSS}</style>
      <div className="f-live">
        
        {/* LEFT BAR: Persona & Behavior */}
        <div className="f-side">
            <div className="f-persona-card">
                <div className="f-avatar-box">
                    <div className={`f-avatar-circle ${isSpeaking ? 'speaking' : ''}`} />
                    <div className="f-eye-row">
                        <div className={`f-eye ${isSpeaking ? 'speaking' : ''}`} />
                        <div className={`f-eye ${isSpeaking ? 'speaking' : ''}`} />
                    </div>
                    <div className={`f-mouth ${isSpeaking ? 'speaking' : ''}`} />
                </div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>Aria v5</div>
                <div style={{ fontSize: 12, color: 'var(--f-text-dim)', marginTop: 4 }}>Senior Recruiter Persona</div>
                <div className="f-behavior-tag" style={{ background: observerStatus !== 'idle' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)', color: observerStatus !== 'idle' ? '#f59e0b' : '#3b82f6' }}>
                    {observerStatus !== 'idle' ? 'SYNCING INTELLIGENCE...' : `Aria: ${behavior.moodScore < 35 ? 'Encouraging' : behavior.moodScore > 65 ? 'Clinical' : 'Neutral'}`}
                </div>
                
                <div className="f-mood-meter">
                    <div className="f-mood-fill" style={{ width: `${behavior.moodScore}%`, background: `linear-gradient(90deg, var(--f-green), var(--f-accent) 50%, var(--f-red))` }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginTop: 6, color: 'var(--f-text-dim)', fontWeight: 700 }}>
                    <span>NICE</span><span>STRICT</span>
                </div>
            </div>

            <div className="f-scroll">
                {/* Candidate Sub-Scoring Audit */}
                <div className="f-stat-box">
                    <div className="f-stat-lbl">Candidate Behavior Audit</div>
                    <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8, color: behavior.softSkills >= 7 ? 'var(--f-green)' : '#f59e0b' }}>{behavior.style.toUpperCase()}</div>
                    
                    <div className="f-sub-grid">
                        <div className="f-sub-score">
                            <div className="f-sub-lbl">Soft Skills</div>
                            <div className="f-sub-val">{behavior.softSkills}/10</div>
                        </div>
                        <div className="f-sub-score">
                            <div className="f-sub-lbl">Clarity</div>
                            <div className="f-sub-val">{behavior.communication}/10</div>
                        </div>
                        <div className="f-sub-score">
                            <div className="f-sub-lbl">Confidence</div>
                            <div className="f-sub-val">{lastScore?.confidence || 'N/A'}</div>
                        </div>
                        <div className="f-sub-score">
                            <div className="f-sub-lbl">Tech Depth</div>
                            <div className="f-sub-val">{lastScore?.technicalAccuracy || '0'}/10</div>
                        </div>
                    </div>
                </div>

                <div className="f-stat-box">
                    <div className="f-stat-lbl">Technical Roadmap Progress</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
                        {!strategy && <div style={{ fontSize: 13, color: 'var(--f-text-dim)', fontStyle: 'italic' }}>Waiting for interview start...</div>}
                        {strategy?.topics.map((t: any, i: number) => {
                            const scoreEntry = scores.find(s => s.topic === t.name);
                            const isDone = !!scoreEntry;
                            const isFailed = scoreEntry && scoreEntry.score <= 1;
                            const isActive = t.name === currentTopic;
                            
                            return (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: isDone || isActive ? 1 : 0.4 }}>
                                    <div style={{ 
                                        width: 10, height: 10, borderRadius: '50%', 
                                        background: isFailed ? 'var(--f-red)' : (isDone ? 'var(--f-green)' : (isActive ? 'var(--f-accent)' : '#fff')),
                                        boxShadow: isActive ? `0 0 12px ${isFailed ? 'var(--f-red)' : (isDone ? 'var(--f-green)' : 'var(--f-accent)')}` : 'none',
                                        transition: 'all 0.4s ease'
                                    }} />
                                    <div style={{ fontSize: 12, fontWeight: isActive ? 700 : 500, color: isFailed ? 'var(--f-red)' : (isActive ? 'var(--f-accent)' : 'inherit'), letterSpacing: '0.02em' }}>
                                        {t.name.toUpperCase()} {isFailed ? '✗' : (isDone ? '✓' : '')}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                <div className="f-stat-box">
                    <div className="f-stat-val">{scores.length} <span style={{ fontSize: 14, color: 'var(--f-text-dim)' }}>/ {numQuestions}</span></div>
                    <div className="f-stat-lbl">Questions Evaluated</div>
                </div>

                {historySummary && (
                    <div className="f-memory-alert" style={{ margin: 24 }}>
                        "I am currently contextualizing our Discussion about {historySummary.slice(0, 70)}..."
                    </div>
                )}
            </div>
        </div>

        {/* MAIN PANEL: Conversation Suite */}
        <div className="f-main">
            <div className="f-header">
                <div>
                   <div style={{ fontSize: 20, fontWeight: 700 }}>{candidateName || 'Candidate'}</div>
                   <div style={{ fontSize: 12, color: 'var(--f-text-dim)', fontWeight: 600 }}>TOPIC: {currentTopic ? currentTopic.toUpperCase() : 'INITIAL CONTACT'}</div>
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--f-accent)', fontFamily: 'var(--mono)' }}>
                    {fmtTime(interviewTimeLeft)}
                </div>
            </div>

            <div className="f-transcript">
                {logs.length === 0 ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--f-text-dim)', textAlign: 'center' }}>
                         <div className="fade">
                            <div style={{ fontSize: 64, marginBottom: 20 }}>🌌</div>
                            <h3 style={{ fontSize: 20, color: '#fff', marginBottom: 8 }}>Aria is ready for you.</h3>
                            <p>Say "Hello" or "I'm ready" to begin.</p>
                         </div>
                    </div>
                ) : logs.map((log, i) => (
                    <div key={log.id} className={`f-bubble ${log.role === 'ai' ? 'f-ai-bubble' : 'f-user-bubble'} fade`}>
                        {log.text || (log.pending ? 'Aria is processing...' : '')}
                    </div>
                ))}
            </div>

            {silenceTimeLeft !== null && !isSpeaking && (
                <div style={{ padding: '0 40px 10px' }}>
                    <div style={{ height: 3, width: '100%', background: 'rgba(255,255,255,0.05)', borderRadius: 10, position: 'relative' }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(silenceTimeLeft / silenceDuration) * 100}%`, background: silenceTimeLeft < 4000 ? 'var(--f-red)' : 'var(--f-accent)', transition: 'width 0.1s linear', borderRadius: 10 }} />
                    </div>
                </div>
            )}

            <div className="f-bottom-bar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: isSpeaking ? 'var(--f-red)' : 'var(--f-green)', boxShadow: `0 0 15px ${isSpeaking ? 'var(--f-red)' : 'var(--f-green)'}` }} />
                    <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 1 }}>{callStatus.toUpperCase()}</div>
                </div>

                <div className="f-controls">
                    <button className="f-btn f-btn-secondary" style={{ fontSize: 11, background: 'rgba(59,130,246,0.1)', color: 'var(--f-accent)', border: '1px solid var(--f-accent)' }} onClick={() => setUseFriendlyUI(false)}>ARCHITECTURE VIEW</button>
                    <button className={`f-btn ${isMuted ? 'f-btn-primary' : 'f-btn-secondary'}`} onClick={toggleMute}>
                        {isMuted ? 'UNMUTE MIC' : 'MUTE MIC'}
                    </button>
                    <button className="f-btn f-btn-danger" onClick={endCall}>END INTERVIEW</button>
                </div>
            </div>
        </div>

        {/* RIGHT BAR: Strategy & Tokens */}
        <div className="f-side f-side-r">
             <div className="f-scroll" style={{ padding: 24 }}>
                 {/* STRATEGY TRACK */}
                 <div className="f-label" style={{ marginBottom: 20 }}>Conversation Strategy</div>
                 {strategy ? (
                   <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {strategy.topics.map((t: any, i: number) => (
                        <div key={i} style={{ display: 'flex', gap: 14, opacity: t.name.toLowerCase() === (currentTopic || '').toLowerCase() ? 1 : 0.4, transform: t.name.toLowerCase() === (currentTopic || '').toLowerCase() ? 'scale(1.05)' : 'scale(1)', transition: '0.4s' }}>
                            <div style={{ width: 10, height: 10, borderRadius: '50%', background: t.source === 'cv' ? '#38bdf8' : '#c084fc', marginTop: 5, boxShadow: t.name.toLowerCase() === (currentTopic || '').toLowerCase() ? `0 0 10px ${t.source === 'cv' ? '#38bdf8' : '#c084fc'}` : 'none' }} />
                            <div>
                                <div style={{ fontSize: 15, fontWeight: 700 }}>{t.name}</div>
                                <div style={{ fontSize: 10, color: 'var(--f-text-dim)', fontWeight: 600 }}>{t.source.toUpperCase()} TRACK</div>
                            </div>
                        </div>
                    ))}
                   </div>
                 ) : <div style={{ fontSize: 14, color: 'var(--f-text-dim)', fontStyle: 'italic' }}>Designing interview roadmap...</div>}

                 {/* LIVE EVALUATION TRACK (Just like Architectural) */}
                 <div className="f-label" style={{ marginTop: 40, marginBottom: 20 }}>Live Evaluation Track</div>
                 {scores.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        {[...scores].reverse().map((s: any, i: number) => (
                            <div key={i} className="f-card" style={{ padding: 16, border: '1px solid var(--f-border)', background: 'rgba(255,255,255,0.02)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', flex: 1, paddingRight: 10 }}>{s.topic}</div>
                                    <ScoreBadge score={s.score} />
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--f-text-dim)', lineHeight: 1.4, fontStyle: 'italic' }}>
                                    {s.feedback.slice(0, 80)}...
                                </div>
                            </div>
                        ))}
                    </div>
                 ) : (
                    <div style={{ fontSize: 13, color: 'var(--f-text-dim)', background: 'rgba(255,255,255,0.02)', padding: 16, borderRadius: 12, border: '1px dashed var(--f-border)' }}>
                        Waiting for technical evaluation...
                    </div>
                 )}
             </div>

             <div style={{ padding: 24, background: 'rgba(0,0,0,0.1)', borderTop: '1px solid var(--f-border)', flexShrink: 0 }}>
                 <div className="f-label" style={{ marginBottom: 16 }}>RT TOKEN INTEL</div>
                 <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                     <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                         <span style={{ fontSize: 12, color: 'var(--f-text-dim)', fontWeight: 600 }}>TOTAL COST</span>
                         <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--f-green)' }}>${totalCost.toFixed(5)}</span>
                     </div>
                     
                     <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                         <div style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid var(--f-border)' }}>
                             <div style={{ fontSize: 8, color: 'var(--f-text-dim)' }}>AUDIO IN</div>
                             <div style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8' }}>{usage.rtAudioIn.toLocaleString()}</div>
                         </div>
                         <div style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid var(--f-border)' }}>
                             <div style={{ fontSize: 8, color: 'var(--f-text-dim)' }}>AUDIO OUT</div>
                             <div style={{ fontSize: 12, fontWeight: 700, color: '#c084fc' }}>{usage.rtAudioOut.toLocaleString()}</div>
                         </div>
                         <div style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid var(--f-border)' }}>
                             <div style={{ fontSize: 8, color: 'var(--f-text-dim)' }}>TEXT IN</div>
                             <div style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa' }}>{usage.rtTextIn.toLocaleString()}</div>
                         </div>
                         <div style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid var(--f-border)' }}>
                             <div style={{ fontSize: 8, color: 'var(--f-text-dim)' }}>TEXT OUT</div>
                             <div style={{ fontSize: 12, fontWeight: 700, color: '#4ade80' }}>{usage.rtTextOut.toLocaleString()}</div>
                         </div>
                     </div>
                 </div>
             </div>

             <div style={{ marginTop: 'auto', padding: 24, borderTop: '1px solid var(--f-border)' }}>
                 <div style={{ background: 'rgba(59,130,246,0.05)', padding: 16, borderRadius: 20, fontSize: 12, color: '#93c5fd', lineHeight: 1.6, border: '1px solid rgba(59,130,246,0.1)' }}>
                     <strong>Observer Note:</strong> Aria dynamically evaluates your technical answers against the 5-tier behavioral drift engine.
                 </div>
             </div>
        </div>
      </div>
    </div>
  );
};
