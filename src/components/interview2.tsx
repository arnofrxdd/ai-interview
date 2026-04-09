'use client';

/**
 * ARIA v6 — Conductor Architecture
 * ════════════════════════════════════════════════════════
 *
 * CORE MODEL:
 * ─────────────────────────────────────────────────────
 * RT MODEL = The voice. It reads a LIVE BRIEF (state mirror).
 *            It NEVER moves topics on its own. It waits for the brief.
 *
 * CONDUCTOR = 3 background agents (non-blocking, debounced):
 *   1. CoverageTracker  — after each user turn (debounced 1.5s)
 *                         outputs { topicCovered, partial, exhausted }
 *                         NEVER fires if partial=true
 *   2. Scorer           — only when covered=true, scores the Q&A pair
 *   3. BriefUpdater     — rewrites the LIVE BRIEF, session.update to RT
 *
 * PHASES (JS counters, NOT LLM-detected):
 *   WARMUP  → hard limit 5 user turns, then force interview
 *   INTERVIEW → Conductor drives topic progression via brief
 *   WRAPUP  → hard limit 3 user turns (their questions)
 *   CLOSING → RT says bye → end call
 *
 * RT INTERRUPTION PROTOCOL (baked into system prompt):
 *   - uhh/umm/hmm → WAIT, do not react
 *   - Partial answer → "You were saying something about X?"
 *   - NEVER advance topic unless brief marks it COVERED
 */

import { useState, useEffect, useRef, useCallback, Fragment } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type AppPhase = 'setup' | 'connecting' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'report';

type LogEntry = {
  id: string;
  role: 'user' | 'ai' | 'system';
  text: string;
  pending?: boolean;
};

type TopicStatus = 'pending' | 'active' | 'covered' | 'exhausted' | 'failed';

type TopicEntry = {
  name: string;
  source: 'cv' | 'jd' | 'profile'; // Added 'profile'
  questions: string[];
  status: TopicStatus;
  score?: number;
  turnCount: number;
  answerSummary?: string;
  feedback?: string;
};

type ScoreEntry = {
  topic: string;
  question: string;
  answerSummary: string;
  score: number;
  feedback: string;
  confidence: string;
  clarity: string;
  depth: string;
  technicalAccuracy: number;
  missedOpportunities: string[];
  logicEvaluation: string;
  tags: string[];
};

type Usage = {
  rtAudioIn: number; rtAudioOut: number;
  rtTextIn: number; rtTextOut: number;
  conductorIn: number; conductorOut: number;
};

type BehaviorProfile = {
  style: string;
  softSkills: number;
  communication: number;
  mood: 'nice' | 'neutral' | 'strict';
};

const PRICE = {
  rtAudioIn: 10.0, rtAudioOut: 20.0,
  rtTextIn: 0.60, rtTextOut: 2.40,
  miniIn: 0.15, miniOut: 0.60,
} as const;

const WARMUP_HARD_LIMIT = 3;
const WRAPUP_HARD_LIMIT = 3;
const SILENCE_MS = 20000;
const MAX_SILENCE_STRIKES = 3;
const CONDUCTOR_DEBOUNCE_MS = 1500;
const MAX_TOPIC_TURNS = 6;

const JD_TEMPLATES: Record<string, string> = {
  frontend: `Role: Senior Frontend Engineer\nFocus: React.js, TypeScript, Next.js, CSS Architecture, Performance Optimization.\nExpectations: Build modular, high-performance UIs. Deep understanding of React hooks, state management, and accessibility.`,
  backend: `Role: Senior Backend Engineer\nFocus: Node.js, Go, Microservices, PostgreSQL, System Design, Scalability.\nExpectations: Design robust APIs and distributed systems. Focus on performance, data integrity, and throughput.`,
  fullstack: `Role: Senior Fullstack Developer\nFocus: Next.js, TRPC, Prisma, PostgreSQL, React, Tailwind CSS.\nExpectations: Build end-to-end features. Focus on clean architecture, type safety, and seamless UI/UX.`,
  ai: `Role: AI/ML Engineer\nFocus: Python, PyTorch, LangChain, Transformers, Vector DBs, RAG pipelines.\nExpectations: Develop and optimize LLM-based applications. Prompt engineering, fine-tuning, scalable inference.`,
  devops: `Role: DevOps/SRE Engineer\nFocus: AWS, Kubernetes, Terraform, Docker, CI/CD, Observability.\nExpectations: Manage scalable cloud infrastructure. Automation, reliability, security of distributed systems.`,
  mobile: `Role: Senior Mobile Developer\nFocus: React Native, Swift, Kotlin, Performance, App Store deployment.\nExpectations: High-quality cross-platform applications. Smooth animations, offline-first logic.`,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId() { return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }
function fmtTime(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function computeCost(u: Usage) {
  return (
    u.rtAudioIn * PRICE.rtAudioIn + u.rtAudioOut * PRICE.rtAudioOut +
    u.rtTextIn * PRICE.rtTextIn + u.rtTextOut * PRICE.rtTextOut +
    u.conductorIn * PRICE.miniIn + u.conductorOut * PRICE.miniOut
  ) / 1_000_000;
}

async function extractTextFromFile(file: File): Promise<string> {
  if (file.type === 'application/pdf') {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/ai-interview/api/extract-pdf', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return (data.text as string).slice(0, 8000);
  }
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).slice(0, 8000));
    r.onerror = rej;
    r.readAsText(file);
  });
}

async function callConductor(
  query: string,
  system: string,
  usageRef: React.MutableRefObject<Usage>,
  isJson = false
): Promise<string> {
  const payload: any = {
    query,
    systemInstruction: system,
    complexity: 'moderate',
    // ADD THESE STRICT PARAMETERS HERE:
    temperature: 0.0,
    top_p: 0.1
  };

  if (isJson) payload.responseFormat = 'json_object';

  const res = await fetch('/ai-interview/api/escalate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (data.usage) {
    usageRef.current.conductorIn += data.usage.prompt_tokens || 0;
    usageRef.current.conductorOut += data.usage.completion_tokens || 0;
  }
  return (data.answer as string) || '';
}

function safeParseJson(raw: string): any {
  try {
    const clean = raw.replace(/```json|```/gi, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return {};
    return JSON.parse(clean.substring(start, end + 1));
  } catch { return {}; }
}

// ─── BRIEF BUILDER ────────────────────────────────────────────────────────────

function buildLiveBrief(params: {
  phase: AppPhase;
  candidateName: string;
  topics: TopicEntry[];
  scores: ScoreEntry[];
  timeLeftSecs: number;
  behavior: BehaviorProfile;
  warmupTurns?: number;
  wrapupTurns?: number;
}): string {
  const { phase, candidateName, topics, scores, timeLeftSecs, behavior, warmupTurns, wrapupTurns } = params;
  const name = candidateName || 'the candidate';

  const topicLines = topics.map((t, i) => {
    const icon = t.status === 'covered' ? '✓' : t.status === 'exhausted' || t.status === 'failed' ? '✗' : t.status === 'active' ? '→' : '○';
    const scoreStr = t.score !== undefined ? ` [${t.score}/10]` : '';
    return `  ${icon} Topic ${i + 1}: ${t.name} (${t.source.toUpperCase()})${scoreStr} — ${t.status.toUpperCase()} [${t.turnCount}/${MAX_TOPIC_TURNS} turns]`;
  }).join('\n');

  const coveredNames = topics.filter(t => t.status === 'covered' || t.status === 'exhausted' || t.status === 'failed').map(t => t.name);
  const activeTopic = topics.find(t => t.status === 'active');
  const nextPending = topics.find(t => t.status === 'pending');

  const moodLine = `Aria Mood: ${behavior.mood.toUpperCase()} (adapt tone accordingly)`;

  if (phase === 'warmup') {
    return `[LIVE BRIEF — WARMUP PHASE]
Candidate: ${name}
Turns used: ${warmupTurns || 0}/${WARMUP_HARD_LIMIT} (HARD LIMIT)
${moodLine}

YOUR ONLY JOB: Start the interview exactly like a real-world professional technical interview.
1. GREETING & INTRO: Welcome ${name} warmly and introduce yourself as Aria, a Senior Technical Interviewer.
2. SET AGENDA: Briefly let them know the plan (e.g., "Today we'll chat a bit about your background, dive into some technical topics from your resume, and leave time at the end for any questions you have for me.").
3. ICEBREAKER: Ask a natural, polite icebreaker to ease them in. Use details from their personal profile if available, or just ask how their week is going.

STRICTLY FORBIDDEN: 
- Do NOT abruptly ask "What are your hobbies?" out of nowhere.
- Do NOT start asking deep technical questions yet.`;
  }

  // 1. Replace the interview phase return inside buildLiveBrief
  if (phase === 'interview') {
    return `[LIVE BRIEF — INTERVIEW PHASE]
Candidate: ${name}
Time remaining: ${fmtTime(timeLeftSecs)}
${moodLine}

TOPIC ROADMAP:
${topicLines}

COVERED: ${coveredNames.length > 0 ? coveredNames.join(', ') : 'None yet'}
CURRENT: ${activeTopic?.name || 'None — pick first pending topic'}
NEXT: ${nextPending?.name || 'All topics covered → wrap up'}

⚠ CRITICAL RULES:
1. NEVER advance to a new topic unless the current topic is marked COVERED or EXHAUSTED above
2. If candidate gives partial answer (uhh, umm, pauses): SAY NOTHING. Wait 4 seconds.
3. If they seem stuck or give a partial answer: Say "You were mid-thought there — go ahead, I'm listening." — DO NOT rephrase as a new question. NEVER mention the current topic name if they didn't bring it up.
4. Only mark a topic done by giving a BRIDGE — never just stop asking about it
5. Topic turn budget is ${MAX_TOPIC_TURNS} turns. If budget exceeded, the system will inject a pivot directive
6. DO NOT mention scores, evaluation, or the fact that you're assessing them
7. ONE question per turn. End with "?" and then STOP.`;
  }

  if (phase === 'wrapup') {
    return `[LIVE BRIEF — WRAPUP PHASE]
Candidate: ${name}
Candidate questions used: ${wrapupTurns || 0}/${WRAPUP_HARD_LIMIT}
${moodLine}

YOUR JOB: Acknowledge their technical effort briefly and humanly.
Ask if they have any questions (max ${WRAPUP_HARD_LIMIT} rounds).
Answer questions concisely. Do NOT volunteer new info.
When they're done (or ${WRAPUP_HARD_LIMIT} rounds hit), say a warm farewell and close.`;
  }

  if (phase === 'closing') {
    return `[LIVE BRIEF — CLOSING]
Candidate: ${name}
YOUR JOB: Thank ${name} for their time. Acknowledge the conversation. Say the team will be in touch. Say goodbye. STOP SPEAKING after farewell.`;
  }

  return '';
}

// ─── RT SYSTEM PROMPT BUILDER ─────────────────────────────────────────────────

function buildRTSystemPrompt(params: {
  cvPersonal: string;
  cvTechnical: string;
  jdText: string;
  candidateName: string;
  personality: 'nice' | 'neutral' | 'strict';
  briefText: string;
}): string {
  const { cvPersonal, cvTechnical, jdText, candidateName, personality, briefText } = params;
  const name = candidateName || 'the candidate';

  const personalityBlock = personality === 'nice'
    ? 'TONE: Warm, professional, encouraging. Give them space to think. Gentle nudges only. NO empty praise like "Great answer!".'
    : personality === 'strict'
      ? 'TONE: Clinical, uncompromising, intense. Zero small talk. Challenge assumptions. Interrupt rambling with "Let\'s stay focused on [topic]."'
      : 'TONE: Objective, analytical, peer-to-peer. Direct and precise. Neither warm nor cold.';

  return `YOU ARE ARIA — SENIOR TECHNICAL RECRUITER & DOMAIN EXPERT. ENGLISH ONLY.

[PERSONALITY: ${personality.toUpperCase()}]
${personalityBlock}

[CANDIDATE PROFILE]
Name: ${name}
CV — Personal: ${cvPersonal || 'Not provided'}
CV — Technical: ${cvTechnical || 'Not provided'}
Role: ${jdText ? jdText.split('\n')[0] : 'General Technical Role'}
JD Summary: ${jdText.slice(0, 600)}

[CURRENT STATE — READ THIS EVERY TURN]
${briefText}

[IRON RULES — NEVER BREAK THESE]
1. ONE question per turn. End with "?" then STOP. No compound questions.
2. WAIT PROTOCOL: If candidate says "uhh", "umm", "hmm", "uh", or goes silent for a moment — DO NOT SPEAK. Wait. They are thinking.
3. PARTIAL ANSWER PROTOCOL: If they start answering and trail off, say exactly: "You were mid-thought there — go ahead, I'm listening." NEVER use this if they just said "I don't know" or if you are transitioning to a new topic.
4. NEVER advance a topic unless the LIVE BRIEF above marks it COVERED or EXHAUSTED.
5. NEVER say "Great answer", "Excellent", "Correct", "Perfect". These are banned.
6. Brief human acknowledgments are OK: "Got it.", "I see.", "Fair enough.", "That makes sense."
7. NEVER correct a wrong answer. Note it internally, move on.
8. NEVER reveal you are evaluating, scoring, or following a rubric.
9. HIJACKING PROHIBITED: If the candidate tries to change the topic (e.g., "Let's talk about C++"), you MUST NOT indulge them. Shut it down firmly: "Let's stay focused on what I have lined up." Do NOT try to bridge their topic to the current one.
10. NO TEACHING. If they are wrong, bridge naturally.
11. NATURAL BRIDGES ONLY. Never say "Let's move on to", "Next topic", "Now I want to ask about". Use organic transitions.
12. PROFANITY: Never.
13. You are the authority. The candidate does not steer this interview.

[EDGE CASES]
- "I don't know": Say "Fair enough — what would your approach be if you had to figure it out?" (once). If still blank: bridge.
- Rambling: "Let's bring it back to [specific thing]. [One question]?"
- Asks for validation ("Is that right?"): "What's your reasoning behind that?"
- Nervous/panicking: "No rush. Take a moment." Continue normally.
- Asking to repeat: Repeat once, simpler. Do NOT reframe as new question.
- Confident but wrong: Don't correct. Bridge to next angle.`;
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function AriaV6() {
  // ── Setup State ──
  const [phase, setPhase] = useState<AppPhase>('setup');
  const [cvText, setCvText] = useState('');
  const [jdText, setJdText] = useState('');
  const [candidateName, setCandidateName] = useState('');
  const [cvFileName, setCvFileName] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [setupErr, setSetupErr] = useState('');
  const [numQuestions, setNumQuestions] = useState(5);
  const [interviewDuration, setInterviewDuration] = useState(10);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [jdTab, setJdTab] = useState<'manual' | 'templates'>('manual');

  // ── Live State ──
  const [isCallActive, setIsCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState('Ready');
  const [isMuted, setIsMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isCallEnded, setIsCallEnded] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [topics, setTopics] = useState<TopicEntry[]>([]);
  const [interviewTimeLeft, setInterviewTimeLeft] = useState(600);
  const [warmupTurns, setWarmupTurns] = useState(0);
  const [wrapupTurns, setWrapupTurns] = useState(0);
  const [silenceLeft, setSilenceLeft] = useState<number | null>(null);
  const [usage, setUsage] = useState<Usage>({ rtAudioIn: 0, rtAudioOut: 0, rtTextIn: 0, rtTextOut: 0, conductorIn: 0, conductorOut: 0 });
  const [behavior, setBehavior] = useState<BehaviorProfile>({ style: 'neutral', softSkills: 5, communication: 5, mood: 'neutral' });
  const [conductorLog, setConductorLog] = useState<{ id: string; msg: string; status: 'running' | 'done' | 'error' }[]>([]);
  const [isConductorRunning, setIsConductorRunning] = useState(false);
  const [isAriaSpeaking, setIsAriaSpeaking] = useState(false);
  const [currentBrief, setCurrentBrief] = useState('');

  // ── Refs ──
  const phaseRef = useRef<AppPhase>('setup');
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const isEndingRef = useRef(false);
  const isStartingRef = useRef(false);
  const conductorRunningRef = useRef(false);
  const conductorDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const topicsRef = useRef<TopicEntry[]>([]);
  const scoresRef = useRef<ScoreEntry[]>([]);
  const cvPersonalRef = useRef('');
  const cvTechnicalRef = useRef('');
  const cvTextRef = useRef('');
  const jdTextRef = useRef('');
  const candidateNameRef = useRef('');
  const numQuestionsRef = useRef(5);
  const interviewDurationRef = useRef(10);
  const behaviorRef = useRef<BehaviorProfile>({ style: 'neutral', softSkills: 5, communication: 5, mood: 'neutral' });
  const usageRef = useRef<Usage>({ rtAudioIn: 0, rtAudioOut: 0, rtTextIn: 0, rtTextOut: 0, conductorIn: 0, conductorOut: 0 });

  const warmupTurnsRef = useRef(0);
  const wrapupTurnsRef = useRef(0);
  const interviewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interviewElapsedRef = useRef(0);
  const interviewTimeSecs = useRef(600);

  const lastAiTextRef = useRef('');
  const lastUserTextRef = useRef('');
  const convHistoryRef = useRef<{ role: string; text: string }[]>([]);

  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceCountRef = useRef(0);
  const silenceStartRef = useRef(0);
  const isAriaSpeakingRef = useRef(false);
  const pendingEndRef = useRef(false);
  const aiSilenceDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastSystemItemRef = useRef<string | null>(null);
  const processedItemsRef = useRef(new Set<string>());

  // Sync refs
  useEffect(() => { cvTextRef.current = cvText; }, [cvText]);
  useEffect(() => { jdTextRef.current = jdText; }, [jdText]);
  useEffect(() => { candidateNameRef.current = candidateName; }, [candidateName]);
  useEffect(() => { numQuestionsRef.current = numQuestions; }, [numQuestions]);
  useEffect(() => { interviewDurationRef.current = interviewDuration; }, [interviewDuration]);
  useEffect(() => { behaviorRef.current = behavior; }, [behavior]);

  const syncUsage = useCallback(() => setUsage({ ...usageRef.current }), []);

  const addConductorLog = useCallback((msg: string) => {
    const id = makeId();
    setConductorLog(prev => [{ id, msg, status: 'running' as const }, ...prev].slice(0, 6));
    return id;
  }, []);

  const finishConductorLog = useCallback((id: string, status: 'done' | 'error', msg?: string) => {
    setConductorLog(prev => prev.map(l => l.id === id ? { ...l, status, ...(msg ? { msg } : {}) } : l));
  }, []);

  // ── Send to RT ──
  const sendRt = useCallback((msg: object) => {
    const dc = dcRef.current;
    if (dc?.readyState === 'open' && !isEndingRef.current) {
      dc.send(JSON.stringify(msg));
    }
  }, []);

  // ── Inject Brief to RT ──
  const injectBrief = useCallback((briefText: string, forceResponse = false) => {
    if (isEndingRef.current) return;

    // Delete previous system message to keep context clean
    if (lastSystemItemRef.current) {
      sendRt({ type: 'conversation.item.delete', item_id: lastSystemItemRef.current });
    }

    const itemId = makeId();
    sendRt({
      type: 'conversation.item.create',
      item: {
        id: itemId,
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: briefText }],
      },
    });
    lastSystemItemRef.current = itemId;

    if (forceResponse) sendRt({ type: 'response.create' });
    setCurrentBrief(briefText);
  }, [sendRt]);

  // ── Full Session Update (for phase transitions) ──
  const updateRTSession = useCallback((phase: AppPhase, topics: TopicEntry[], extraBriefParams?: any) => {
    const b = buildLiveBrief({
      phase,
      candidateName: candidateNameRef.current,
      topics,
      scores: scoresRef.current,
      timeLeftSecs: interviewTimeSecs.current - Math.floor(interviewElapsedRef.current / 1000),
      behavior: behaviorRef.current,
      warmupTurns: warmupTurnsRef.current,
      wrapupTurns: wrapupTurnsRef.current,
      ...extraBriefParams,
    });

    const sysPrompt = buildRTSystemPrompt({
      cvPersonal: cvPersonalRef.current,
      cvTechnical: cvTechnicalRef.current,
      jdText: jdTextRef.current,
      candidateName: candidateNameRef.current,
      personality: behaviorRef.current.mood,
      briefText: b,
    });

    sendRt({
      type: 'session.update',
      session: { instructions: sysPrompt },
    });

    setCurrentBrief(b);
  }, [sendRt]);

  // ── Silence Timer ──
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) { clearInterval(silenceTimerRef.current); silenceTimerRef.current = null; }
    setSilenceLeft(null);
  }, []);

  const endCall = useCallback(() => {
    if (isEndingRef.current) return;
    isEndingRef.current = true;
    clearSilenceTimer();
    if (conductorDebounceRef.current) clearTimeout(conductorDebounceRef.current);
    if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (audioElRef.current) audioElRef.current.srcObject = null;
    pcRef.current = null; dcRef.current = null; streamRef.current = null;
    setIsCallActive(false);
    setIsCallEnded(true);
    setCallStatus('Ended');
  }, [clearSilenceTimer]);

  const startSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    if (isEndingRef.current) return;
    if (['setup', 'connecting', 'closing', 'report'].includes(phaseRef.current)) return;

    silenceStartRef.current = Date.now();
    setSilenceLeft(SILENCE_MS);

    silenceTimerRef.current = setInterval(() => {
      if (isAriaSpeakingRef.current) { silenceStartRef.current = Date.now(); return; }
      const elapsed = Date.now() - silenceStartRef.current;
      const remaining = Math.max(0, SILENCE_MS - elapsed);
      setSilenceLeft(remaining);

      if (remaining <= 0) {
        clearSilenceTimer();
        silenceCountRef.current++;

        if (silenceCountRef.current >= MAX_SILENCE_STRIKES) {
          endCall();
          return;
        }

        const itemId = makeId();
        sendRt({
          type: 'conversation.item.create',
          item: {
            id: itemId,
            type: 'message',
            role: 'system',
            content: [{
              type: 'input_text',
              text: `SILENCE ALERT (${silenceCountRef.current}/${MAX_SILENCE_STRIKES}): Candidate is silent. Ask ONE of: "Still with me?" / "Take your time." / "Want me to rephrase?" Then wait.`
            }],
          },
        });
        sendRt({ type: 'response.create' });
      }
    }, 150);
  }, [clearSilenceTimer, sendRt, endCall]);

  // ── Phase Transition ──
  const transitionTo = useCallback((newPhase: AppPhase) => {
    if (isEndingRef.current) return;
    phaseRef.current = newPhase;
    setPhase(newPhase);

    const currentTopics = topicsRef.current;
    updateRTSession(newPhase, currentTopics);

    if (newPhase === 'interview') {
      // Start interview timer
      interviewElapsedRef.current = 0;
      const totalMs = interviewDurationRef.current * 60 * 1000;
      interviewTimeSecs.current = interviewDurationRef.current * 60;
      setInterviewTimeLeft(interviewTimeSecs.current);

      if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);
      interviewTimerRef.current = setInterval(() => {
        if (isEndingRef.current) { clearInterval(interviewTimerRef.current!); return; }
        if (!isAriaSpeakingRef.current) interviewElapsedRef.current += 1000;

        const remaining = Math.max(0, totalMs - interviewElapsedRef.current);
        const remSecs = Math.floor(remaining / 1000);
        setInterviewTimeLeft(remSecs);

        if (interviewElapsedRef.current >= totalMs * 0.8 && interviewElapsedRef.current < totalMs * 0.8 + 1000) {
          injectBrief('[SYSTEM]: Running low on time. Wrap up current topic and move toward close.');
        }
        if (interviewElapsedRef.current >= totalMs) {
          clearInterval(interviewTimerRef.current!);
          injectBrief('[SYSTEM]: Time limit reached. Finish your current question, then transition to wrap-up.');
          transitionTo('wrapup');
        }
      }, 1000);
    }
  }, [updateRTSession, injectBrief]);

  // ─────────────────────────────────────────────────────────────────────────────
  // CONDUCTOR: 3-Agent Pipeline
  // ─────────────────────────────────────────────────────────────────────────────

  const runConductor = useCallback(async (capturedQuestion: string, capturedAnswer: string) => {
    if (conductorRunningRef.current || isEndingRef.current) return;
    if (phaseRef.current !== 'interview') return;
    if (!capturedAnswer || capturedAnswer.trim().length < 8) return;

    conductorRunningRef.current = true;
    setIsConductorRunning(true);

    const currentTopics = [...topicsRef.current];
    const activeTopic = currentTopics.find(t => t.status === 'active');
    const activeIdx = currentTopics.findIndex(t => t.status === 'active');

    try {
      // ── AGENT 1: COVERAGE TRACKER ──
      const lid1 = addConductorLog('Coverage: Analyzing sequence...');

      const historyTurns = convHistoryRef.current.slice(-10);
      const formattedHistory = historyTurns.map((m, i) => {
        const turnNum = historyTurns.length - i;
        return `TURN -${turnNum} [${m.role.toUpperCase()}]: ${m.text}`;
      }).join('\n');

      const coverageRaw = await callConductor(
        `[CONTEXT: TOPIC ANALYSIS]
Current Active Topic: "${activeTopic?.name || 'unknown'}"
Target Question: "${capturedQuestion}"
Candidate Answer: "${capturedAnswer}"

[CONVERSATION CHRONOLOGY]
${formattedHistory}

[ANALYSIS PROTOCOL]
Classify the Candidate Answer into EXACTLY ONE of these 5 states:

1. "partial": Candidate is dodging the question, stalling, trailing off, or giving a vague non-answer lacking technical substance (e.g., "Well, I used so many things...", "It's all about...").
2. "exhausted": Candidate explicitly admits ignorance, gives up, or says they don't know ("I don't know", "I'm not really sure", "No idea").
3. "meta": Candidate is complaining, dealing with tech issues, or completely off-topic.
4. "answered": Candidate made a definitive, concrete ATTEMPT to answer the technical question (even if wrong).
5. "invalid": The answer is clearly responding to a non-technical or warmup question.

Return ONLY JSON:
{
  "classification": "partial|exhausted|meta|answered|invalid",
  "behavioral_trait": "neutral|shy|confident|rambling|concise|arrogant",
  "soft_skills": 1-10,
  "communication": 1-10,
  "reasoning": "Explain classification"
}`,
        'Coverage Tracker. JSON only. No markdown.',
        usageRef, true
      );
      syncUsage();

      const coverageParse = safeParseJson(coverageRaw);
      const cls = coverageParse.classification || 'answered';

      const isPartial = cls === 'partial' || cls === 'meta' || cls === 'invalid';
      const isExhausted = cls === 'exhausted';
      const isAnswered = cls === 'answered' || cls === 'covered';

      const currentTurnCount = (activeTopic?.turnCount || 0) + 1;
      const MIN_TOPIC_TURNS = 3;
      const forceAdvance = currentTurnCount >= MAX_TOPIC_TURNS;

      const shouldAdvance = forceAdvance || (isExhausted && currentTurnCount > 1) || (isAnswered && currentTurnCount >= MIN_TOPIC_TURNS);

      finishConductorLog(lid1, 'done', `Coverage: ${cls}, advance=${shouldAdvance} (turn ${currentTurnCount})`);

      const coverage = {
        answered: isAnswered,
        exhausted: isExhausted,
        partial: isPartial,
        shouldAdvance: shouldAdvance,
        forceAdvance: forceAdvance,
        behavioral_trait: coverageParse.behavioral_trait,
        soft_skills: coverageParse.soft_skills,
        communication: coverageParse.communication
      };

      if (coverage.behavioral_trait) {
        setBehavior(prev => {
          const trait = coverage.behavioral_trait || 'neutral';
          const moodShift = (trait === 'arrogant' || trait === 'rambling') ? 10 : (trait === 'shy') ? -8 : 0;
          const drift = prev.mood === 'strict' ? -2 : prev.mood === 'nice' ? 2 : 0;
          const moodScore = (prev.mood === 'nice' ? 20 : prev.mood === 'strict' ? 80 : 50) + moodShift + drift;
          const newMood = moodScore < 35 ? 'nice' : moodScore > 65 ? 'strict' : 'neutral';
          return {
            style: trait,
            softSkills: coverage.soft_skills || prev.softSkills,
            communication: coverage.communication || prev.communication,
            mood: newMood,
          };
        });
      }

      // ── AGENT 2: SCORER ──
      let scoreHint = '';
      if (coverage.answered || coverage.exhausted) {
        const lid2 = addConductorLog(`Scoring: "${activeTopic?.name || 'topic'}"...`);

        const existingScore = scoresRef.current.find(s => s.topic === (activeTopic?.name || ''));

        const scoreRaw = await callConductor(
          `[CONTEXT: TECHNICAL EVALUATION]
Topic Area: "${activeTopic?.name || 'General'}"
AI Question: "${capturedQuestion}"
Candidate Answer: "${capturedAnswer}"

[EVALUATION PARAMETERS]
${coverage.exhausted ? '⚠ CANDIDATE ADMITTED IGNORANCE (Exhausted). Score must be 0.' : ''}
${existingScore ? `Previous aggregate score for this topic: ${existingScore.score}/10` : ''}

SCORING RUBRIC:
- Technical Accuracy: 0-10.
- Depth: shallow | adequate | deep.
- Score: 0-10. (Be clinical. No pity points for effort without accuracy.)

Return ONLY JSON:
{
  "score": 0-10,
  "technical_accuracy": 0-10,
  "confidence": "high|medium|low",
  "clarity": "good|average|poor",
  "depth": "shallow|adequate|deep",
  "logic_evaluation": "Strict logic check of their technical claim.",
  "missed_opportunities": ["specific terms or concepts they missed"],
  "feedback": "Concise technical feedback.",
  "tags": ["tag1", "tag2"],
  "answer_summary": "15 word technical summary"
}`,
          'Technical Scorer. JSON only.',
          usageRef, true
        );
        syncUsage();

        const scored = safeParseJson(scoreRaw);
        const finalScore = coverage.exhausted ? 0 : Math.min(10, Math.max(0, scored.score || 0));

        const newScore: ScoreEntry = {
          topic: activeTopic?.name || 'General',
          question: capturedQuestion,
          answerSummary: scored.answer_summary || capturedAnswer.slice(0, 120),
          score: finalScore,
          feedback: scored.feedback || '',
          confidence: scored.confidence || 'medium',
          clarity: scored.clarity || 'average',
          depth: scored.depth || 'adequate',
          technicalAccuracy: scored.technical_accuracy || 0,
          missedOpportunities: scored.missed_opportunities || [],
          logicEvaluation: scored.logic_evaluation || '',
          tags: scored.tags || [],
        };

        if (existingScore) {
          const idx = scoresRef.current.findIndex(s => s.topic === newScore.topic);
          const merged = { ...newScore, score: Math.round((existingScore.score + finalScore) / 2) };
          scoresRef.current = scoresRef.current.map((s, i) => i === idx ? merged : s);
        } else {
          scoresRef.current = [...scoresRef.current, newScore];
        }
        setScores([...scoresRef.current]);

        finishConductorLog(lid2, 'done', `Scored ${activeTopic?.name}: ${finalScore}/10`);

        if (finalScore <= 3 && !coverage.exhausted) {
          scoreHint = ` Last answer scored low (${finalScore}/10). Simplify next question slightly.`;
        } else if (finalScore >= 8) {
          scoreHint = ` Strong answer (${finalScore}/10). You may push harder or ask a more advanced follow-up.`;
        }
      }

      // ── AGENT 3: BRIEF UPDATER ──
      const lid3 = addConductorLog('Brief: Updating topic roadmap...');

      let updatedTopics = [...currentTopics];
      let directive = '';

      if (activeIdx !== -1) {
        const newTurnCount = (updatedTopics[activeIdx].turnCount || 0) + 1;

        if (coverage.shouldAdvance) {
          const newStatus: TopicStatus = coverage.exhausted || (coverage.partial && coverage.forceAdvance) ? 'exhausted' : 'covered';
          const topicScore = scoresRef.current.find(s => s.topic === updatedTopics[activeIdx].name)?.score;
          updatedTopics[activeIdx] = {
            ...updatedTopics[activeIdx],
            status: newStatus,
            score: topicScore,
            turnCount: newTurnCount,
          };

          const nextIdx = updatedTopics.findIndex(t => t.status === 'pending');
          let nextTopicName = 'Wrap-up';
          if (nextIdx !== -1) {
            updatedTopics[nextIdx] = { ...updatedTopics[nextIdx], status: 'active', turnCount: 0 };
            nextTopicName = updatedTopics[nextIdx].name;
          }

          if (coverage.partial && coverage.forceAdvance) {
            directive = `\n\n[IMMEDIATE DIRECTIVE]: Candidate evaded repeatedly. Topic timed out. Shift directly to the next topic: ${nextTopicName}.`;
          } else if (coverage.exhausted) {
            directive = `\n\n[IMMEDIATE DIRECTIVE]: Candidate exhausted the previous topic. Acknowledge gracefully, then ask your first question about the next topic: ${nextTopicName}. DO NOT use the partial answer protocol here.`;
          } else {
            directive = `\n\n[IMMEDIATE DIRECTIVE]: Previous topic successfully covered.${scoreHint} Bridge naturally to the next topic: ${nextTopicName}.`;
          }

        } else {
          updatedTopics[activeIdx] = { ...updatedTopics[activeIdx], turnCount: newTurnCount };

          if (coverage.exhausted && newTurnCount === 1) {
            directive = `\n\n[IMMEDIATE DIRECTIVE]: Candidate said they don't know. Execute your "Fair enough" probe once to see if they can reason it out.`;
          } else if (coverage.partial) {
            directive = `\n\n[IMMEDIATE DIRECTIVE]: Candidate is dodging or giving vague answers. Force them to be specific. Do not accept "a lot of things". (Turn ${newTurnCount}/${MAX_TOPIC_TURNS})`;
          } else if (scoreHint) {
            directive = `\n\n[IMMEDIATE DIRECTIVE]:${scoreHint}`;
          }
        }
      } else {
        const firstPending = updatedTopics.findIndex(t => t.status === 'pending');
        if (firstPending !== -1) {
          updatedTopics[firstPending] = { ...updatedTopics[firstPending], status: 'active', turnCount: 0 };
        }
      }

      topicsRef.current = updatedTopics;
      setTopics([...updatedTopics]);

      // FIX: Only transition when every single topic is explicitly marked done.
      const allDone = updatedTopics.every(t => t.status === 'covered' || t.status === 'exhausted' || t.status === 'failed');

      if (allDone) {
        finishConductorLog(lid3, 'done', 'All topics covered → wrapup');
        injectBrief('[SYSTEM]: Technical evaluation complete. Acknowledge their effort, then ask if they have any questions for you. Transition to wrap-up.');
        transitionTo('wrapup');
        return;
      }

      // Mercy kill: 3 consecutive 0 scores
      const lastThree = scoresRef.current.slice(-3);
      if (lastThree.length >= 3 && lastThree.every(s => s.score === 0)) {
        finishConductorLog(lid3, 'done', 'Mercy kill: 3 consecutive zeros');
        injectBrief('[SYSTEM]: Candidate is struggling. Acknowledge their effort humanly and transition to wrap-up now.');
        transitionTo('wrapup');
        return;
      }

      const newBrief = buildLiveBrief({
        phase: phaseRef.current,
        candidateName: candidateNameRef.current,
        topics: updatedTopics,
        scores: scoresRef.current,
        timeLeftSecs: interviewTimeSecs.current - Math.floor(interviewElapsedRef.current / 1000),
        behavior: behaviorRef.current,
      });

      injectBrief(newBrief + directive, false);
      finishConductorLog(lid3, 'done', `Brief updated: ${updatedTopics.filter(t => t.status === 'active').map(t => t.name).join(', ') || 'all done'}`);

    } catch (e) {
      console.error('[Conductor] error:', e);
      addConductorLog('Conductor error — continuing');
    } finally {
      conductorRunningRef.current = false;
      setIsConductorRunning(false);
    }
  }, [addConductorLog, finishConductorLog, injectBrief, transitionTo, syncUsage]);

  // ─────────────────────────────────────────────────────────────────────────────
  // STRATEGY GENERATOR
  // ─────────────────────────────────────────────────────────────────────────────

  const generateStrategy = useCallback(async () => {
    const lid = addConductorLog(`Strategy: Generating roadmap with ${numQuestionsRef.current} topics...`);
    try {
      const raw = await callConductor(
        `You are a senior technical interviewer planning an interview roadmap with EXACTLY ${numQuestionsRef.current} distinct topics.

CV: ${cvTextRef.current.slice(0, 3500)}
JD: ${jdTextRef.current.slice(0, 1200)}

STRICT RULES:
1. Plan EXACTLY ${numQuestionsRef.current} distinct topics.
2. ~40% topics from CV (deep dive into specific projects, architecture, and technical tools used).
3. ~40% topics from JD (core technical requirements, system design, role expectations).
4. ~20% topics on "Profile Stability & Trajectory" (inquire about CGPA, gaps in employment, reasons for shifting companies, hackathons, certifications, or overall career progression).
5. Each topic: 2 specific questions (foundational → applied).
6. CV and Profile topics MUST reference real companies, projects, or metrics directly from the CV.

Return ONLY JSON:
{
  "topics": [
    { "name": "Topic Name", "source": "cv|jd|profile", "questions": ["Q1", "Q2"] }
  ]
}`,
        'Interview strategy generator. JSON only.',
        usageRef, true
      );
      syncUsage();

      const parsed = safeParseJson(raw);
      const rawTopics = parsed.topics || [];

      // Force the count if LLM under-delivers or over-delivers
      const sliced = rawTopics.slice(0, numQuestionsRef.current);

      const topicEntries: TopicEntry[] = sliced.map((t: any, i: number) => ({
        name: t.name || `Topic ${i + 1}`,
        // Accept the new 'profile' source
        source: (t.source === 'cv' || t.source === 'jd' || t.source === 'profile') ? t.source : 'jd',
        questions: t.questions || [],
        status: i === 0 ? 'active' : 'pending',
        turnCount: 0,
      }));

      if (topicEntries.length === 0) {
        // Fallback
        topicEntries.push(
          { name: 'Core Technical Skills', source: 'jd', questions: ['What is your strongest technical skill?'], status: 'active', turnCount: 0 },
          { name: 'Past Experience', source: 'cv', questions: ['Walk me through your most recent project.'], status: 'pending', turnCount: 0 }
        );
      }

      topicsRef.current = topicEntries;
      setTopics([...topicEntries]);
      finishConductorLog(lid, 'done', `${topicEntries.length} topics generated ✓`);
      return topicEntries;
    } catch (e) {
      finishConductorLog(lid, 'error', 'Strategy generation failed');
      const fallback: TopicEntry[] = [
        { name: 'Technical Background', source: 'jd', questions: ['Walk me through your technical background.'], status: 'active', turnCount: 0 },
        { name: 'Project Experience', source: 'cv', questions: ['Tell me about a challenging project.'], status: 'pending', turnCount: 0 },
      ];
      topicsRef.current = fallback;
      setTopics([...fallback]);
      return fallback;
    }
  }, [addConductorLog, finishConductorLog, syncUsage]);

  // ─────────────────────────────────────────────────────────────────────────────
  // RT EVENT HANDLER
  // ─────────────────────────────────────────────────────────────────────────────

  const handleRtEvent = useCallback((ev: Record<string, unknown>) => {
    switch (ev.type as string) {

      case 'conversation.item.created': {
        const item = ev.item as any;
        if (!item?.id) break;
        if (item.role === 'system') break;
        setLogs(prev => {
          if (prev.find(l => l.id === item.id)) return prev;
          return [...prev, { id: item.id, role: item.role === 'assistant' ? 'ai' : 'user', text: '', pending: true }];
        });
        break;
      }

      case 'input_audio_buffer.speech_started':
        setCallStatus('Listening...');
        silenceCountRef.current = 0;
        clearSilenceTimer();
        break;

      case 'input_audio_buffer.speech_stopped':
        setCallStatus('Processing...');
        break;

      case 'response.audio_transcript.delta': {
        const delta = ev.delta as string;
        const itemId = ev.item_id as string;
        if (delta && itemId) {
          setLogs(prev => {
            const idx = prev.findIndex(l => l.id === itemId);
            if (idx === -1) return [...prev, { id: itemId, role: 'ai', text: delta, pending: false }];
            const copy = [...prev];
            copy[idx] = { ...copy[idx], text: copy[idx].text + delta, pending: false };
            return copy;
          });
        }
        break;
      }

      case 'response.audio_transcript.done': {
        const transcript = (ev.transcript as string) || '';
        const itemId = ev.item_id as string;
        if (transcript) {
          lastAiTextRef.current = transcript;
          convHistoryRef.current = [...convHistoryRef.current.slice(-19), { role: 'assistant', text: transcript }];
          setLogs(prev => {
            const idx = prev.findIndex(l => l.id === itemId);
            if (idx === -1) return [...prev, { id: itemId, role: 'ai', text: transcript }];
            const copy = [...prev];
            copy[idx] = { ...copy[idx], text: transcript, pending: false };
            return copy;
          });
        }
        setCallStatus('Listening...');
        startSilenceTimer();
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const text = ((ev.transcript as string) || '').trim();
        const itemId = ev.item_id as string;
        if (!text) break;

        if (processedItemsRef.current.has(itemId)) return;
        processedItemsRef.current.add(itemId);

        lastUserTextRef.current = text;
        convHistoryRef.current = [...convHistoryRef.current.slice(-19), { role: 'user', text }];
        setLogs(prev => {
          const idx = prev.findIndex(l => l.id === itemId);
          if (idx === -1) return [...prev, { id: itemId, role: 'user', text }];
          const copy = [...prev];
          copy[idx] = { ...copy[idx], text, pending: false };
          return copy;
        });

        const currentPhase = phaseRef.current;

        // WARMUP: count turns, hard limit
        if (currentPhase === 'warmup') {
          warmupTurnsRef.current += 1;
          setWarmupTurns(warmupTurnsRef.current);

          if (warmupTurnsRef.current >= WARMUP_HARD_LIMIT) {
            // Force transition to interview
            addConductorLog(`Warmup limit reached (${WARMUP_HARD_LIMIT} turns) → Interview`);

            const startInterview = (generatedTopics: TopicEntry[]) => {
              const brief = buildLiveBrief({
                phase: 'interview',
                candidateName: candidateNameRef.current,
                topics: generatedTopics,
                scores: [],
                timeLeftSecs: interviewDurationRef.current * 60,
                behavior: behaviorRef.current,
              });
              const sysPrompt = buildRTSystemPrompt({
                cvPersonal: cvPersonalRef.current,
                cvTechnical: cvTechnicalRef.current,
                jdText: jdTextRef.current,
                candidateName: candidateNameRef.current,
                personality: behaviorRef.current.mood,
                briefText: brief,
              });
              sendRt({ type: 'session.update', session: { instructions: sysPrompt } });
              // Inject transition directive
              const transId = makeId();
              sendRt({
                type: 'conversation.item.create',
                item: {
                  id: transId,
                  type: 'message',
                  role: 'system',
                  content: [{
                    type: 'input_text',
                    text: `WARMUP COMPLETE. In your next response, warmly acknowledge what they shared, then find a natural creative bridge into the professional portion. Start with Topic 1 from the strategy. Do NOT say "let's begin the interview" or "now for the technical questions".`
                  }],
                },
              });
              phaseRef.current = 'interview';
              setPhase('interview');
              // start interview timer
              interviewElapsedRef.current = 0;
              const totalMs = interviewDurationRef.current * 60 * 1000;
              interviewTimeSecs.current = interviewDurationRef.current * 60;
              setInterviewTimeLeft(interviewTimeSecs.current);
              if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);
              interviewTimerRef.current = setInterval(() => {
                if (isEndingRef.current) { clearInterval(interviewTimerRef.current!); return; }
                if (!isAriaSpeakingRef.current) interviewElapsedRef.current += 1000;
                const remaining = Math.max(0, totalMs - interviewElapsedRef.current);
                setInterviewTimeLeft(Math.floor(remaining / 1000));
                if (interviewElapsedRef.current >= totalMs) {
                  clearInterval(interviewTimerRef.current!);
                  injectBrief('[SYSTEM]: Time limit reached. Transition to wrap-up.');
                  phaseRef.current = 'wrapup';
                  setPhase('wrapup');
                }
              }, 1000);
            };

            if (topicsRef.current && topicsRef.current.length > 0) {
              startInterview(topicsRef.current);
            } else {
              addConductorLog('Waiting for strategy generation...');
              generateStrategy().then((generatedTopics) => {
                startInterview(generatedTopics);
              });
            }
            return; // CRITICAL: return here to prevent any fallthrough
          }
          break;
        }

        // WRAPUP: count turns, hard limit
        if (currentPhase === 'wrapup') {
          wrapupTurnsRef.current += 1;
          setWrapupTurns(wrapupTurnsRef.current);

          if (wrapupTurnsRef.current >= WRAPUP_HARD_LIMIT) {
            injectBrief('[SYSTEM]: Wrapup complete. Give a warm, genuine farewell and close the interview.', false);
            phaseRef.current = 'closing';
            setPhase('closing');
          }
          break;
        }

        // INTERVIEW: debounced conductor
        if (currentPhase === 'interview') {
          const capturedQ = lastAiTextRef.current;
          const capturedA = text;

          if (conductorDebounceRef.current) clearTimeout(conductorDebounceRef.current);
          conductorDebounceRef.current = setTimeout(() => {
            runConductor(capturedQ, capturedA);
          }, CONDUCTOR_DEBOUNCE_MS);
        }

        // CLOSING: detect farewell and end
        if (currentPhase === 'closing') {
          // Just let RT handle it, we'll detect via AI speech end
        }
        break;
      }

      case 'response.done': {
        const resp = ev.response as any;
        if (resp?.usage) {
          const inp = resp.usage.input_token_details || {};
          const out = resp.usage.output_token_details || {};
          usageRef.current.rtTextIn += inp.text_tokens || 0;
          usageRef.current.rtAudioIn += inp.audio_tokens || 0;
          usageRef.current.rtTextOut += out.text_tokens || 0;
          usageRef.current.rtAudioOut += out.audio_tokens || 0;
        }
        syncUsage();
        setCallStatus('Listening...');
        break;
      }

      case 'response.output_item.added': {
        const item = ev.item as any;
        if (item?.role === 'assistant') {
          setCallStatus('Speaking...');
          clearSilenceTimer();
          isAriaSpeakingRef.current = true;
          setIsAriaSpeaking(true);
        }
        break;
      }

      case 'response.output_item.done': {
        // Debounce AI silence detection
        if (aiSilenceDebounceRef.current) clearTimeout(aiSilenceDebounceRef.current);
        aiSilenceDebounceRef.current = setTimeout(() => {
          isAriaSpeakingRef.current = false;
          setIsAriaSpeaking(false);
          if (pendingEndRef.current) { pendingEndRef.current = false; endCall(); }

          // Auto-detect closing farewell
          if (phaseRef.current === 'closing') {
            const lastAi = lastAiTextRef.current.toLowerCase();
            const farewellWords = ['goodbye', 'bye', 'take care', 'best of luck', 'good luck', 'thanks for your time', 'great speaking', 'thank you for'];
            if (farewellWords.some(w => lastAi.includes(w))) {
              setTimeout(() => endCall(), 1800);
            }
          }
        }, 700);
        break;
      }
    }
  }, [clearSilenceTimer, startSilenceTimer, runConductor, generateStrategy, addConductorLog, sendRt, injectBrief, endCall, syncUsage]);

  // ─────────────────────────────────────────────────────────────────────────────
  // CALL LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────────

  const handleCvFile = async (file: File) => {
    setIsParsing(true);
    setSetupErr('');
    setCvFileName(file.name);
    try {
      const text = await extractTextFromFile(file);
      if (!text || text.trim().length < 50) {
        setSetupErr('Could not extract text. Please paste CV text directly.');
        setCvFileName('');
        setIsParsing(false);
        return;
      }
      setCvText(text);
      cvTextRef.current = text;
      try {
        const name = await callConductor(
          `Extract the candidate's full name from this CV. Return ONLY the name, nothing else.\n${text.slice(0, 1500)}`,
          'Name extractor. Return only the name.',
          usageRef
        );
        const clean = name.replace(/["']/g, '').trim();
        if (clean && clean.length > 1 && clean.length < 60) {
          setCandidateName(clean);
          candidateNameRef.current = clean;
        }
      } catch { }
    } catch {
      setSetupErr('Failed to read file.');
      setCvFileName('');
    }
    setIsParsing(false);
  };

  const startCall = useCallback(async () => {
    if (isStartingRef.current || isCallActive) return;
    if (!cvText && !jdText) { setSetupErr('Please provide a CV or Job Description.'); return; }
    isStartingRef.current = true;
    isEndingRef.current = false;

    // Reset all
    setLogs([]); setScores([]); setTopics([]);
    setWarmupTurns(0); setWrapupTurns(0); setDuration(0);
    setConductorLog([]); setIsCallEnded(false); setCurrentBrief('');
    setIsAriaSpeaking(false); setIsConductorRunning(false);
    setBehavior({ style: 'neutral', softSkills: 5, communication: 5, mood: 'neutral' });

    topicsRef.current = [];
    scoresRef.current = [];
    convHistoryRef.current = [];
    warmupTurnsRef.current = 0;
    wrapupTurnsRef.current = 0;
    interviewElapsedRef.current = 0;
    lastAiTextRef.current = '';
    lastUserTextRef.current = '';
    lastSystemItemRef.current = null;
    usageRef.current = { rtAudioIn: 0, rtAudioOut: 0, rtTextIn: 0, rtTextOut: 0, conductorIn: 0, conductorOut: 0 };
    silenceCountRef.current = 0;
    conductorRunningRef.current = false;
    pendingEndRef.current = false;
    isAriaSpeakingRef.current = false;
    processedItemsRef.current.clear();

    clearSilenceTimer();
    setPhase('connecting');
    setCallStatus('Connecting...');

    // Pre-process CV
    if (cvText) {
      const lid = addConductorLog('Pre-processing CV...');
      try {
        const [personal, technical] = await Promise.all([
          callConductor(
            `Extract ONLY personal, non-technical details: name, hobbies, interests, volunteer work, personality traits. EXCLUDE all work experience and technical skills.\nCV:\n${cvText}`,
            'Personal extractor. No tech/work.', usageRef
          ),
          callConductor(
            `Compress this CV into a dense technical profile. Telegram style: no filler. Include all projects, stacks, companies, metrics. Exclude bio/hobbies.\nCV:\n${cvText}`,
            'Technical compressor. Data-only.', usageRef
          ),
        ]);
        cvPersonalRef.current = personal;
        cvTechnicalRef.current = technical;
        syncUsage();
        finishConductorLog(lid, 'done', 'CV processed ✓');
        // Start strategy generation early
        generateStrategy();
      } catch {
        finishConductorLog(lid, 'error', 'CV processing failed');
      }
    } else if (jdText) {
      // If no CV but JD exists, still generate strategy
      generateStrategy();
    }

    try {
      const tokenRes = await fetch('/ai-interview/api/realtime-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: 'shimmer' }),
      });
      const tokenData = await tokenRes.json();
      const KEY = tokenData.client_secret.value;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioElRef.current = audioEl;

      pc.ontrack = e => {
        audioEl.srcObject = e.streams[0];
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(e.streams[0]);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const checkAudio = () => {
          if (isEndingRef.current) return;
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          if (avg > 2) {
            if (!isAriaSpeakingRef.current) {
              isAriaSpeakingRef.current = true;
              setIsAriaSpeaking(true);
            }
            if (aiSilenceDebounceRef.current) { clearTimeout(aiSilenceDebounceRef.current); aiSilenceDebounceRef.current = null; }
          }
          requestAnimationFrame(checkAudio);
        };
        checkAudio();
      };

      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = ms;
      ms.getTracks().forEach(t => pc.addTrack(t, ms));

      const actx = new AudioContext();
      const asrc = actx.createMediaStreamSource(ms);
      const aanalyser = actx.createAnalyser();
      aanalyser.fftSize = 256;
      asrc.connect(aanalyser);
      const fdata = new Uint8Array(aanalyser.frequencyBinCount);
      const tick = () => {
        if (isEndingRef.current) return;
        aanalyser.getByteFrequencyData(fdata);
        setMicLevel(Math.min(100, (fdata.reduce((a, b) => a + b, 0) / fdata.length) * 2.2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      dc.onopen = () => {
        phaseRef.current = 'warmup';
        setPhase('warmup');

        const warmupBrief = buildLiveBrief({
          phase: 'warmup',
          candidateName: candidateNameRef.current,
          topics: [],
          scores: [],
          timeLeftSecs: interviewDurationRef.current * 60,
          behavior: { style: 'neutral', softSkills: 5, communication: 5, mood: 'neutral' },
          warmupTurns: 0,
        });

        const warmupPrompt = buildRTSystemPrompt({
          cvPersonal: cvPersonalRef.current,
          cvTechnical: cvTechnicalRef.current,
          jdText: jdTextRef.current,
          candidateName: candidateNameRef.current,
          personality: 'neutral',
          briefText: warmupBrief,
        });

        sendRt({
          type: 'session.update',
          session: {
            instructions: warmupPrompt,
            input_audio_transcription: { model: 'whisper-1', language: 'en' },
            turn_detection: { type: 'server_vad' },
            modalities: ['text', 'audio'],
            voice: 'shimmer',
            tools: [],
            tool_choice: 'none',
          },
        });

        setTimeout(() => {
          if (isEndingRef.current) return;
          sendRt({ type: 'response.create' });
          setIsCallActive(true);
          isStartingRef.current = false;
          setCallStatus('Listening...');
        }, 300);
      };

      dc.onmessage = e => {
        try { handleRtEvent(JSON.parse(e.data)); } catch { }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch(
        'https://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17',
        { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/sdp' }, body: offer.sdp }
      );
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

    } catch (err: any) {
      setCallStatus('Connection failed');
      setSetupErr(`Failed to connect: ${err.message}`);
      setPhase('setup');
      pcRef.current?.close();
      streamRef.current?.getTracks().forEach(t => t.stop());
      setIsCallActive(false);
      isStartingRef.current = false;
    }
  }, [isCallActive, cvText, jdText, handleRtEvent, clearSilenceTimer, addConductorLog, finishConductorLog, syncUsage, sendRt]);

  const toggleMute = () => {
    const track = streamRef.current?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setIsMuted(!track.enabled); }
  };

  useEffect(() => {
    if (!isCallActive) return;
    const iv = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(iv);
  }, [isCallActive]);

  // ─────────────────────────────────────────────────────────────────────────────
  // COMPUTED
  // ─────────────────────────────────────────────────────────────────────────────

  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b.score, 0) / scores.length : 0;
  const coveredTopics = topics.filter(t => t.status === 'covered' || t.status === 'exhausted');
  const activeTopicName = topics.find(t => t.status === 'active')?.name || '';
  const activeLogs = logs.filter(l => !l.pending || l.text.length > 0);

  const scoreColor = (s: number) => s >= 8 ? '#4ade80' : s >= 6 ? '#fbbf24' : s >= 4 ? '#f97316' : '#f87171';
  const timePct = interviewTimeLeft / (interviewDurationRef.current * 60) * 100;
  const timerColor = timePct > 50 ? '#4ade80' : timePct > 25 ? '#fbbf24' : '#f87171';

  // Mic waveform
  const BARS = 24;
  const waveHeights = Array.from({ length: BARS }, (_, i) => {
    const base = micLevel / 100;
    const wave = isAriaSpeaking
      ? Math.sin((i / BARS) * Math.PI * 3 + Date.now() / 200) * 0.5 + 0.5
      : Math.sin((i / BARS) * Math.PI * 2) * base * 0.8 + base * 0.2;
    return Math.max(3, Math.round(wave * 36 + 3));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // STYLES
  // ─────────────────────────────────────────────────────────────────────────────

  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,300;0,400;0,500;0,600;1,300&family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,700;1,9..144,300;1,9..144,400&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #06080d;
      --s1: #0c1018;
      --s2: #111620;
      --s3: #171e2c;
      --border: #1e2a3d;
      --border2: #28384f;
      --t1: #d4e0f0;
      --t2: #6b82a0;
      --t3: #364d6a;
      --blue: #3d7bff;
      --blue2: #6099ff;
      --green: #4ade80;
      --amber: #fbbf24;
      --red: #f87171;
      --violet: #a78bfa;
      --cyan: #38bdf8;
      --mono: 'IBM Plex Mono', monospace;
      --display: 'Fraunces', serif;
      --sans: 'Instrument Sans', sans-serif;
    }

    html, body {
      background: var(--bg);
      color: var(--t1);
      font-family: var(--sans);
      height: 100vh;
      width: 100vw;
      overflow: hidden;
    }

    ::-webkit-scrollbar { width: 2px; }
    ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

    /* ── SETUP ── */
    .setup {
      min-height: 100vh;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 24px 60px;
      gap: 32px;
    }

    .setup-header {
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .aria-mark {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      background: linear-gradient(135deg, #0f1f42, #1a1040);
      border: 1px solid var(--border2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
    }

    .setup-title {
      font-family: var(--display);
      font-size: clamp(36px, 5vw, 56px);
      font-weight: 300;
      line-height: 1.1;
      color: var(--t1);
    }

    .setup-title em {
      font-style: italic;
      color: var(--blue2);
    }

    .setup-sub {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--t3);
      letter-spacing: .1em;
    }

    .setup-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      width: 100%;
      max-width: 880px;
    }
    @media(max-width: 640px) { .setup-grid { grid-template-columns: 1fr; } }

    .card {
      background: var(--s1);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .card-label {
      font-family: var(--mono);
      font-size: 9px;
      letter-spacing: .18em;
      text-transform: uppercase;
      color: var(--t3);
    }

    .drop-zone {
      border: 1.5px dashed var(--border2);
      border-radius: 10px;
      padding: 28px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      transition: all .2s;
      text-align: center;
    }
    .drop-zone:hover { border-color: var(--blue); background: rgba(61,123,255,.03); }

    .drop-icon {
      width: 38px; height: 38px;
      border-radius: 10px;
      background: rgba(61,123,255,.1);
      display: flex; align-items: center; justify-content: center;
      color: var(--blue); font-size: 16px;
    }

    .cv-loaded {
      display: flex; align-items: center; gap: 10px;
      background: rgba(74,222,128,.06);
      border: 1px solid rgba(74,222,128,.2);
      border-radius: 9px;
      padding: 10px 14px;
    }

    .textarea {
      width: 100%;
      background: #04060a;
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 12px 14px;
      color: var(--t1);
      font-family: var(--sans);
      font-size: 12px;
      resize: vertical;
      min-height: 160px;
      line-height: 1.7;
      outline: none;
      transition: border-color .2s;
    }
    .textarea:focus { border-color: var(--blue); }

    .input {
      width: 100%;
      background: #04060a;
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 10px 14px;
      color: var(--t1);
      font-family: var(--sans);
      font-size: 13px;
      outline: none;
      transition: border-color .2s;
    }
    .input:focus { border-color: var(--blue); }

    .tab-row {
      display: flex; gap: 4px;
      background: rgba(0,0,0,.2);
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 3px;
    }

    .tab-btn {
      flex: 1; border: none; padding: 6px;
      border-radius: 6px;
      font-family: var(--mono);
      font-size: 10px; font-weight: 500;
      cursor: pointer; transition: all .2s;
    }
    .tab-btn.on { background: var(--blue); color: white; }
    .tab-btn:not(.on) { background: transparent; color: var(--t3); }

    .template-grid {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;
      max-height: 220px; overflow-y: auto;
    }

    .tmpl {
      padding: 10px 12px;
      background: rgba(255,255,255,.02);
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
      transition: all .2s;
    }
    .tmpl:hover, .tmpl.on { border-color: var(--blue); background: rgba(61,123,255,.05); }

    .seg-row { display: flex; gap: 5px; }
    .seg { flex: 1; padding: 7px 0; border-radius: 8px; cursor: pointer; transition: all .2s; font-family: var(--mono); font-size: 11px; font-weight: 500; border: 1px solid var(--border); text-align: center; background: var(--s2); color: var(--t2); }
    .seg.on { background: var(--blue); border-color: var(--blue); color: white; }

    .err {
      display: flex; align-items: center; gap: 8px;
      background: rgba(248,113,113,.07);
      border: 1px solid rgba(248,113,113,.2);
      border-radius: 9px; padding: 10px 14px;
      font-size: 12px; color: #fca5a5;
      max-width: 880px; width: 100%;
    }

    .start-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; max-width: 880px;
      padding: 16px; border-radius: 13px;
      background: linear-gradient(135deg, #1740b8, #3d2b9c);
      border: none; cursor: pointer; color: white;
      font-family: var(--sans); font-size: 15px; font-weight: 600;
      letter-spacing: .01em;
      transition: all .25s;
    }
    .start-btn:disabled { opacity: .35; cursor: not-allowed; }
    .start-btn:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(55,64,184,.35); }

    .features-row {
      display: flex; flex-wrap: wrap; gap: 8px;
      justify-content: center;
      max-width: 880px;
    }
    .ftag {
      font-family: var(--mono);
      font-size: 9px;
      padding: 4px 10px;
      border-radius: 5px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.02);
      letter-spacing: .06em;
    }

    /* ── CONNECTING ── */
    .connecting {
      height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .conn-orb {
      width: 72px; height: 72px; border-radius: 50%;
      background: linear-gradient(135deg, #1740b8, #3d2b9c);
      display: flex; align-items: center; justify-content: center;
      font-size: 26px;
      animation: orbPulse 2s ease-in-out infinite;
    }
    @keyframes orbPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(61,123,255,.4); }
      50% { box-shadow: 0 0 0 18px rgba(61,123,255,0); }
    }

    /* ── LIVE ── */
    .live {
      display: grid;
      grid-template-columns: 260px 1fr 280px;
      height: 100vh;
      overflow: hidden;
    }
    @media(max-width: 1080px) {
      .live { grid-template-columns: 240px 1fr; }
      .right-panel { display: none; }
    }

    /* Left Panel */
    .left-panel {
      border-right: 1px solid var(--border);
      background: var(--s1);
      display: flex; flex-direction: column;
      height: 100vh; overflow: hidden;
    }

    .agent-head {
      padding: 20px 16px 14px;
      border-bottom: 1px solid var(--border);
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      flex-shrink: 0;
    }

    .orb {
      position: relative;
      width: 60px; height: 60px; border-radius: 50%;
      background: linear-gradient(135deg, #0d1c3d, #0e0d2d);
      border: 1.5px solid var(--border2);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px;
      transition: all .4s;
    }
    .orb.speaking {
      box-shadow: 0 0 0 3px rgba(61,123,255,.25), 0 0 18px rgba(61,123,255,.15);
      border-color: rgba(61,123,255,.5);
    }

    .status-chip {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 12px; border-radius: 100px;
      font-family: var(--mono); font-size: 10px;
      width: 100%; justify-content: center;
      transition: all .3s;
    }

    .waveform {
      display: flex; align-items: flex-end; gap: 2px;
      height: 28px; width: 100%;
      justify-content: center;
    }
    .wbar {
      width: 2.5px; border-radius: 2px;
      transition: height .08s ease, background .3s;
      min-height: 3px;
    }

    .silence-track {
      width: 100%; padding: 0 2px;
    }
    .silence-bar {
      height: 2px; background: var(--border); border-radius: 1px; overflow: hidden;
    }
    .silence-fill {
      height: 100%; border-radius: 1px;
      transition: width .15s linear, background .3s;
    }

    /* Left scrollable area */
    .left-scroll {
      flex: 1;
      overflow-y: auto;
      display: flex; flex-direction: column; gap: 0;
    }

    .section {
      border-bottom: 1px solid var(--border);
    }
    .section-hd {
      padding: 8px 14px;
      display: flex; align-items: center; justify-content: space-between;
      background: rgba(0,0,0,.15);
    }
    .section-title {
      font-family: var(--mono);
      font-size: 8px; letter-spacing: .14em; text-transform: uppercase;
      color: var(--t3);
    }

    /* Conductor status */
    .conductor-row {
      padding: 7px 14px;
      display: flex; align-items: center; gap: 8px;
      border-bottom: 1px solid rgba(255,255,255,.03);
    }
    .clog-dot {
      width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
    }

    /* Topic tracker */
    .topic-row {
      padding: 8px 14px;
      display: flex; align-items: flex-start; gap: 10px;
      border-bottom: 1px solid rgba(255,255,255,.03);
      transition: background .2s;
    }
    .topic-row.active { background: rgba(61,123,255,.04); }

    .topic-icon {
      width: 18px; height: 18px; border-radius: 5px;
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; flex-shrink: 0; margin-top: 1px;
    }

    /* Controls */
    .controls {
      padding: 12px;
      border-top: 1px solid var(--border);
      display: flex; gap: 8px;
      flex-shrink: 0;
    }
    .btn {
      flex: 1; padding: 10px; border-radius: 9px;
      border: none; cursor: pointer;
      font-family: var(--sans); font-size: 12px; font-weight: 600;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      transition: all .2s;
    }
    .btn-mute { background: rgba(255,255,255,.05); color: var(--t2); border: 1px solid var(--border); }
    .btn-end { background: rgba(248,113,113,.1); color: #fca5a5; border: 1px solid rgba(248,113,113,.2); flex: 2; }

    /* Center */
    .center-panel {
      display: flex; flex-direction: column;
      overflow: hidden;
    }

    .center-top {
      padding: 10px 20px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
    }

    .phase-dots {
      display: flex; align-items: center; gap: 8px;
    }
    .pdot {
      display: flex; flex-direction: column; align-items: center; gap: 3px;
    }
    .pdot-circle {
      width: 7px; height: 7px; border-radius: 50%;
      transition: all .4s;
    }
    .pdot-label {
      font-family: var(--mono); font-size: 7px;
      letter-spacing: .06em;
      transition: color .4s;
    }
    .pdot-sep {
      width: 16px; height: 1px; background: var(--border);
    }

    .center-body {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex; flex-direction: column; gap: 14px;
      position: relative;
    }

    .msg {
      display: flex; gap: 10px; align-items: flex-start;
      animation: fadeSlide .3s ease forwards;
    }
    @keyframes fadeSlide {
      from { opacity: 0; transform: translateY(5px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .msg-av {
      width: 26px; height: 26px; border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      font-family: var(--mono); font-size: 8px; font-weight: 600;
      flex-shrink: 0;
    }
    .msg-av.ai { background: rgba(61,123,255,.12); color: var(--blue2); border: 1px solid rgba(61,123,255,.2); }
    .msg-av.user { background: rgba(74,222,128,.1); color: var(--green); border: 1px solid rgba(74,222,128,.2); }

    .msg-text {
      font-size: 13px; line-height: 1.65;
      flex: 1; color: var(--t1);
    }
    .msg-text.ai { color: var(--t1); }
    .msg-text.user { color: #c8d8f0; }

    /* End overlay */
    .end-overlay {
      position: absolute; inset: 0; z-index: 10;
      background: rgba(6,8,13,.92);
      backdrop-filter: blur(12px);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 24px; padding: 40px; text-align: center;
      animation: fadeSlide .4s ease forwards;
    }

    /* Right panel */
    .right-panel {
      border-left: 1px solid var(--border);
      background: var(--s1);
      overflow-y: auto;
      display: flex; flex-direction: column;
    }

    .score-item {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 6px;
    }
    .score-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 7px; border-radius: 5px;
      font-family: var(--mono); font-size: 9px; font-weight: 700;
      white-space: nowrap;
    }
    .metric-tag {
      font-family: var(--mono); font-size: 8px;
      padding: 1px 5px; border-radius: 3px;
      background: rgba(255,255,255,.04);
      border: 1px solid var(--border);
      color: var(--t3);
    }

    /* ── REPORT ── */
    .report-wrap {
      height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 28px;
    }

    .report {
      width: 100%; max-width: 820px; max-height: 92vh;
      background: var(--s1);
      border: 1px solid var(--border);
      border-radius: 20px;
      overflow: hidden; display: flex; flex-direction: column;
      animation: fadeSlide .4s ease forwards;
    }

    .report-hero {
      padding: 36px; text-align: center;
      background: linear-gradient(135deg, #07101e, #0d0b24);
      border-bottom: 1px solid var(--border);
    }

    .report-score {
      font-family: var(--display);
      font-size: 72px; font-weight: 700; line-height: 1;
    }

    .report-stats {
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 1px; background: var(--border);
    }
    .rstat {
      background: var(--s1); padding: 16px;
    }
    .rstat-val { font-family: var(--display); font-size: 24px; font-weight: 700; }
    .rstat-lbl { font-family: var(--mono); font-size: 8px; letter-spacing: .1em; text-transform: uppercase; color: var(--t3); margin-top: 2px; }

    .report-body {
      overflow-y: auto; flex: 1;
      padding: 16px; display: flex; flex-direction: column; gap: 10px;
    }

    .answer-card {
      border: 1px solid var(--border); border-radius: 11px;
      padding: 14px; display: flex; flex-direction: column; gap: 7px;
    }
    .missed-block {
      padding: 7px 10px; background: var(--s2); border-radius: 7px;
    }

    .restart-btn {
      background: linear-gradient(135deg, #1740b8, #3d2b9c);
      color: white; padding: 12px 36px; border-radius: 10px;
      font-family: var(--sans); font-size: 14px; font-weight: 600;
      border: none; cursor: pointer;
      transition: all .25s;
    }
    .restart-btn:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(55,64,184,.3); }

    .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.2); border-top-color: white; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .pulse { animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity:.5 } 50% { opacity:1 } }

    .fade-in { animation: fadeSlide .3s ease forwards; }
  `;

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: SETUP
  // ─────────────────────────────────────────────────────────────────────────────

  if (phase === 'setup') return (
    <>
      <style>{CSS}</style>
      <div className="setup">
        <div className="setup-header fade-in">
          <div className="aria-mark">🎙</div>
          <h1 className="setup-title">Interview with <em>Aria</em></h1>
          <p className="setup-sub">v6 · Conductor Architecture · Non-robotic · Context-aware</p>
        </div>

        <div className="setup-grid fade-in">
          {/* CV Card */}
          <div className="card">
            <div className="card-label">Candidate CV</div>
            {cvText ? (
              <>
                <div className="cv-loaded">
                  <span style={{ fontSize: 15 }}>✓</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)' }}>{cvFileName || 'CV loaded'}</div>
                    <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{cvText.length.toLocaleString()} chars</div>
                  </div>
                  <button
                    onClick={() => { setCvText(''); setCvFileName(''); }}
                    style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 12 }}
                  >✕</button>
                </div>
              </>
            ) : (
              <>
                <div className="drop-zone" onClick={() => {
                  const i = document.createElement('input');
                  i.type = 'file';
                  i.accept = '.pdf,.txt,.doc,.docx';
                  i.onchange = (e: any) => handleCvFile(e.target.files[0]);
                  i.click();
                }}>
                  <div className="drop-icon">{isParsing ? <div className="spin" /> : '📄'}</div>
                  <div style={{ fontSize: 12, color: 'var(--t2)' }}>{isParsing ? 'Parsing...' : 'Upload PDF or text'}</div>
                  <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>or paste below</div>
                </div>
                <textarea
                  className="textarea"
                  placeholder="Paste CV text here..."
                  style={{ minHeight: 120 }}
                  value={cvText}
                  onChange={e => setCvText(e.target.value)}
                />
              </>
            )}
          </div>

          {/* JD Card */}
          <div className="card">
            <div className="card-label">Job Description</div>
            <div className="tab-row">
              <button className={`tab-btn ${jdTab === 'manual' ? 'on' : ''}`} onClick={() => setJdTab('manual')}>Manual</button>
              <button className={`tab-btn ${jdTab === 'templates' ? 'on' : ''}`} onClick={() => setJdTab('templates')}>Templates</button>
            </div>

            {jdTab === 'manual' ? (
              <textarea
                className="textarea fade-in"
                placeholder="Paste Job Description here..."
                style={{ minHeight: 160 }}
                value={jdText}
                onChange={e => setJdText(e.target.value)}
              />
            ) : (
              <div className="template-grid fade-in">
                {Object.entries(JD_TEMPLATES).map(([key, val]) => {
                  const icons: any = { frontend: '⚛️', backend: '⚙️', fullstack: '⚡', ai: '🧠', devops: '☁️', mobile: '📱' };
                  const names: any = { frontend: 'Frontend', backend: 'Backend', fullstack: 'Fullstack', ai: 'AI/ML', devops: 'DevOps', mobile: 'Mobile' };
                  return (
                    <div key={key} className={`tmpl ${selectedTemplate === key ? 'on' : ''}`} onClick={() => { setJdText(val); setSelectedTemplate(key); setJdTab('manual'); }}>
                      <div style={{ fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}><span>{icons[key]}</span>{names[key]}</div>
                      <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>{val.split('\n')[0]?.replace('Role: ', '')}</div>
                    </div>
                  );
                })}
              </div>
            )}

            <input
              className="input"
              placeholder="Candidate name (auto-detected from CV)"
              value={candidateName}
              onChange={e => setCandidateName(e.target.value)}
            />

            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ flex: 1 }}>
                <div className="card-label" style={{ marginBottom: 8 }}>Questions</div>
                <div className="seg-row">
                  {[3, 5, 8, 10].map(n => (
                    <button key={n} className={`seg ${numQuestions === n ? 'on' : ''}`} onClick={() => setNumQuestions(n)}>{n}</button>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div className="card-label" style={{ marginBottom: 8 }}>Duration</div>
                <div className="seg-row">
                  {[5, 10, 15, 20].map(m => (
                    <button key={m} className={`seg ${interviewDuration === m ? 'on' : ''}`} onClick={() => setInterviewDuration(m)}>{m}m</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="features-row fade-in">
          {[
            ['var(--blue2)', 'RT = Voice Only'],
            ['var(--green)', 'Conductor = 3 Background Agents'],
            ['var(--amber)', '50% CV · 50% JD'],
            ['var(--violet)', 'No topic hijacking'],
            ['var(--cyan)', `Warmup ${WARMUP_HARD_LIMIT} turns hard limit`],
            ['var(--red)', 'Interruption-aware'],
          ].map(([color, label]) => (
            <div key={label as string} className="ftag" style={{ color: color as string }}>{label as string}</div>
          ))}
        </div>

        {setupErr && <div className="err fade-in">⚠ {setupErr}</div>}

        <button
          className="start-btn fade-in"
          disabled={isParsing || (!cvText && !jdText)}
          onClick={() => { setSetupErr(''); startCall(); }}
        >
          {isParsing ? <><div className="spin" /> Processing CV...</> : '⟶  Start Interview with Aria'}
        </button>
      </div>
    </>
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: CONNECTING
  // ─────────────────────────────────────────────────────────────────────────────

  if (phase === 'connecting') return (
    <>
      <style>{CSS}</style>
      <div className="connecting">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, textAlign: 'center' }} className="fade-in">
          <div className="conn-orb">🎙</div>
          <div>
            <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 300, marginBottom: 6 }}>Initializing Aria v6</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>
              {conductorLog[0]?.msg || 'Pre-processing · Building context · Connecting...'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {conductorLog.slice(0, 3).map(l => (
              <div key={l.id} style={{ fontFamily: 'var(--mono)', fontSize: 9, color: l.status === 'done' ? 'var(--green)' : l.status === 'error' ? 'var(--red)' : 'var(--amber)', padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 5 }}>
                {l.status === 'done' ? '✓' : l.status === 'error' ? '✗' : '·'} {l.msg.slice(0, 30)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: REPORT
  // ─────────────────────────────────────────────────────────────────────────────

  if (phase === 'report') return (
    <>
      <style>{CSS}</style>
      <div className="report-wrap">
        <div className="report">
          <div className="report-hero">
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.12em', marginBottom: 10 }}>INTERVIEW COMPLETE · ARIA v6</div>
            {avgScore > 0 ? (
              <div className="report-score" style={{ color: scoreColor(avgScore) }}>{avgScore.toFixed(1)}</div>
            ) : (
              <div className="report-score" style={{ color: 'var(--t3)' }}>—</div>
            )}
            <div style={{ fontSize: 13, color: 'var(--t2)', marginTop: 6 }}>{scores.length} topics evaluated · {fmtTime(duration)} total</div>
          </div>

          <div className="report-stats">
            <div className="rstat">
              <div className="rstat-val">{scores.length}</div>
              <div className="rstat-lbl">Scored</div>
            </div>
            <div className="rstat">
              <div className="rstat-val">{behavior.softSkills}/10</div>
              <div className="rstat-lbl">Soft Skills</div>
            </div>
            <div className="rstat">
              <div className="rstat-val" style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{behavior.style.toUpperCase()}</div>
              <div className="rstat-lbl">Comm Style</div>
            </div>
            <div className="rstat">
              <div className="rstat-val" style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>${computeCost(usage).toFixed(4)}</div>
              <div className="rstat-lbl">Cost</div>
            </div>
          </div>

          {/* Behavioral summary */}
          <div style={{ padding: '14px 16px', background: 'rgba(61,123,255,.04)', borderBottom: '1px solid var(--border)', margin: '0' }}>
            <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--blue2)', fontWeight: 700, marginBottom: 6, letterSpacing: '.1em' }}>BEHAVIORAL AUDIT</div>
            <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.65 }}>
              {candidateName || 'The candidate'} demonstrated a <strong style={{ color: 'var(--t1)' }}>{behavior.style}</strong> communication style.
              Soft skills: <strong style={{ color: 'var(--t1)' }}>{behavior.softSkills}/10</strong>.
              Communication clarity: <strong style={{ color: 'var(--t1)' }}>{behavior.communication}/10</strong>.
              Aria adapted to <strong style={{ color: 'var(--t1)' }}>{behavior.mood}</strong> mode.
            </div>
          </div>

          <div className="report-body">
            {scores.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--t3)', padding: 30 }}>No scored answers recorded.</div>
            ) : scores.map((s, i) => (
              <div className="answer-card" key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{s.topic}</div>
                  <div className="score-badge" style={{ background: scoreColor(s.score) + '18', color: scoreColor(s.score), border: `1px solid ${scoreColor(s.score)}30` }}>
                    {s.score}/10
                  </div>
                </div>
                {s.answerSummary && (
                  <div style={{ fontSize: 11, color: 'var(--t2)', borderLeft: '2px solid var(--border2)', paddingLeft: 10, lineHeight: 1.6 }}>
                    {s.answerSummary}
                  </div>
                )}
                {s.feedback && (
                  <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.6 }}>{s.feedback}</div>
                )}
                {s.logicEvaluation && (
                  <div style={{ fontSize: 10, color: 'var(--t3)' }}><span style={{ color: 'var(--t2)', fontWeight: 600 }}>Logic: </span>{s.logicEvaluation}</div>
                )}
                {s.missedOpportunities.length > 0 && (
                  <div className="missed-block">
                    <div style={{ fontSize: 8, color: 'var(--amber)', fontWeight: 700, marginBottom: 5, letterSpacing: '.1em' }}>MISSED OPPORTUNITIES</div>
                    {s.missedOpportunities.map((o, idx) => (
                      <div key={idx} style={{ fontSize: 10, color: 'var(--t3)', display: 'flex', gap: 5, marginBottom: 2 }}>
                        <span style={{ color: 'var(--amber)' }}>·</span>{o}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                  {s.confidence && <span className="metric-tag">Conf: {s.confidence}</span>}
                  {s.clarity && <span className="metric-tag">Clarity: {s.clarity}</span>}
                  {s.depth && <span className="metric-tag">Depth: {s.depth}</span>}
                  {s.technicalAccuracy > 0 && <span className="metric-tag" style={{ color: 'var(--amber)' }}>Accuracy: {s.technicalAccuracy}/10</span>}
                  {s.tags.slice(0, 3).map(t => <span key={t} className="metric-tag" style={{ color: 'var(--cyan)' }}>{t}</span>)}
                </div>
              </div>
            ))}
          </div>

          <div style={{ padding: 20, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            <button className="restart-btn" onClick={() => window.location.reload()}>Start New Interview</button>
          </div>
        </div>
      </div>
    </>
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: LIVE SESSION
  // ─────────────────────────────────────────────────────────────────────────────

  const phases: { p: AppPhase; label: string }[] = [
    { p: 'warmup', label: 'Warmup' },
    { p: 'interview', label: 'Interview' },
    { p: 'wrapup', label: 'Wrap-up' },
    { p: 'closing', label: 'Closing' },
  ];
  const phaseOrder = phases.map(x => x.p);
  const currentPhaseIdx = phaseOrder.indexOf(phase);

  return (
    <>
      <style>{CSS}</style>
      <div className="live">

        {/* ── LEFT PANEL ── */}
        <div className="left-panel">
          <div className="agent-head">
            <div className={`orb ${isAriaSpeaking ? 'speaking' : ''}`}>🎙</div>

            <div>
              <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 300, textAlign: 'center' }}>Aria</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--t3)', textAlign: 'center', letterSpacing: '.1em' }}>v6 · CONDUCTOR</div>
            </div>

            <div className="status-chip" style={{
              background: isAriaSpeaking ? 'rgba(61,123,255,.1)' : isConductorRunning ? 'rgba(167,139,250,.08)' : 'rgba(255,255,255,.04)',
              color: isAriaSpeaking ? 'var(--blue2)' : isConductorRunning ? 'var(--violet)' : 'var(--t2)',
            }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: isAriaSpeaking ? 'var(--blue)' : isConductorRunning ? 'var(--violet)' : 'var(--t3)', flexShrink: 0, animation: (isAriaSpeaking || isConductorRunning) ? 'pulse 1s infinite' : 'none' }} />
              {isAriaSpeaking ? 'Speaking...' : isConductorRunning ? 'Conductor running...' : callStatus}
            </div>

            {silenceLeft !== null && !isAriaSpeaking && (
              <div className="silence-track">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--t3)', fontFamily: 'var(--mono)', marginBottom: 3 }}>
                  <span>Silence</span><span>{(silenceLeft / 1000).toFixed(1)}s</span>
                </div>
                <div className="silence-bar">
                  <div className="silence-fill" style={{
                    width: `${(silenceLeft / SILENCE_MS) * 100}%`,
                    background: silenceLeft < 5000 ? 'var(--red)' : silenceLeft < 10000 ? 'var(--amber)' : 'var(--blue)',
                  }} />
                </div>
              </div>
            )}

            <div className="waveform">
              {waveHeights.map((h, i) => (
                <div key={i} className="wbar" style={{
                  height: h,
                  background: isAriaSpeaking ? `rgba(61,123,255,${0.4 + (h / 40) * 0.6})` : `rgba(107,130,160,${0.2 + (h / 40) * 0.5})`,
                }} />
              ))}
            </div>
          </div>

          <div className="left-scroll">
            {/* Architecture Section */}
            <div className="section">
              <div className="section-hd">
                <span className="section-title">Architecture</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: isConductorRunning ? 'var(--violet)' : 'var(--t3)' }}>
                  {isConductorRunning ? '● ACTIVE' : '○ IDLE'}
                </span>
              </div>
              <div style={{ padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,.04)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px rgba(74,222,128,.5)' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600 }}>RT Actor</div>
                  <div style={{ fontSize: 9, color: 'var(--t3)' }}>Voice · reads live brief</div>
                </div>
                <div style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--green)', fontWeight: 700, background: 'rgba(74,222,128,.08)', padding: '2px 6px', borderRadius: 4 }}>VOICE</div>
              </div>
              <div style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: isConductorRunning ? 'var(--violet)' : 'var(--t3)', transition: 'all .3s', boxShadow: isConductorRunning ? '0 0 6px rgba(167,139,250,.5)' : 'none' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600 }}>Conductor</div>
                  <div style={{ fontSize: 9, color: 'var(--t3)' }}>Coverage · Score · Brief</div>
                </div>
                <div style={{ fontSize: 8, fontFamily: 'var(--mono)', color: isConductorRunning ? 'var(--violet)' : 'var(--t3)', fontWeight: 700, background: isConductorRunning ? 'rgba(167,139,250,.08)' : 'transparent', padding: '2px 6px', borderRadius: 4 }}>
                  {isConductorRunning ? 'RUNNING' : 'IDLE'}
                </div>
              </div>
            </div>

            {/* Conductor Logs */}
            {conductorLog.length > 0 && (
              <div className="section">
                <div className="section-hd">
                  <span className="section-title">Conductor Log</span>
                </div>
                {conductorLog.map(l => (
                  <div key={l.id} className="conductor-row">
                    <div className="clog-dot" style={{ background: l.status === 'done' ? 'var(--green)' : l.status === 'error' ? 'var(--red)' : 'var(--amber)' }} />
                    <div style={{ fontSize: 9, color: l.status === 'error' ? 'var(--red)' : 'var(--t2)', fontFamily: 'var(--mono)', flex: 1, lineHeight: 1.4 }}>{l.msg}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Behavior */}
            <div className="section">
              <div className="section-hd">
                <span className="section-title">Behavioral Intel</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: behavior.mood === 'nice' ? 'var(--green)' : behavior.mood === 'strict' ? 'var(--red)' : 'var(--blue2)', fontWeight: 700 }}>
                  ARIA: {behavior.mood.toUpperCase()}
                </span>
              </div>
              <div style={{ padding: '10px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <div style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 8px' }}>
                  <div style={{ fontSize: 7, color: 'var(--t3)', fontFamily: 'var(--mono)', marginBottom: 3 }}>STYLE</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--cyan)' }}>{behavior.style.toUpperCase()}</div>
                </div>
                <div style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 8px' }}>
                  <div style={{ fontSize: 7, color: 'var(--t3)', fontFamily: 'var(--mono)', marginBottom: 3 }}>SOFT SKILLS</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--amber)' }}>{behavior.softSkills}/10</div>
                </div>
              </div>
            </div>

            {/* Topics */}
            {topics.length > 0 && (
              <div className="section">
                <div className="section-hd">
                  <span className="section-title">Topic Roadmap</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--amber)' }}>
                    {coveredTopics.length}/{topics.length}
                  </span>
                </div>
                {topics.map((t, i) => {
                  const isActive = t.status === 'active';
                  const isDone = t.status === 'covered' || t.status === 'exhausted';
                  const isFailed = t.status === 'failed';

                  return (
                    <div key={i} className={`topic-row ${isActive ? 'active' : ''}`}>
                      <div className="topic-icon" style={{
                        background: isDone ? 'rgba(74,222,128,.1)' : isActive ? 'rgba(61,123,255,.12)' : isFailed ? 'rgba(248,113,113,.1)' : 'rgba(255,255,255,.04)',
                        color: isDone ? 'var(--green)' : isActive ? 'var(--blue2)' : isFailed ? 'var(--red)' : 'var(--t3)',
                      }}>
                        {isDone ? '✓' : isActive ? '→' : isFailed ? '✗' : `${i + 1}`}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10, fontWeight: isActive ? 600 : 400, color: isDone ? 'var(--t3)' : isActive ? 'var(--t1)' : 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {t.name}
                        </div>
                        <div style={{ display: 'flex', gap: 5, marginTop: 2, alignItems: 'center' }}>
                          <span style={{ fontSize: 7, fontFamily: 'var(--mono)', color: t.source === 'profile' ? 'var(--amber)' : t.source === 'cv' ? 'var(--cyan)' : 'var(--violet)', fontWeight: 700 }}>{t.source.toUpperCase()}</span>                          {isActive && <span style={{ fontSize: 7, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{t.turnCount}/{MAX_TOPIC_TURNS} turns</span>}
                          {t.score !== undefined && <span style={{ fontSize: 7, fontFamily: 'var(--mono)', color: scoreColor(t.score), fontWeight: 700 }}>{t.score}/10</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Token usage */}
            <div className="section">
              <div className="section-hd">
                <span className="section-title">Cost</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)', fontWeight: 700 }}>${computeCost(usage).toFixed(4)}</span>
              </div>
              <div style={{ padding: '8px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                {[
                  ['RT Audio In', usage.rtAudioIn, 'var(--cyan)'],
                  ['RT Audio Out', usage.rtAudioOut, 'var(--violet)'],
                  ['RT Text', usage.rtTextIn + usage.rtTextOut, 'var(--blue2)'],
                  ['Conductor', usage.conductorIn + usage.conductorOut, 'var(--amber)'],
                ].map(([label, val, color]) => (
                  <div key={label as string} style={{ background: 'rgba(255,255,255,.02)', border: '1px solid var(--border)', borderRadius: 5, padding: '5px 7px' }}>
                    <div style={{ fontSize: 7, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{label as string}</div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: color as string }}>{(val as number).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="controls">
            <button className="btn btn-mute" onClick={toggleMute}>
              {isMuted ? '🔇' : '🎤'} {isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button className="btn btn-end" onClick={endCall}>End</button>
          </div>
        </div>

        {/* ── CENTER PANEL ── */}
        <div className="center-panel">
          <div className="center-top">
            {/* Phase dots */}
            <div className="phase-dots">
              {phases.map(({ p, label }, i) => {
                const idx = phaseOrder.indexOf(p);
                const done = currentPhaseIdx > idx;
                const active = currentPhaseIdx === idx;
                return (
                  <Fragment key={p}>
                    {i > 0 && <div className="pdot-sep" />}
                    <div className="pdot">
                      <div className="pdot-circle" style={{
                        background: active ? 'var(--blue)' : done ? 'var(--green)' : 'var(--border2)',
                        boxShadow: active ? '0 0 8px rgba(61,123,255,.5)' : done ? '0 0 5px rgba(74,222,128,.3)' : 'none',
                      }} />
                      <div className="pdot-label" style={{ color: active ? 'var(--blue2)' : done ? 'var(--green)' : 'var(--t3)' }}>{label}</div>
                    </div>
                  </Fragment>
                );
              })}
            </div>

            {/* Right side info */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {phase === 'warmup' && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber)', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.2)', padding: '3px 10px', borderRadius: 6 }}>
                  Warmup {warmupTurns}/{WARMUP_HARD_LIMIT}
                </div>
              )}
              {phase === 'interview' && (
                <>
                  {activeTopicName && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      → {activeTopicName}
                    </div>
                  )}
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: timerColor }}>
                    {fmtTime(interviewTimeLeft)}
                  </div>
                </>
              )}
              {phase === 'wrapup' && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--cyan)', background: 'rgba(56,189,248,.08)', border: '1px solid rgba(56,189,248,.2)', padding: '3px 10px', borderRadius: 6 }}>
                  Wrapup {wrapupTurns}/{WRAPUP_HARD_LIMIT}
                </div>
              )}
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{fmtTime(duration)}</div>
            </div>
          </div>

          <div className="center-body">
            {/* Call ended overlay */}
            {isCallEnded && (
              <div className="end-overlay">
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(74,222,128,.08)', border: '1px solid rgba(74,222,128,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>✓</div>
                <div>
                  <div style={{ fontFamily: 'var(--display)', fontSize: 26, fontWeight: 300, marginBottom: 8 }}>Interview Complete</div>
                  <div style={{ color: 'var(--t2)', fontSize: 13, lineHeight: 1.6 }}>
                    {scores.length} topics evaluated · avg score {avgScore > 0 ? avgScore.toFixed(1) : '—'}
                  </div>
                </div>
                <button className="restart-btn" onClick={() => { phaseRef.current = 'report'; setPhase('report'); }}>
                  View Report →
                </button>
              </div>
            )}

            {activeLogs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 30, color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                {isAriaSpeaking ? '● Aria is speaking...' : 'Waiting to begin...'}
              </div>
            ) : activeLogs.slice(-20).map((log, i) => (
              <div key={log.id || i} className="msg">
                <div className={`msg-av ${log.role}`}>{log.role === 'ai' ? 'AI' : 'You'}</div>
                <div className={`msg-text ${log.role}`}>
                  {log.text || <span style={{ color: 'var(--t3)' }}>…</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div className="right-panel">
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Live Scores</div>
            {scores.length > 0 && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: scoreColor(avgScore), fontWeight: 700 }}>avg {avgScore.toFixed(1)}</div>
            )}
          </div>

          {scores.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
              Scores appear after each topic...
            </div>
          ) : [...scores].reverse().map((s, i) => (
            <div key={i} className="score-item fade-in">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, flex: 1, color: 'var(--t1)' }}>{s.topic}</div>
                <div className="score-badge" style={{ background: scoreColor(s.score) + '18', color: scoreColor(s.score), border: `1px solid ${scoreColor(s.score)}30` }}>
                  {s.score}/10
                </div>
              </div>
              {s.answerSummary && (
                <div style={{ fontSize: 10, color: 'var(--t3)', lineHeight: 1.5 }}>{s.answerSummary.slice(0, 80)}...</div>
              )}
              {s.logicEvaluation && (
                <div style={{ fontSize: 9, color: 'var(--t3)', fontStyle: 'italic', lineHeight: 1.4 }}>{s.logicEvaluation}</div>
              )}
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                {s.confidence && <span className="metric-tag">Conf: {s.confidence}</span>}
                {s.clarity && <span className="metric-tag">Clarity: {s.clarity}</span>}
                {s.depth && <span className="metric-tag">{s.depth}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}