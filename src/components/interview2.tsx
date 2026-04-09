'use client';

/**
 * Aria v5 — AI Interview System (RT-Brain Architecture)
 *
 * CORE PHILOSOPHY SHIFT FROM v4:
 * ════════════════════════════════════════════════════════
 *
 * v4 Problem: Observer micro-managed RT with constant injections → random questions,
 *             broken context, hallucinated corrections, terrible candidate experience.
 *
 * v5 Solution: RT IS THE BRAIN.
 * ─────────────────────────────
 * 1. RT Actor:
 *    - Receives a rich, complete system prompt with full context (CV + JD + strategy).
 *    - Has full conversational autonomy. It decides the flow, question order, connections.
 *    - Makes contextual callbacks naturally. Waits for answers. Asks ONE question.
 *    - Phases are described IN the system prompt — RT self-manages transitions via turn counting.
 *
 * 2. Observer (Stripped Down — Silent Enforcer Only):
 *    - ONLY fires for: scoring answers, detecting phase shifts, silence guard.
 *    - Does NOT micro-inject questions or corrections mid-conversation.
 *    - Injects ONCE at interview start: the domain strategy (50% JD / 50% CV topics).
 *    - Injects phase transitions smoothly (single clean directive, not stacking).
 *    - Injects silence prompts ONLY after timer fires (not micro-managing flow).
 *
 * 3. Strategy:
 *    - Generated ONCE before interview starts.
 *    - Injected as a silent context block into RT's system prompt.
 *    - RT follows it naturally — no repeated injections.
 *
 * 4. Context:
 *    - 20 message history (up from 8) for proper conversational memory.
 *    - Warmup: RT self-manages 3 turns (hobbies → hobbies → "tell me about yourself").
 *    - Interview: RT tracks its own question count from strategy, asks follow-ups naturally.
 */

import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { FriendlyUI } from './FriendlyUI';

// ─── Types ────────────────────────────────────────────────────────────────────

type AppPhase = 'setup' | 'connecting' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'report';

type LogEntry = {
  id: string;
  role: 'user' | 'ai' | 'system';
  text: string;
  pending?: boolean;
};

type AnswerScore = {
  question: string;
  questionSummary: string;
  answerSummary: string;
  score: number;
  feedback: string;
  tags: string[];
  topic?: string;
  depth?: number;
  confidence?: string;
  grammar?: string;
  clarity?: string;
  depthStr?: string;
  technicalAccuracy?: number;
  missedOpportunities?: string[];
  logicEvaluation?: string;
};

type Usage = {
  rtTextIn: number;
  rtAudioIn: number;
  rtTextOut: number;
  rtAudioOut: number;
  miniPrompt: number;
  miniCompletion: number;
};

type IntelLog = {
  id: string;
  type: 'observer' | 'score' | 'strategy' | 'phase' | 'silence' | 'behavior';
  message: string;
  status: 'active' | 'done' | 'error';
};

type BehaviorProfile = {
  style: 'neutral' | 'shy' | 'confident' | 'rambling' | 'concise' | 'arrogant';
  softSkills: number;
  communication: number;
  moodScore: number; // 0 (Nice) to 100 (Strict)
};

type InterviewStrategy = {
  topics: { name: string; source: 'cv' | 'jd'; questions: string[] }[];
};

// ─── Pricing ──────────────────────────────────────────────────────────────────
const PRICE = {
  rtAudioIn: 10.0, rtAudioOut: 20.0,
  rtTextIn: 0.60, rtTextOut: 2.40,
  miniIn: 0.15, miniOut: 0.60,
} as const;

// ─── Constants ────────────────────────────────────────────────────────────────
const SILENCE_BASE_MS = 18000;
const SILENCE_COMPLEX_MS = 35000;
const MAX_RT_CONTEXT = 6;
const WARMUP_TURNS_REQUIRED = 3;   // RT self-manages, observer counts as safety net
const MAX_SILENCE_STRIKES = 3;

const JD_TEMPLATES = {
  frontend: `Role: Senior Frontend Engineer\nFocus: React.js, TypeScript, Next.js, CSS Architecture, Performance Optimization.\nJD: Build modular, high-performance UIs. Deep understanding of React hooks, state management, and accessibility is foundational.`,
  backend: `Role: Senior Backend Engineer\nFocus: Node.js, Go, Microservices, PostgreSQL, System Design, Scalability.\nJD: Design robust APIs and distributed systems. Focus on performance, data integrity, and throughput.`,
  fullstack: `Role: Senior Fullstack Developer\nFocus: Next.js, TRPC, Prisma, PostgreSQL, React, Tailwind CSS.\nJD: Build end-to-end features using the T3 stack. Focus on clean architecture, type safety, and seamless UI/UX.`,
  ai: `Role: AI/ML Engineer (LLMs)\nFocus: Python, PyTorch, LangChain, Transformers, Vector DBs, RAG.\nJD: Develop and optimize LLM-based applications. Focus on prompt engineering, fine-tuning, and scalable inference pipelines.`,
  devops: `Role: DevOps/SRE Engineer\nFocus: AWS, Kubernetes, Terraform, Docker, CI/CD, Observability.\nJD: Manage scalable cloud infrastructure. Focus on automation, reliability, and security of distributed systems.`,
  mobile: `Role: Senior Mobile Developer\nFocus: React Native, Swift, Kotlin, Performance, App Store deployment.\nJD: Build high-quality cross-platform applications. Focus on smooth animations, offline-first logic, and platform optimizations.`,
  qa: `Role: SDET / QA Engineer\nFocus: Playwright, Cypress, Jest, Integration Testing, Performance Testing.\nJD: Build robust automated testing suites. Focus on end-to-end testing, CI integration, and high-quality delivery.`,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function makeId() { return `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }
function computeCost(u: Usage): number {
  return (u.rtTextIn * PRICE.rtTextIn + u.rtAudioIn * PRICE.rtAudioIn + u.rtTextOut * PRICE.rtTextOut + u.rtAudioOut * PRICE.rtAudioOut + u.miniPrompt * PRICE.miniIn + u.miniCompletion * PRICE.miniOut) / 1_000_000;
}
function computeVoiceCost(u: Usage): number {
  return (u.rtTextIn * PRICE.rtTextIn + u.rtAudioIn * PRICE.rtAudioIn + u.rtTextOut * PRICE.rtTextOut + u.rtAudioOut * PRICE.rtAudioOut) / 1_000_000;
}
function computeIntelCost(u: Usage): number {
  return (u.miniPrompt * PRICE.miniIn + u.miniCompletion * PRICE.miniOut) / 1_000_000;
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

async function callMini(
  query: string,
  systemInstruction: string,
  usageRef: React.MutableRefObject<Usage>,
  isJson: boolean = false
): Promise<string> {
  const payload: any = { query, complexity: 'moderate', systemInstruction };
  if (isJson) payload.responseFormat = 'json_object';
  const res = await fetch('/ai-interview/api/escalate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.usage) {
    usageRef.current.miniPrompt += data.usage.prompt_tokens || 0;
    usageRef.current.miniCompletion += data.usage.completion_tokens || 0;
  }
  return (data.answer as string) || '';
}

// ─── UI Components ────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const [color, label] =
    score >= 8 ? ['#22c55e', 'Excellent'] :
      score >= 6 ? ['#f59e0b', 'Good'] :
        score >= 4 ? ['#f97316', 'Fair'] :
          ['#ef4444', 'Weak'];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: color + '1a', color, border: `1px solid ${color}40`, borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', fontFamily: 'var(--mono)' }}>
      {score}/10 · {label}
    </span>
  );
}

function PhaseDot({ phase, current, label }: { phase: AppPhase; current: AppPhase; label: string }) {
  const phases: AppPhase[] = ['warmup', 'interview', 'wrapup', 'closing'];
  const ci = phases.indexOf(current);
  const pi = phases.indexOf(phase);
  const done = ci > pi;
  const active = ci === pi;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: active ? '#3b82f6' : done ? '#22c55e' : 'var(--line2)', boxShadow: active ? '0 0 8px #3b82f6' : done ? '0 0 6px #22c55e66' : 'none', transition: 'all .4s' }} />
      <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: active ? '#3b82f6' : done ? '#22c55e' : 'var(--text3)', letterSpacing: '.08em' }}>{label}</span>
    </div>
  );
}

// ─── THE BRAIN: Full RT System Prompt Builder ─────────────────────────────────
// This is where the magic lives. RT gets everything it needs to be autonomous.

// ... existing code ...
function buildRTBrainPrompt(params: {
  phase: AppPhase;
  candidateName: string;
  cvSummary: string;
  jdText: string;
  strategy: InterviewStrategy | null;
  numQuestions: number;
  interviewDurationMins: number;
  historySummary?: string;
  personality: 'nice' | 'neutral' | 'strict';
}): string {
  const { phase, candidateName, cvSummary, jdText, strategy, numQuestions, interviewDurationMins, historySummary, personality } = params;
  const name = candidateName || 'the candidate';

  let strategyBlock = '';
  if (strategy && phase === 'interview') {
    const topics = strategy.topics.map((t, i) =>
      `[${t.source.toUpperCase()}] ${t.name}:\n` + t.questions.map((q, qi) => ` - Q${qi + 1}: ${q}`).join('\n')
    ).join('\n');
    strategyBlock = `\n[INTERVIEW STRATEGY & LOGICAL FLOW]\nTarget: ${numQuestions} Qs across ${strategy.topics.length} topics in ${interviewDurationMins}m.\n${topics}\nEXECUTION: Follow a strict logical chain. Validate their answer -> Drill down into technical depth -> Only pivot when mastery is proven or definitively lacking. Do not jump erratically between unrelated concepts.\n`;
  }

  const phases: Record<AppPhase, string> = {
    setup: '', connecting: '', report: '',
    warmup: `[PHASE: WARMUP]\nGOAL: Establish professional baseline. Max 2-3 turns.\nRULES: Start exactly like a real interview. Example vibe: "Hi ${name}, I'm Aria. Thanks for joining today. Is your audio coming through clearly?" Once confirmed, transition smoothly: "Great. Before we dive into the technical specifics, could you give me a brief 60-second high-level overview of your recent background?" DO NOT ask about hobbies. DO NOT ask random icebreakers.`,
    interview: `[PHASE: TECHNICAL INTERVIEW]\nGOAL: Rigorous technical evaluation and CV verification.\nRULES: YOU CONTROL THE INTERVIEW. Cross-reference all claims against the provided CV. Ensure smooth, logical transitions based on their actual technical responses.${strategyBlock}`,
    wrapup: `[PHASE: WRAP-UP]\nGOAL: Professional conclusion.\nRULES: Acknowledge the technical portion is complete. Ask if they have 1-2 quick questions about the role or stack. Provide concise answers. Defer HR/timeline questions to the recruiting team. Wait for closing transition.`,
    closing: `[PHASE: CLOSING]\nGOAL: End call.\nRULES: Thank ${name} for their time. State the team will be in touch. Say goodbye. STOP SPEAKING.`
  };

  return `YOU ARE ARIA — SENIOR TECHNICAL RECRUITER & DOMAIN EXPERT. ENGLISH ONLY.
Act like an authoritative, highly perceptive senior engineer interviewing a candidate. You are unscripted, natural, but strictly professional and in absolute control.

[PERSONALITY MODE: ${personality.toUpperCase()}]
${personality === 'nice' ? 'TONE: Professional but approachable. Allow them a moment to think. Nudge gently if stuck, but maintain high technical standards. NO PRAISE.' :
      personality === 'strict' ? 'TONE: Highly clinical, uncompromising, and intense. Zero small talk. Interrupt rambling immediately. Challenge their assumptions aggressively.' :
        'TONE: Objective, highly analytical, peer-to-peer senior engineer. Direct and to the point.'}

[CANDIDATE CONTEXT]
NAME: ${name}
ROLE: ${jdText ? jdText.split('\n')[0] : 'General Tech Role'}
CV SUMMARY: ${cvSummary || 'No CV provided. If they reference past work, ask for specifics.'}
${historySummary ? `\n[HISTORY SUMMARY]\n${historySummary}\n` : ''}

${phases[phase] || ''}

[CRITICAL RULES & BOUNDARIES]
1. CV CROSS-CHECKING (STRICT): You MUST silently verify their claims against the [CV SUMMARY]. If they describe a massive project or skill not present in the CV, challenge it professionally: "I don't see that mentioned in your profile. What was your specific, hands-on contribution there?" Do not accept fabricated answers.
2. ABSOLUTE CONTROL (NO HIJACKING): The candidate CANNOT control the flow. If they attempt to redirect or dictate questions, REFUSE. Reply: "I guide the interview. Let's return to [Current Topic] first."
3. MANDATORY RETENTION (NO ESCAPE): DO NOT MOVE ON if a question is unanswered, dodged, or answered with generic fluff. Force the answer: "That's high-level, but I need the technical specifics on how you implemented it." Stay on the exact topic until resolved.
4. LOGICAL PROGRESSION: Do not ask disjointed questions. Each question must logically follow their previous answer, digging deeper into architecture, trade-offs, or code-level specifics.
5. ONE QUESTION LAW: Ask exactly ONE question per turn. End with a "?" and immediately stop generating. Keep prompts highly concise.
6. NO PRAISE / NO SUMMARIZING: Say "Understood," "Got it," or "Noted." NEVER say "Great answer," "Awesome," or summarize what they just said.
7. NO TEACHING: You are an evaluator, not a mentor. If they are wrong, do not correct them. Probe their flawed logic, note the failure mentally, and pivot.

[EXPANDED EDGE CASE & INTERRUPTION HANDLING]
- Candidate cuts you off / Interrupts mid-sentence: STOP SPEAKING INSTANTLY. Yield the floor, listen to what they say, and adapt your next turn.
- Candidate stalls ("hmm", "let me think", "uh"): DO NOT INTERRUPT. Stay silent. Wait for them to formulate.
- Candidate stops midway / Audio cuts off: Wait briefly. If silence persists, ask: "Are you still there? You cut off after saying [last word]."
- Rambling / Going off-topic: Interrupt decisively. "Let's pause there. I want to refocus specifically on [Core Technical Question]." -> Re-ask the exact question.
- Confident but totally wrong: DO NOT CORRECT. Drill into their flawed logic to expose it: "Walk me through how that architecture handles [Specific Edge Case]."
- Candidate asks for hints/validation: NEVER HINT OR VALIDATE. "I want to hear your approach. What is your reasoning?"
- Obvious reading from a script/AI: Challenge immediately with a hyper-specific, situational follow-up that cannot be easily searched.
- Repeated "I don't know" / 1-word answers: Acknowledge briefly ("Noted.") and pivot logically, BUT document the failure.
- Meta/Personal Questions ("Are you an AI?"): Deflect coldly: "Let's keep the focus on the technical assessment."

[PROFANITY] NEVER use offensive language. Maintain strict professional authority.`;
}
// ... existing code ...
// ─── Main Component ───────────────────────────────────────────────────────────

export default function AriaV5() {
  const [useFriendlyUI, setUseFriendlyUI] = useState(true);

  // Setup
  const [phase, setPhase] = useState<AppPhase>('setup');
  const [cvText, setCvText] = useState('');
  const [jdText, setJdText] = useState('');
  const [candidateName, setCandidateName] = useState('');
  const [cvFileName, setCvFileName] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [setupErr, setSetupErr] = useState('');
  const [numQuestions, setNumQuestions] = useState(5);
  const [interviewDuration, setInterviewDuration] = useState(10);
  const [jdTab, setJdTab] = useState<'manual' | 'templates'>('manual');

  // Live
  const [isCallActive, setIsCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState('Ready');
  const [isMuted, setIsMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isCallEnded, setIsCallEnded] = useState(false);

  // Interview state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scores, setScores] = useState<AnswerScore[]>([]);
  const [questionCount, setQuestionCount] = useState(0);
  const [cvSummary, setCvSummary] = useState('');
  const [strategy, setStrategy] = useState<InterviewStrategy | null>(null);
  const [currentTopic, setCurrentTopic] = useState('');
  const [interviewTimeLeft, setInterviewTimeLeft] = useState(600);
  const [intelLog, setIntelLog] = useState<IntelLog[]>([]);
  const [warmupTurns, setWarmupTurns] = useState(0);
  const [silenceTimeLeft, setSilenceTimeLeft] = useState<number | null>(null);
  const [usage, setUsage] = useState<Usage>({ rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0, miniPrompt: 0, miniCompletion: 0 });
  const [observerStatus, setObserverStatus] = useState<'idle' | 'scoring' | 'phasing'>('idle');
  const [lastScore, setLastScore] = useState<AnswerScore | null>(null);
  const [historySummary, setHistorySummary] = useState('');
  const [behavior, setBehavior] = useState<BehaviorProfile>({ style: 'neutral', softSkills: 5, communication: 5, moodScore: 50 });

  // Refs
  const phaseRef = useRef<AppPhase>('setup');
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const isEndingRef = useRef(false);
  const isStartingRef = useRef(false);

  const convHistoryRef = useRef<{ role: 'user' | 'assistant' | 'system'; content: string }[]>([]);
  const rtItemIdsRef = useRef<{ id: string; role: string; text: string }[]>([]);
  const historySummaryRef = useRef('');
  const prunedBufferRef = useRef<{ role: string; text: string }[]>([]);
  const userTurnCountRef = useRef(0);
  const observerRunTurnRef = useRef(-1);
  const isObserverRunningRef = useRef(false);
  const lastAiQuestionRef = useRef('');
  const warmupTurnsRef = useRef(0);
  const wrapupTurnsRef = useRef(0);
  const lastSystemItemIdRef = useRef<string | null>(null);

  const cvTextRef = useRef('');
  const jdTextRef = useRef('');
  const cvSummaryRef = useRef('');
  const candidateNameRef = useRef('');
  const strategyRef = useRef<InterviewStrategy | null>(null);
  const scoresRef = useRef<AnswerScore[]>([]);
  const numQuestionsRef = useRef(5);
  const interviewDurationRef = useRef(10);
  const scoringQuestionRef = useRef('');
  const scoredTurnRef = useRef(-1);
  const skipNextScoreRef = useRef(false);
  const currentTopicRef = useRef('general');

  const usageRef = useRef<Usage>({ rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0, miniPrompt: 0, miniCompletion: 0 });

  // Timers
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceStartTimeRef = useRef(0);
  const silenceDurationRef = useRef(0);
  const currentSilenceMsRef = useRef(SILENCE_BASE_MS);
  const silencePromptCountRef = useRef(0);
  const isAISpeakingRef = useRef(false);
  const aiSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEndRef = useRef(false);
  const interviewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const accumulatedElapsedMsRef = useRef(0);

  // Sync refs
  useEffect(() => { cvTextRef.current = cvText; }, [cvText]);
  useEffect(() => { jdTextRef.current = jdText; }, [jdText]);
  useEffect(() => { candidateNameRef.current = candidateName; }, [candidateName]);
  useEffect(() => { numQuestionsRef.current = numQuestions; }, [numQuestions]);
  useEffect(() => { interviewDurationRef.current = interviewDuration; }, [interviewDuration]);

  const updateUsage = useCallback(() => setUsage({ ...usageRef.current }), []);

  const addIntelLog = useCallback((type: IntelLog['type'], message: string) => {
    const id = makeId();
    setIntelLog(prev => [{ id, type, message, status: 'active' as const }, ...prev].slice(0, 8));
    return id;
  }, []);

  const updateIntelLog = useCallback((id: string, status: IntelLog['status'], message?: string) => {
    setIntelLog(prev => prev.map(l => l.id === id ? { ...l, status, ...(message ? { message } : {}) } : l));
  }, []);

  const sendRt = useCallback((msg: object) => {
    const dc = dcRef.current;
    if (dc?.readyState === 'open' && !isEndingRef.current) dc.send(JSON.stringify(msg));
  }, []);

  // ── Clean System Inject (Auto-cleans previous, no stacking) ──────────────
  const injectSystemMessage = useCallback((text: string, forceResponse = false) => {
    // Delete previous directive to prevent confusion stacking
    if (lastSystemItemIdRef.current) {
      sendRt({ type: 'conversation.item.delete', item_id: lastSystemItemIdRef.current });
    }

    const newItemId = makeId();
    sendRt({
      type: 'conversation.item.create',
      item: { id: newItemId, type: 'message', role: 'system', content: [{ type: 'input_text', text }] }
    });
    lastSystemItemIdRef.current = newItemId;
    convHistoryRef.current = [...convHistoryRef.current.slice(-39), { role: 'system', content: text }];

    if (forceResponse) sendRt({ type: 'response.create' });
  }, [sendRt]);

  // ── Silence Timer ──────────────────────────────────────────────────────────
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) { clearInterval(silenceTimerRef.current); silenceTimerRef.current = null; }
    setSilenceTimeLeft(null);
  }, []);

  const endCall = useCallback(() => {
    if (isEndingRef.current) return;
    isEndingRef.current = true;
    clearSilenceTimer();
    if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    pcRef.current?.close();
    dcRef.current?.close();
    streamRef.current?.getTracks().forEach(t => t.stop());
    pcRef.current = null; dcRef.current = null; streamRef.current = null;
    if (audioElRef.current) audioElRef.current.srcObject = null;
    setIsCallActive(false);
    setIsCallEnded(true);
    setCallStatus('Interview Ended');
  }, [clearSilenceTimer]);

  const startSilenceTimer = useCallback((ms?: number) => {
    clearSilenceTimer();
    if (isEndingRef.current || ['report', 'setup', 'connecting', 'closing'].includes(phaseRef.current)) return;

    const timeout = ms || currentSilenceMsRef.current;
    silenceStartTimeRef.current = Date.now();
    silenceDurationRef.current = timeout;
    setSilenceTimeLeft(timeout);

    silenceTimerRef.current = setInterval(() => {
      if (isAISpeakingRef.current) { silenceStartTimeRef.current = Date.now(); }
      const elapsed = Date.now() - silenceStartTimeRef.current;
      const remaining = Math.max(0, silenceDurationRef.current - elapsed);
      setSilenceTimeLeft(remaining);

      if (remaining <= 0) {
        clearSilenceTimer();
        silencePromptCountRef.current++;

        if (silencePromptCountRef.current >= MAX_SILENCE_STRIKES) {
          addIntelLog('silence', 'Max silence reached. Ending call.');
          endCall();
          return;
        }

        // Minimal silence injection — RT handles the actual response
        injectSystemMessage(
          `SILENCE ALERT (Strike ${silencePromptCountRef.current}/${MAX_SILENCE_STRIKES}): Candidate has been silent. Check in naturally with ONE of: "Still with me?" / "Take your time." / "Want me to rephrase that?" Then wait.`,
          true
        );
        currentSilenceMsRef.current = SILENCE_BASE_MS;
      }
    }, 100);
  }, [clearSilenceTimer, injectSystemMessage, addIntelLog, endCall]);

  // ── Phase Transition ───────────────────────────────────────────────────────
  const transitionPhase = useCallback((newPhase: AppPhase) => {
    if (isEndingRef.current) return;
    phaseRef.current = newPhase;
    setPhase(newPhase);

    if (newPhase === 'interview') skipNextScoreRef.current = true;

    // Rebuild the full RT prompt for the new phase — RT gets fresh, complete context
    const prompt = buildRTBrainPrompt({
      phase: newPhase,
      candidateName: candidateNameRef.current,
      cvSummary: cvSummaryRef.current,
      jdText: jdTextRef.current,
      strategy: strategyRef.current,
      numQuestions: numQuestionsRef.current,
      interviewDurationMins: interviewDurationRef.current,
      historySummary: historySummaryRef.current,
      personality: behavior.moodScore < 35 ? 'nice' : behavior.moodScore > 65 ? 'strict' : 'neutral',
    });

    sendRt({
      type: 'session.update',
      session: {
        instructions: prompt,
        input_audio_transcription: { model: 'whisper-1', language: 'en' },
      },
    });

    addIntelLog('phase', `Phase → ${newPhase.toUpperCase()}`);
  }, [sendRt, addIntelLog]);

  // ── Interview Timer ─────────────────────────────────────────────────────────
  const startInterviewTimer = useCallback(() => {
    accumulatedElapsedMsRef.current = 0;
    if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);

    interviewTimerRef.current = setInterval(() => {
      if (isEndingRef.current) { clearInterval(interviewTimerRef.current!); return; }
      if (!isAISpeakingRef.current) accumulatedElapsedMsRef.current += 1000;

      const totalMs = interviewDurationRef.current * 60 * 1000;
      const remaining = Math.max(0, totalMs - accumulatedElapsedMsRef.current);
      setInterviewTimeLeft(Math.floor(remaining / 1000));

      // 80% warning
      const elapsed = accumulatedElapsedMsRef.current;
      if (elapsed >= totalMs * 0.8 && elapsed < totalMs * 0.8 + 1000) {
        injectSystemMessage('SYSTEM NOTE: You are running low on time. Start wrapping up your current topic naturally.', false);
      }

      if (elapsed >= totalMs) {
        clearInterval(interviewTimerRef.current!);
        injectSystemMessage('SYSTEM DIRECTIVE: Time limit reached. Complete your current question, then immediately transition to wrap-up by asking the candidate if they have any questions for you.', false);
        transitionPhase('wrapup');
      }
    }, 1000);
  }, [injectSystemMessage, transitionPhase]);

  // ── Strategy Generator (Observer's ONE Job at Interview Start) ────────────
  const generateAndInjectStrategy = useCallback(async () => {
    const tid = addIntelLog('strategy', 'Generating interview strategy (50% CV / 50% JD)...');
    try {
      const raw = await callMini(
        `You are a senior technical interviewer preparing for an interview.

  CV Summary: ${cvSummaryRef.current}
  Job Description: ${jdTextRef.current.slice(0, 1500)}
  Total Questions Needed: ${numQuestionsRef.current}

  Generate an interview strategy with ${numQuestionsRef.current} questions total.
  STRICT RULES:
  1. Exactly 50% of topics sourced from CV (the candidate's actual experience, projects, tech they've used).
  2. Exactly 50% of topics sourced from JD (requirements, skills expected for the role).
  3. Every question MUST reference a specific concept, tool, or scenario — never generic.
  4. 3 questions per topic max.
  5. Questions should naturally escalate: foundational → applied → edge case.
  6. CV-sourced questions should reference real projects/companies from the CV.

  Return ONLY JSON:
  {
    "topics": [
      {
        "name": "React Performance Optimization",
        "source": "cv",
        "questions": [
          "I see you worked on [specific project] — how did you handle re-render performance at scale?",
          "When would you choose useMemo vs useCallback, and what's the overhead cost of each?",
          "Walk me through a time a profiling tool changed your approach completely."
        ]
      },
      {
        "name": "System Design",
        "source": "jd",
        "questions": [
          "How would you design a rate-limited API that handles 10k requests/second?",
          "What breaks first in a microservices architecture under unexpected load?",
          "How do you decide between event-driven and request-response patterns?"
        ]
      }
    ]
  }`,
        'Interview strategy generator. JSON only. No markdown.',
        usageRef, true
      );
      updateUsage();

      let parsed: InterviewStrategy;
      try {
        const clean = raw.replace(/```json|```/gi, '').trim();
        const start = clean.indexOf('{'); const end = clean.lastIndexOf('}');
        parsed = JSON.parse(clean.substring(start, end + 1));
      } catch {
        parsed = {
          topics: [
            { name: 'Core Technical Skills', source: 'jd', questions: ['What is your strongest technical skill and how have you applied it under pressure?', 'Walk me through a complex problem you solved recently.', 'What trade-offs did you make in your last major project?'] },
            { name: 'Past Experience', source: 'cv', questions: ['Tell me about the most challenging project on your CV.', 'How did you handle technical debt in that project?', 'What would you do differently today?'] },
          ]
        };
      }

      strategyRef.current = parsed;
      setStrategy(parsed);
      updateIntelLog(tid, 'done', `Strategy ready: ${parsed.topics.length} topics, ${parsed.topics.reduce((a, t) => a + t.questions.length, 0)} questions ✓`);

      // Set first topic for display
      if (parsed.topics[0]) {
        currentTopicRef.current = parsed.topics[0].name;
        setCurrentTopic(parsed.topics[0].name);
      }

      // THIS IS THE KEY: Inject the complete strategy into RT's context ONCE.
      // RT will use this as its conversational roadmap. No repeated injections.
      const strategyText = parsed.topics.map((t, i) =>
        `Topic ${i + 1} [${t.source.toUpperCase()}]: ${t.name}\n` +
        t.questions.map((q, qi) => `  Q${qi + 1}: ${q}`).join('\n')
      ).join('\n\n');

      injectSystemMessage(
        `INTERVIEW STRATEGY LOADED — Follow this as your conversational roadmap:

  ${strategyText}

  INSTRUCTIONS:
  - Work through topics naturally. Start with Topic 1, Q1.
  - Connect each question to their previous answer when possible.
  - Adapt difficulty based on their answers (go deeper if strong, simplify if struggling).
  - Cover all topics. Target ${numQuestionsRef.current} total scored answers.
  - This is injected ONCE. Use it. The observer will not remind you again.`,
        false
      );

      return parsed;
    } catch (e) {
      updateIntelLog(tid, 'error', 'Strategy generation failed');
      return null;
    }
  }, [addIntelLog, updateIntelLog, injectSystemMessage, updateUsage]);

  // ── Pruned Summary Generator ──────────────────────────────────────────────
  const summarizePruned = useCallback(async () => {
    if (prunedBufferRef.current.length === 0) return;
    const batch = [...prunedBufferRef.current];
    prunedBufferRef.current = [];

    const historyStr = batch.map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
    const tid = addIntelLog('observer', `Summarizing ${batch.length} pruned messages...`);

    try {
      const prompt = `Condense the following conversation snippet into a 1-sentence technical recap. Merge it with the Existing Summary.
  Existing Summary: ${historySummaryRef.current || 'None yet.'}
  New Snippet:
  ${historyStr}

  Return ONLY the updated, single-paragraph concise summary.`;

      const newSummary = await callMini(prompt, 'Conversation summarizer. Very concise.', usageRef);
      updateUsage();

      historySummaryRef.current = newSummary;
      setHistorySummary(newSummary);

      const rtPrompt = buildRTBrainPrompt({
        phase: phaseRef.current,
        candidateName: candidateNameRef.current,
        cvSummary: cvSummaryRef.current,
        jdText: jdTextRef.current,
        strategy: strategyRef.current,
        numQuestions: numQuestionsRef.current,
        interviewDurationMins: interviewDurationRef.current,
        historySummary: newSummary,
        personality: behavior.moodScore < 35 ? 'nice' : behavior.moodScore > 65 ? 'strict' : 'neutral',
      });

      sendRt({
        type: 'session.update',
        session: { instructions: rtPrompt }
      });

      updateIntelLog(tid, 'done', 'History summarized ✓');
    } catch (e) {
      updateIntelLog(tid, 'error', 'Summarization failed');
    }
  }, [addIntelLog, updateUsage, sendRt, behavior.moodScore]);

  // ── Observer: Scoring Only (No Flow Control) ───────────────────────────────
  const scoreAnswer = useCallback(async (answerSummary: string) => {
    const currentTurn = userTurnCountRef.current;
    if (scoredTurnRef.current === currentTurn) return;
    if (skipNextScoreRef.current) { skipNextScoreRef.current = false; return; }
    if (!answerSummary || answerSummary.length < 10) return;

    scoredTurnRef.current = currentTurn;
    setObserverStatus('scoring');
    const tid = addIntelLog('score', 'Scoring answer...');

    try {
      const [scoreRaw, feedbackRaw] = await Promise.all([
        callMini(
          `Technical interview evaluation.
  Question: "${scoringQuestionRef.current}"
  Answer: "${answerSummary}"

  Evaluate technical depth AND behavioral style. Return JSON:
  {
    "question_summary": "concise summary",
    "score": <1-10>,
    "technical_accuracy": <1-10>,
    "logic_evaluation": "one sentence",
    "missed_opportunities": [".."],
    "confidence": "high|medium|low",
    "grammar": "good|average|poor",
    "clarity": "good|average|poor",
    "depth": "shallow|adequate|deep",
    "behavioral_trait": "neutral|shy|confident|rambling|concise|arrogant",
    "soft_skills": <1-10>,
    "communication_score": <1-10>
  }`,
          'Technical & Behavioral evaluator. JSON only.', usageRef, true
        ),
        callMini(
          `Interview feedback and tags.
  Question: "${scoringQuestionRef.current}"
  Answer: "${answerSummary}"
  Topic: "${currentTopicRef.current}"

  Return JSON:
  {
    "feedback": "<one sentence>",
    "tags": ["<tag1>", "<tag2>"],
    "topic": "${currentTopicRef.current}"
  }`,
          'Feedback generator. JSON only.', usageRef, true
        )
      ]);
      updateUsage();

      let parsedScore: any = {};
      let parsedFeedback: any = {};
      try { parsedScore = JSON.parse(scoreRaw.replace(/```json|```/gi, '').trim()); } catch { }
      try { parsedFeedback = JSON.parse(feedbackRaw.replace(/```json|```/gi, '').trim()); } catch { }

      // Granular Personality Update (Mood Swing Prevention)
      setBehavior(prev => {
        const soft = parsedScore.soft_skills || 5;
        const comm = parsedScore.communication_score || 5;
        const trait = parsedScore.behavioral_trait || 'neutral';

        let moodShift = 0;
        if (trait === 'arrogant' || trait === 'rambling') moodShift = 15;
        if (trait === 'shy') moodShift = -15;
        if (soft >= 8) moodShift -= 5;
        if (soft <= 3) moodShift += 5;

        // Drift back to neutral (50)
        const currentMood = prev.moodScore;
        const drift = currentMood > 55 ? -3 : currentMood < 45 ? 3 : 0;

        const nextMood = Math.min(100, Math.max(0, currentMood + moodShift + drift));

        // If mood crosses a threshold, we will update RT session on next turn or now?
        // Let's update state for UI and the next prompt cycle will use it.
        return { style: trait, softSkills: soft, communication: comm, moodScore: nextMood };
      });

      const finalScore = Math.min(10, Math.max(1, parsedScore.score || 5));

      const score: AnswerScore = {
        question: scoringQuestionRef.current || 'Technical Question',
        questionSummary: parsedScore.question_summary || '',
        answerSummary: answerSummary.slice(0, 200),
        score: finalScore,
        feedback: parsedFeedback.feedback || '',
        tags: parsedFeedback.tags || [],
        topic: currentTopicRef.current,
        depth: 1,
        confidence: parsedScore.confidence,
        grammar: parsedScore.grammar,
        clarity: parsedScore.clarity,
        depthStr: parsedScore.depth,
        technicalAccuracy: parsedScore.technical_accuracy,
        missedOpportunities: parsedScore.missed_opportunities || [],
        logicEvaluation: parsedScore.logic_evaluation,
      };

      scoresRef.current = [...scoresRef.current, score];
      setScores([...scoresRef.current]);
      setLastScore(score);
      setQuestionCount(scoresRef.current.length);
      updateIntelLog(tid, 'done', `Score: ${finalScore}/10 | Style: ${parsedScore.behavioral_trait} ✓`);

      // Injecting adaptive hints based on score
      if (finalScore <= 3) {
        injectSystemMessage(`ADAPTIVE HINT: Last answer scored low (${finalScore}/10). Adjust next question difficulty.`, false);
      } else if (finalScore >= 8) {
        injectSystemMessage(`ADAPTIVE HINT: Strong answer (${finalScore}/10). Push harder.`, false);
      }

    } catch (e) {
      console.error('[Score] failed:', e);
      updateIntelLog(tid, 'error', 'Scoring failed');
    } finally {
      setObserverStatus('idle');
    }
  }, [addIntelLog, updateIntelLog, injectSystemMessage, updateUsage]);

  // ── Observer: Phase Transition Detection ───────────────────────────────────
  // This is the ONLY phase control the observer does. Everything else is RT-driven.
  const runPhaseObserver = useCallback(async () => {
    if (isObserverRunningRef.current || isEndingRef.current) return;
    if (userTurnCountRef.current <= observerRunTurnRef.current) return;

    isObserverRunningRef.current = true;
    observerRunTurnRef.current = userTurnCountRef.current;

    const currentPhase = phaseRef.current;

    try {
      const recentHistory = convHistoryRef.current.slice(-6).map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n');

      // WARMUP → INTERVIEW (Safety net: RT manages this but observer confirms)
      if (currentPhase === 'warmup') {
        warmupTurnsRef.current += 1;
        setWarmupTurns(warmupTurnsRef.current);

        // After 3 substantive user turns in warmup + candidate gave professional intro → move to interview
        if (warmupTurnsRef.current >= WARMUP_TURNS_REQUIRED) {
          const checkRaw = await callMini(
            `Transcript (last 6 messages):
  ${recentHistory}

  Evaluate phase transition AND behavioral style.
  Return JSON: 
  {
    "gave_professional_intro": boolean,
    "behavioral_trait": "neutral|shy|confident|rambling|concise|arrogant",
    "soft_skills": <1-10>,
    "communication": <1-10>
  }`,
            'Phase & Behavior check. JSON only.', usageRef, true
          );
          updateUsage();

          let check: any = { gave_professional_intro: false, behavioral_trait: 'neutral', soft_skills: 5, communication: 5 };
          try { check = JSON.parse(checkRaw.replace(/```json|```/gi, '').trim()); } catch { }

          // Update behavior even in warmup
          setBehavior(prev => {
            const trait = check.behavioral_trait || 'neutral';
            const soft = check.soft_skills || 5;
            let moodShift = 0;
            if (trait === 'arrogant' || trait === 'rambling') moodShift = 10;
            if (trait === 'shy') moodShift = -10;
            const currentMood = prev.moodScore;
            const drift = currentMood > 50 ? -2 : currentMood < 50 ? 2 : 0;
            const nextMood = Math.min(100, Math.max(0, currentMood + moodShift + drift));
            return { style: trait, softSkills: soft, communication: check.communication || 5, moodScore: nextMood };
          });

          if (check.gave_professional_intro || warmupTurnsRef.current >= WARMUP_TURNS_REQUIRED + 1) {
            setObserverStatus('phasing');
            addIntelLog('phase', 'Warmup complete → generating strategy & starting interview...');
            transitionPhase('interview');
            startInterviewTimer();
            await generateAndInjectStrategy();
            setObserverStatus('idle');
            return;
          }
        }
      }

      // INTERVIEW → WRAPUP (when enough questions scored)
      if (currentPhase === 'interview' && scoresRef.current.length >= numQuestionsRef.current) {
        setObserverStatus('phasing');
        addIntelLog('phase', `${scoresRef.current.length}/${numQuestionsRef.current} questions scored → transitioning to wrapup`);
        injectSystemMessage('SYSTEM: Evaluation complete. Transition smoothly to wrap-up. Ask if they have any questions for you. Do NOT ask more technical questions.', false);
        transitionPhase('wrapup');
        wrapupTurnsRef.current = 0;
        setObserverStatus('idle');
        return;
      }

      // WRAPUP → CLOSING (simple: after a few wrapup turns or candidate signals done)
      if (currentPhase === 'wrapup') {
        wrapupTurnsRef.current += 1;

        if (wrapupTurnsRef.current >= 4) {
          const checkRaw = await callMini(
            `Transcript:
  ${recentHistory}

  Has the candidate explicitly signaled they're done (said "no more questions", "that's all", "thanks", "goodbye", etc.)?
  Return JSON: {"candidate_done": boolean}`,
            'Wrapup check. JSON only.', usageRef, true
          );
          updateUsage();

          let check: any = { candidate_done: false };
          try { check = JSON.parse(checkRaw.replace(/```json|```/gi, '').trim()); } catch { }

          if (check.candidate_done || wrapupTurnsRef.current >= 6) {
            setObserverStatus('phasing');
            addIntelLog('phase', 'Wrapup complete → closing');
            injectSystemMessage('SYSTEM: Candidate is done with their questions. Give a warm, brief farewell and close the interview.', false);
            transitionPhase('closing');
            setObserverStatus('idle');
            return;
          }
        }
      }

      // CLOSING → End Call
      if (currentPhase === 'closing') {
        const checkRaw = await callMini(
          `Transcript:
  ${recentHistory}

  Has Aria said a clear farewell (goodbye, best of luck, take care, thanks for your time, etc.)?
  Return JSON: {"aria_said_farewell": boolean}`,
          'Closing check. JSON only.', usageRef, true
        );
        updateUsage();

        let check: any = { aria_said_farewell: false };
        try { check = JSON.parse(checkRaw.replace(/```json|```/gi, '').trim()); } catch { }

        if (check.aria_said_farewell) {
          setTimeout(() => { if (isAISpeakingRef.current) pendingEndRef.current = true; else endCall(); }, 2000);
        }
      }

      // Score interview answers (only in interview phase)
      if (currentPhase === 'interview') {
        const lastUserMsg = convHistoryRef.current.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
        if (lastUserMsg.length > 8) {
          await scoreAnswer(lastUserMsg);
        }
      }

    } catch (e) {
      console.error('[PhaseObserver] error:', e);
    } finally {
      isObserverRunningRef.current = false;
    }
  }, [addIntelLog, transitionPhase, startInterviewTimer, generateAndInjectStrategy, scoreAnswer, injectSystemMessage, updateUsage, endCall]);

  // ── RT Event Handler ────────────────────────────────────────────────────────
  const handleRtEvent = useCallback((ev: Record<string, unknown>) => {
    switch (ev.type as string) {

      case 'conversation.item.created': {
        const item = ev.item as Record<string, unknown>;
        if (!item?.id) break;
        const id = item.id as string;
        const role = (item.role as string) || 'system';
        rtItemIdsRef.current = [...rtItemIdsRef.current, { id, role, text: '' }];

        // Pruning logic
        if (rtItemIdsRef.current.length > MAX_RT_CONTEXT) {
          const oldest = rtItemIdsRef.current.shift();
          if (oldest) {
            sendRt({ type: 'conversation.item.delete', item_id: oldest.id });
            if (oldest.text && oldest.role !== 'system') {
              prunedBufferRef.current.push({ role: oldest.role, text: oldest.text });
              if (prunedBufferRef.current.length >= 2) summarizePruned();
            }
          }
        }

        if (role !== 'system') {
          setLogs(prev => prev.find(l => l.id === id) ? prev : [...prev, { id, role: role === 'assistant' ? 'ai' : 'user', text: '', pending: true }]);
        }
        break;
      }

      case 'input_audio_buffer.speech_started':
        setCallStatus('Listening...');
        silencePromptCountRef.current = 0;
        clearSilenceTimer();
        scoringQuestionRef.current = lastAiQuestionRef.current;
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
        const transcript = ev.transcript as string;
        const itemId = ev.item_id as string;
        if (transcript) {
          // Update tracking for summary
          const rtIdx = rtItemIdsRef.current.findIndex(p => p.id === itemId);
          if (rtIdx !== -1) rtItemIdsRef.current[rtIdx].text = transcript;

          setLogs(prev => {
            const idx = prev.findIndex(l => l.id === itemId);
            if (idx === -1) return [...prev, { id: itemId, role: 'ai', text: transcript }];
            const copy = [...prev];
            copy[idx] = { ...copy[idx], text: transcript, pending: false };
            return copy;
          });
          convHistoryRef.current = [...convHistoryRef.current.slice(-39), { role: 'assistant', content: transcript }];
          if (transcript.includes('?')) lastAiQuestionRef.current = transcript;
        }
        setCallStatus('Listening...');
        startSilenceTimer();
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const text = ((ev.transcript as string) || '').trim();
        const itemId = ev.item_id as string;
        if (!text) break;

        // Update tracking for summary
        const rtIdx = rtItemIdsRef.current.findIndex(p => p.id === itemId);
        if (rtIdx !== -1) rtItemIdsRef.current[rtIdx].text = text;

        convHistoryRef.current = [...convHistoryRef.current.slice(-39), { role: 'user', content: text }];
        setLogs(prev => {
          const idx = prev.findIndex(l => l.id === itemId);
          if (idx === -1) return [...prev, { id: itemId, role: 'user', text }];
          const copy = [...prev];
          copy[idx] = { ...copy[idx], text, pending: false };
          return copy;
        });

        userTurnCountRef.current += 1;
        // Observer ONLY fires for phase checks and scoring — not flow control
        runPhaseObserver();
        break;
      }

      case 'response.done': {
        const resp = ev.response as Record<string, unknown> | undefined;
        if (resp?.usage) {
          const u = resp.usage as Record<string, unknown>;
          const inp = (u.input_token_details as Record<string, number>) || {};
          const out = (u.output_token_details as Record<string, number>) || {};
          usageRef.current.rtTextIn += inp.text_tokens || 0;
          usageRef.current.rtAudioIn += inp.audio_tokens || 0;
          usageRef.current.rtTextOut += out.text_tokens || 0;
          usageRef.current.rtAudioOut += out.audio_tokens || 0;
        }
        updateUsage();
        setCallStatus('Listening...');
        break;
      }

      case 'response.output_item.added': {
        const item = ev.item as Record<string, unknown> | undefined;
        if ((item?.role as string) === 'assistant') {
          setCallStatus('Speaking...');
          clearSilenceTimer();
          isAISpeakingRef.current = true;
        }
        break;
      }

      case 'response.output_item.done': {
        isAISpeakingRef.current = false;
        if (pendingEndRef.current) { pendingEndRef.current = false; endCall(); }
        break;
      }
    }
  }, [runPhaseObserver, clearSilenceTimer, startSilenceTimer, sendRt, endCall]);

  // ─────────────────────────────────────────────────────────────────────────
  // Call Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  const handleCvFile = async (file: File) => {
    setIsParsing(true); setSetupErr(''); setCvFileName(file.name);
    try {
      const text = await extractTextFromFile(file);
      if (!text || text.trim().length < 50) { setSetupErr('Could not extract text. Please paste CV text directly.'); setCvFileName(''); setIsParsing(false); return; }
      setCvText(text); cvTextRef.current = text;
      try {
        const name = await callMini(`Extract candidate's full name from CV. Return ONLY the name, nothing else.\n${text.slice(0, 1500)}`, 'Name extractor.', usageRef);
        const clean = name.replace(/["']/g, '').trim();
        if (clean && clean.length > 1 && clean.length < 60) { setCandidateName(clean); candidateNameRef.current = clean; }
      } catch { }
    } catch { setSetupErr('Failed to read file.'); setCvFileName(''); }
    setIsParsing(false);
  };

  const startCall = useCallback(async () => {
    if (isStartingRef.current || isCallActive) return;
    if (!cvText && !jdText) { setSetupErr('Please upload a CV or paste a Job Description.'); return; }
    isStartingRef.current = true;
    isEndingRef.current = false;

    // Reset all state
    setLogs([]); setScores([]); setQuestionCount(0); setCvSummary('');
    setStrategy(null); setCurrentTopic(''); setWarmupTurns(0); setIntelLog([]);
    setInterviewTimeLeft(interviewDuration * 60); setIsCallEnded(false);
    setLastScore(null); setObserverStatus('idle');
    setHistorySummary('');
    setBehavior({ style: 'neutral', softSkills: 5, communication: 5, moodScore: 50 });

    convHistoryRef.current = [];
    rtItemIdsRef.current = [];
    historySummaryRef.current = '';
    prunedBufferRef.current = [];
    userTurnCountRef.current = 0;
    observerRunTurnRef.current = -1;
    isObserverRunningRef.current = false;
    lastAiQuestionRef.current = '';
    warmupTurnsRef.current = 0;
    wrapupTurnsRef.current = 0;
    lastSystemItemIdRef.current = null;
    scoresRef.current = [];
    strategyRef.current = null;
    cvSummaryRef.current = '';
    currentTopicRef.current = 'general';
    usageRef.current = { rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0, miniPrompt: 0, miniCompletion: 0 };
    currentSilenceMsRef.current = SILENCE_BASE_MS;
    silencePromptCountRef.current = 0;
    accumulatedElapsedMsRef.current = 0;
    clearSilenceTimer();

    setCallStatus('Connecting...');
    setPhase('connecting');

    // Pre-process CV summary
    if (cvText) {
      try {
        const summary = await callMini(
          `Create a concise interviewer briefing from this CV. Include: full name, current role, years of experience, top technical skills, notable projects/achievements. Max 200 words.\n\nCV:\n${cvText}`,
          'CV analyst. Flowing prose. No bullets.', usageRef
        );
        if (summary) { cvSummaryRef.current = summary; setCvSummary(summary); }
        updateUsage();
      } catch { }
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
        const outCtx = new AudioContext();
        const outSource = outCtx.createMediaStreamSource(e.streams[0]);
        const outAnalyser = outCtx.createAnalyser();
        outAnalyser.fftSize = 256;
        outSource.connect(outAnalyser);
        const outData = new Uint8Array(outAnalyser.frequencyBinCount);

        const checkAudio = () => {
          if (isEndingRef.current) return;
          outAnalyser.getByteFrequencyData(outData);
          const avg = outData.reduce((a, b) => a + b, 0) / outData.length;
          if (avg > 2) {
            isAISpeakingRef.current = true;
            if (aiSilenceTimerRef.current) { clearTimeout(aiSilenceTimerRef.current); aiSilenceTimerRef.current = null; }
          } else if (isAISpeakingRef.current) {
            if (!aiSilenceTimerRef.current) {
              aiSilenceTimerRef.current = setTimeout(() => {
                isAISpeakingRef.current = false;
                aiSilenceTimerRef.current = null;
                if (pendingEndRef.current) endCall();
              }, 600);
            }
          }
          requestAnimationFrame(checkAudio);
        };
        checkAudio();
      };

      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = ms;
      ms.getTracks().forEach(t => pc.addTrack(t, ms));

      const actx = new AudioContext();
      const src = actx.createMediaStreamSource(ms);
      const analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const fdata = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (isEndingRef.current) return;
        analyser.getByteFrequencyData(fdata);
        setMicLevel(Math.min(100, (fdata.reduce((a, b) => a + b, 0) / fdata.length) * 2.2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      dc.onopen = () => {
        phaseRef.current = 'warmup';
        setPhase('warmup');
        warmupTurnsRef.current = 0;

        const warmupPrompt = buildRTBrainPrompt({
          phase: 'warmup',
          candidateName: candidateNameRef.current,
          cvSummary: cvSummaryRef.current,
          jdText: jdTextRef.current,
          strategy: null,
          numQuestions: numQuestionsRef.current,
          interviewDurationMins: interviewDurationRef.current,
          historySummary: historySummaryRef.current,
          personality: 'neutral',
        });

        sendRt({
          type: 'session.update',
          session: {
            instructions: warmupPrompt,
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: { type: 'server_vad' },
            modalities: ['text', 'audio'],
            voice: 'shimmer',
            tools: [], tool_choice: 'none',
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
      pcRef.current?.close(); streamRef.current?.getTracks().forEach(t => t.stop());
      setIsCallActive(false); isStartingRef.current = false;
    }
  }, [isCallActive, cvText, jdText, sendRt, handleRtEvent, clearSilenceTimer, endCall, updateUsage, interviewDuration]);

  const toggleMute = () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setIsMuted(!track.enabled); }
  };

  useEffect(() => {
    if (!isCallActive) return;
    const iv = setInterval(() => { setDuration(d => d + 1); }, 1000);
    return () => clearInterval(iv);
  }, [isCallActive]);

  // ─────────────────────────────────────────────────────────────────────────
  // UI
  // ─────────────────────────────────────────────────────────────────────────

  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b.score, 0) / scores.length : 0;
  const scoreColor = (s: number) => s >= 8 ? '#22c55e' : s >= 6 ? '#f59e0b' : s >= 4 ? '#f97316' : '#ef4444';
  const timeLeftPct = (interviewTimeLeft / (interviewDuration * 60)) * 100;
  const timerColor = timeLeftPct > 40 ? '#22c55e' : timeLeftPct > 20 ? '#f59e0b' : '#ef4444';
  const isSpeaking = callStatus === 'Speaking...';

  const BARS = 18;
  const waveHeights = Array.from({ length: BARS }, (_, i) => {
    const wave = Math.sin((i / BARS) * Math.PI * 2 + Date.now() / 280) * 0.5 + 0.5;
    return Math.max(2, Math.round((micLevel / 100) * wave * 30 + 2));
  });

  const activeLogs = logs.filter(l => !l.pending || l.text);

  const CSS = `
      @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=Syne:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,700;1,400&display=swap');
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      :root {
        --bg: #070b12; --bg2: #0c1220; --bg3: #111927;
        --line: #1c2840; --line2: #263550;
        --blue: #3b7bff; --green: #22c55e; --amber: #f59e0b;
        --red: #ef4444; --violet: #c084fc; --cyan: #38bdf8;
        --text: #e2eaf8; --text2: #7a90b0; --text3: #3a506a;
        --mono: 'DM Mono', monospace; --sans: 'Syne', sans-serif; --serif: 'Playfair Display', serif;
      }
      html, body { background: var(--bg); color: var(--text); font-family: var(--sans); overflow: hidden; height: 100vh; width: 100vw; }
      ::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 3px; }
      .noise { position: fixed; inset: 0; pointer-events: none; opacity: .03; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); background-size: 180px; }
      
      /* ── SETUP ── */
      .setup { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; overflow-y:auto; padding:28px; gap:28px; }
      .setup-eyebrow { font-family:var(--mono); font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--blue); display:flex; align-items:center; gap:8px; }
      .setup-eyebrow::before,.setup-eyebrow::after { content:''; flex:1; height:1px; background:linear-gradient(90deg,transparent,var(--blue)33); }
      .setup-title { font-family:var(--serif); font-size:clamp(32px,5vw,52px); font-weight:700; text-align:center; line-height:1.1; }
      .setup-sub { font-family:var(--mono); font-size:11px; color:var(--text2); letter-spacing:.06em; text-align:center; }
      .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; width:100%; max-width:900px; }
      @media(max-width:640px){.grid2{grid-template-columns:1fr;}}
      .card { background:var(--bg2); border:1px solid var(--line); border-radius:16px; padding:22px; display:flex; flex-direction:column; gap:12px; }
      .card-label { font-family:var(--mono); font-size:9px; letter-spacing:.18em; text-transform:uppercase; color:var(--text3); }
      .drop { border:1.5px dashed var(--line2); border-radius:10px; padding:28px 20px; display:flex; flex-direction:column; align-items:center; gap:10px; cursor:pointer; transition:.2s; text-align:center; }
      .drop:hover { border-color:var(--blue); background:rgba(59,123,255,.04); }
      .drop-icon { width:40px; height:40px; border-radius:10px; background:rgba(59,123,255,.1); display:flex; align-items:center; justify-content:center; color:var(--blue); font-size:18px; }
      .cv-ok { display:flex; align-items:center; gap:10px; background:rgba(34,197,94,.07); border:1px solid rgba(34,197,94,.2); border-radius:9px; padding:10px 14px; }
      .textarea { width:100%; background:#040709; border:1px solid var(--line); border-radius:9px; padding:12px 14px; color:var(--text); font-family:var(--sans); font-size:12px; resize:vertical; min-height:150px; line-height:1.6; outline:none; }
      .textarea:focus { border-color:var(--blue); }
      .input { width:100%; background:#040709; border:1px solid var(--line); border-radius:9px; padding:10px 14px; color:var(--text); font-family:var(--sans); font-size:13px; outline:none; }
      .input:focus { border-color:var(--blue); }
      .err { display:flex; align-items:center; gap:8px; background:rgba(239,68,68,.08); border:1px solid rgba(239,68,68,.25); border-radius:9px; padding:10px 14px; font-size:12px; color:#f87171; width:100%; max-width:900px; }
      .start-btn { display:flex; align-items:center; justify-content:center; gap:10px; width:100%; max-width:900px; padding:16px; border-radius:13px; background:linear-gradient(135deg,#1d4ed8,#4f46e5); border:none; cursor:pointer; color:white; font-family:var(--sans); font-size:15px; font-weight:700; transition:.25s; }
      .start-btn:disabled { opacity:.4; cursor:not-allowed; }
      .start-btn:not(:disabled):hover { transform:translateY(-1px); box-shadow:0 8px 24px rgba(59,123,255,.3); }
      .tab-row { display:flex; gap:4px; background:rgba(0,0,0,.2); border:1px solid var(--line); border-radius:10px; padding:4px; }
      .tab-btn { flex:1; border:none; padding:7px; border-radius:7px; font-family:var(--mono); font-size:10px; font-weight:600; cursor:pointer; transition:.2s; }
      .tab-btn.on { background:var(--blue); color:white; } .tab-btn:not(.on) { background:transparent; color:var(--text3); }
      .template-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:6px; max-height:220px; overflow-y:auto; }
      .template-card { padding:9px 12px; background:rgba(255,255,255,.02); border:1px solid var(--line); border-radius:8px; cursor:pointer; transition:.2s; }
      .template-card:hover,.template-card.on { border-color:var(--blue); background:rgba(59,123,255,.06); }
      .template-name { font-size:11px; font-weight:700; display:flex; align-items:center; gap:5px; }
      .template-role { font-size:9px; color:var(--text3); margin-top:2px; }
      .seg-row { display:flex; gap:6px; }
      .seg-btn { flex:1; padding:8px 0; border-radius:8px; cursor:pointer; transition:.2s; font-family:var(--mono); font-size:11px; font-weight:600; border:1px solid var(--line); }
      .seg-btn.on { background:var(--blue); border-color:var(--blue); color:white; } .seg-btn:not(.on) { background:var(--bg3); color:var(--text2); }
      .tags-row { display:flex; flex-wrap:wrap; gap:7px; justify-content:center; max-width:900px; }
      .feature-tag { font-family:var(--mono); font-size:9px; background:rgba(255,255,255,.03); border:1px solid var(--line); border-radius:6px; padding:4px 10px; }

      /* ── CONNECTING ── */
      .connecting { display:flex; align-items:center; justify-content:center; height:100vh; }
      .conn-ring { width:80px; height:80px; border-radius:50%; background:linear-gradient(135deg,#1d4ed8,#4f46e5); display:flex; align-items:center; justify-content:center; animation:pulseRing 1.8s ease-in-out infinite; font-size:28px; }
      @keyframes pulseRing{0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,.5)}50%{box-shadow:0 0 0 20px rgba(99,102,241,0)}}
      
      /* ── LIVE ── */
      .live { display:grid; grid-template-columns:280px 1fr 300px; height:100vh; overflow:hidden; }
      @media(max-width:1100px){.live{grid-template-columns:260px 1fr;}.live-right{display:none;}}
      .live-left { border-right:1px solid var(--line); background:var(--bg2); display:flex; flex-direction:column; height:100vh; overflow:hidden; }
      .live-center { display:flex; flex-direction:column; overflow:hidden; }
      .live-right { border-left:1px solid var(--line); background:var(--bg2); overflow-y:auto; }
      .agent-top { padding:20px 16px 16px; border-bottom:1px solid var(--line); display:flex; flex-direction:column; align-items:center; gap:10px; flex-shrink:0; }
      .avatar { width:64px; height:64px; border-radius:50%; background:linear-gradient(135deg,#1a2b5e,#111e42); border:2px solid var(--line2); display:flex; align-items:center; justify-content:center; font-size:26px; transition:.4s; }
      .avatar.speaking { box-shadow:0 0 0 4px rgba(59,123,255,.3),0 0 20px rgba(59,123,255,.15); }
      .status-pill { display:flex; align-items:center; gap:7px; padding:5px 12px; border-radius:100px; font-family:var(--mono); font-size:10px; width:100%; justify-content:center; }
      .wave { display:flex; align-items:flex-end; gap:2px; height:26px; }
      .wbar { width:3px; border-radius:2px; transition:height .1s; }
      .controls { padding:12px; border-top:1px solid var(--line); display:flex; gap:8px; flex-shrink:0; background:var(--bg2); }
      .btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; border:none; cursor:pointer; border-radius:9px; font-family:var(--sans); font-weight:600; font-size:12px; padding:10px 14px; }
      .btn-mute { background:rgba(255,255,255,.05); color:var(--text2); border:1px solid var(--line); flex:1; }
      .btn-end { background:rgba(239,68,68,.1); color:#f87171; border:1px solid rgba(239,68,68,.2); flex:2; }
      .phase-strip { padding:10px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; }
      .phase-flow { display:flex; align-items:center; gap:10px; }
      .phase-sep { width:18px; height:1px; background:var(--line2); }
      .center-head { padding:12px 20px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
      .center-body { flex:1; overflow-y:auto; padding:18px; display:flex; flex-direction:column; gap:12px; position:relative; }
      .log-entry { display:flex; gap:10px; align-items:flex-start; }
      .log-av { width:28px; height:28px; border-radius:7px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-family:var(--mono); font-size:9px; font-weight:700; }
      .log-av.ai { background:rgba(59,123,255,.1); color:var(--blue); border:1px solid rgba(59,123,255,.2); }
      .log-av.user { background:rgba(34,197,94,.1); color:#22c55e; border:1px solid rgba(34,197,94,.2); }
      .log-text { font-size:12px; line-height:1.6; flex:1; }
      .intel-box { margin:8px; border:1px solid var(--line); border-radius:10px; overflow:hidden; flex-shrink:0; }
      .intel-hd { padding:7px 12px; background:rgba(255,255,255,.02); border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
      .intel-row { padding:7px 12px; display:flex; align-items:center; gap:8px; border-bottom:1px solid rgba(255,255,255,.03); }
      .score-card { margin:10px; border:1px solid var(--line); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:6px; }
      .metric-pill { font-family:var(--mono); font-size:8px; padding:2px 6px; border-radius:4px; background:rgba(255,255,255,.03); border:1px solid var(--line); color:var(--text3); text-transform:uppercase; }
      
      /* ── REPORT ── */
      .report-wrap { height:100vh; display:flex; align-items:center; justify-content:center; padding:28px; }
      .report { width:100%; max-width:860px; max-height:90vh; background:var(--bg2); border:1px solid var(--line); border-radius:20px; overflow:hidden; display:flex; flex-direction:column; }
      .report-hero { padding:36px; background:linear-gradient(135deg,#08101f,#110e2b); border-bottom:1px solid var(--line); text-align:center; }
      .report-avg { font-family:var(--serif); font-size:60px; font-weight:700; }
      .report-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); }
      .rstat { background:var(--bg2); padding:16px; } .rstat-val { font-family:var(--serif); font-size:26px; font-weight:700; } .rstat-lbl { font-family:var(--mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text3); }
      .answers-section { padding:16px; display:flex; flex-direction:column; gap:10px; overflow-y:auto; flex:1; }
      .answer-item { border:1px solid var(--line); border-radius:10px; padding:13px; display:flex; flex-direction:column; gap:7px; }
      .restart-btn { background:linear-gradient(135deg,#1d4ed8,#4f46e5); color:white; padding:12px 32px; border-radius:10px; font-family:var(--sans); font-size:14px; font-weight:700; border:none; cursor:pointer; }
      
      .fade { animation:fadeUp .35s ease forwards; }
      @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      .spinner { width:14px; height:14px; border-radius:50%; border:2px solid rgba(255,255,255,.2); border-top-color:white; animation:spin .8s linear infinite; }
      @keyframes spin{to{transform:rotate(360deg)}}
      .dot-pulse { width:6px; height:6px; border-radius:50%; animation:dotPulse 1.4s infinite; }
      @keyframes dotPulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}

      .arch-tag { display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:8px; padding:3px 8px; border-radius:5px; font-weight:700; letter-spacing:.05em; }
      .silence-bar { height:2px; background:var(--line); border-radius:1px; overflow:hidden; }
      .silence-fill { height:100%; transition:width .1s linear, background .3s; border-radius:1px; }
    `;

  // ── RENDER: Setup ──────────────────────────────────────────────────────────
  if (phase === 'setup') return (
    <>
      <style>{CSS}</style>
      <div className="noise" />
      <div className="setup">
        <div className="fade" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div className="setup-eyebrow">Aria v5 · RT-Brain Architecture</div>
          <h1 className="setup-title">Interview intelligence,<br /><em>finally autonomous.</em></h1>
          <p className="setup-sub">RT drives the conversation. Observer only scores & transitions.</p>
        </div>

        <div className="grid2 fade">
          {/* CV Card */}
          <div className="card">
            <div className="card-label">Candidate CV</div>
            {!cvText ? (
              <>
                <div className="drop" onClick={() => { const i = document.createElement('input'); i.type = 'file'; i.onchange = (e: any) => handleCvFile(e.target.files[0]); i.click(); }}>
                  <div className="drop-icon">{isParsing ? <div className="spinner" /> : '📄'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text2)' }}>{isParsing ? 'Parsing CV...' : 'Upload PDF or text file'}</div>
                </div>
                <textarea className="textarea" placeholder="Or paste CV text here..." value={cvText} onChange={e => setCvText(e.target.value)} />
              </>
            ) : (
              <>
                <div className="cv-ok">
                  <span style={{ fontSize: 16 }}>✅</span>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#22c55e' }}>{cvFileName || 'CV loaded'}</div>
                </div>
                <button className="btn btn-mute" onClick={() => { setCvText(''); setCvFileName(''); }}>Remove CV</button>
              </>
            )}
          </div>

          {/* JD Card */}
          <div className="card">
            <div className="card-label">Job Description</div>
            <div className="tab-row">
              <button className={`tab-btn ${jdTab === 'manual' ? 'on' : ''}`} onClick={() => setJdTab('manual')}>Manual Input</button>
              <button className={`tab-btn ${jdTab === 'templates' ? 'on' : ''}`} onClick={() => setJdTab('templates')}>Templates</button>
            </div>
            {jdTab === 'manual' ? (
              <textarea className="textarea fade" placeholder="Paste Job Description here..." style={{ minHeight: 180 }} value={jdText} onChange={e => setJdText(e.target.value)} />
            ) : (
              <div className="template-grid fade">
                {Object.entries(JD_TEMPLATES).map(([key, value]) => {
                  const icons: any = { frontend: '⚛️', backend: '⚙️', fullstack: '⚡', ai: '🧠', devops: '☁️', mobile: '📱', qa: '🧪' };
                  const names: any = { frontend: 'Frontend', backend: 'Backend', fullstack: 'Fullstack', ai: 'AI/ML', devops: 'DevOps', mobile: 'Mobile', qa: 'QA/SDET' };
                  return (
                    <div key={key} className={`template-card ${jdText === value ? 'on' : ''}`} onClick={() => { setJdText(value); setJdTab('manual'); }}>
                      <div className="template-name"><span>{icons[key]}</span>{names[key]}</div>
                      <div className="template-role">{value.split('\n')[1]?.replace('Focus: ', '')}</div>
                    </div>
                  );
                })}
              </div>
            )}
            <input className="input" placeholder="Candidate Name (auto-detected from CV)" value={candidateName} onChange={e => setCandidateName(e.target.value)} />

            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div className="card-label" style={{ marginBottom: 8 }}>Questions</div>
                <div className="seg-row">
                  {[3, 5, 8, 10].map(n => (
                    <button key={n} className={`seg-btn ${numQuestions === n ? 'on' : ''}`} onClick={() => setNumQuestions(n)}>{n}</button>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div className="card-label" style={{ marginBottom: 8 }}>Duration</div>
                <div className="seg-row">
                  {[5, 10, 15, 20].map(m => (
                    <button key={m} className={`seg-btn ${interviewDuration === m ? 'on' : ''}`} onClick={() => setInterviewDuration(m)}>{m}m</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="tags-row fade">
          <div className="feature-tag" style={{ color: '#60a5fa' }}>RT = Autonomous Brain</div>
          <div className="feature-tag" style={{ color: '#22c55e' }}>Observer = Score + Phase Only</div>
          <div className="feature-tag" style={{ color: '#c084fc' }}>Strategy Injected Once</div>
          <div className="feature-tag" style={{ color: '#f59e0b' }}>50% CV · 50% JD Questions</div>
          <div className="feature-tag" style={{ color: '#38bdf8' }}>20-Message Context</div>
        </div>

        {setupErr && <div className="err fade">⚠️ {setupErr}</div>}
        <button className="start-btn fade" disabled={isParsing || (!cvText && !jdText)} onClick={() => { setSetupErr(''); startCall(); }}>
          {isParsing ? <><div className="spinner" /> Processing...</> : 'Start Interview with Aria v5'}
        </button>
      </div>
    </>
  );

  // ── RENDER: Switching Logic ───────────────────────────────────────────────
  if (useFriendlyUI) {
    return (
      <FriendlyUI
        phase={phase}
        setPhase={setPhase}
        candidateName={candidateName}
        setCandidateName={setCandidateName}
        cvText={cvText}
        setCvText={setCvText}
        jdText={jdText}
        setJdText={setJdText}
        cvFileName={cvFileName}
        isParsing={isParsing}
        setupErr={setupErr}
        numQuestions={numQuestions}
        setNumQuestions={setNumQuestions}
        interviewDuration={interviewDuration}
        setInterviewDuration={setInterviewDuration}
        isCallActive={isCallActive}
        callStatus={callStatus}
        isMuted={isMuted}
        micLevel={micLevel}
        duration={duration}
        isCallEnded={isCallEnded}
        logs={logs}
        scores={scores}
        currentTopic={currentTopic}
        interviewTimeLeft={interviewTimeLeft}
        behavior={behavior}
        usage={usage}
        historySummary={historySummary}
        strategy={strategy}
        observerStatus={observerStatus}
        silenceTimeLeft={silenceTimeLeft}
        silenceDuration={silenceDurationRef.current}
        warmupTurns={warmupTurns}
        WARMUP_TURNS_REQUIRED={WARMUP_TURNS_REQUIRED}
        handleCvFile={handleCvFile}
        startCall={startCall}
        toggleMute={toggleMute}
        endCall={endCall}
        computeVoiceCost={computeVoiceCost}
        computeIntelCost={computeIntelCost}
        ScoreBadge={ScoreBadge}
        fmtTime={fmtTime}
        PhaseDot={PhaseDot}
        useFriendlyUI={useFriendlyUI}
        setUseFriendlyUI={setUseFriendlyUI}
      />
    );
  }

  // ── RENDER: Connecting ────────────────────────────────────────────────────
  if (phase === 'connecting') return (
    <>
      <style>{CSS}</style>
      <div className="noise" />
      <div className="connecting">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, textAlign: 'center' }} className="fade">
          <div className="conn-ring">🎙️</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Initializing Aria v5</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', fontFamily: 'var(--mono)' }}>Pre-processing CV · Building RT brain prompt</div>
          </div>
        </div>
      </div>
    </>
  );

  // ── RENDER: Report ────────────────────────────────────────────────────────
  if (phase === 'report') return (
    <>
      <style>{CSS}</style>
      <div className="noise" />
      <div className="report-wrap">
        <div className="report fade">
          <div className="report-hero">
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', marginBottom: 8, letterSpacing: '.1em' }}>INTERVIEW COMPLETE</div>
            {avgScore > 0 && <div className="report-avg" style={{ color: scoreColor(avgScore) }}>{avgScore.toFixed(1)}</div>}
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>Average Score · {scores.length} Questions Evaluated</div>
          </div>
          <div className="report-stats">
            <div className="rstat"><div className="rstat-val">{scores.length}</div><div className="rstat-lbl">Answers</div></div>
            <div className="rstat"><div className="rstat-val">{behavior.softSkills}/10</div><div className="rstat-lbl">Soft Skills</div></div>
            <div className="rstat"><div className="rstat-val" style={{ fontSize: 16, fontWeight: 800 }}>{behavior.style.toUpperCase()}</div><div className="rstat-lbl">Style</div></div>
            <div className="rstat"><div className="rstat-val">${(computeVoiceCost(usage) + computeIntelCost(usage)).toFixed(4)}</div><div className="rstat-lbl">Total Cost</div></div>
          </div>
          <div className="answers-section">
            <div style={{ padding: '12px 20px', background: 'rgba(59,123,255,.05)', borderRadius: 12, border: '1px solid var(--line)', marginBottom: 15 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--blue)', marginBottom: 4, letterSpacing: '.1em' }}>BEHAVIORAL AUDIT</div>
              <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6 }}>
                The candidate demonstrated a <strong>{behavior.style}</strong> communication style throughout the session.
                Soft skills were evaluated at <strong>{behavior.softSkills}/10</strong> with a clarity score of <strong>{behavior.communication}/10</strong>.
                Aria adapted her demeanor to <strong>{behavior.moodScore < 35 ? 'Encouraging' : behavior.moodScore > 65 ? 'Strict Pressure' : 'Balanced/Neutral'}</strong> mode to extract optimal technical depth.
              </div>
            </div>
            {scores.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text3)', padding: 20 }}>No answers recorded.</div>
            ) : scores.map((s, i) => (
              <div className="answer-item" key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{s.questionSummary || s.question}</div>
                  <ScoreBadge score={s.score} />
                </div>
                {s.topic && <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase' }}>{s.topic}</div>}
                <div style={{ fontSize: 11, color: 'var(--text2)', borderLeft: '2px solid var(--line)', paddingLeft: 8 }}>{s.answerSummary}</div>
                {s.logicEvaluation && <div style={{ fontSize: 10, color: 'var(--text3)' }}><strong>Logic:</strong> {s.logicEvaluation}</div>}
                {s.missedOpportunities && s.missedOpportunities.length > 0 && (
                  <div style={{ padding: '6px 10px', background: 'var(--bg3)', borderRadius: 6 }}>
                    <div style={{ fontSize: 8, color: 'var(--amber)', fontWeight: 800, marginBottom: 4 }}>MISSED OPPORTUNITIES</div>
                    {s.missedOpportunities.map((o, idx) => <div key={idx} style={{ fontSize: 9, color: 'var(--text2)', display: 'flex', gap: 5 }}><span style={{ color: 'var(--amber)' }}>•</span>{o}</div>)}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                  {s.confidence && <span className="metric-pill">Conf: {s.confidence}</span>}
                  {s.grammar && <span className="metric-pill">Grammar: {s.grammar}</span>}
                  {s.clarity && <span className="metric-pill">Clarity: {s.clarity}</span>}
                  {s.depthStr && <span className="metric-pill">Depth: {s.depthStr}</span>}
                  {s.technicalAccuracy && <span className="metric-pill" style={{ color: 'var(--amber)' }}>Accuracy: {s.technicalAccuracy}/10</span>}
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: 20, textAlign: 'center', borderTop: '1px solid var(--line)' }}>
            <button className="restart-btn" onClick={() => window.location.reload()}>Start New Interview</button>
          </div>
        </div>
      </div>
    </>
  );

  // ── RENDER: Live Session ──────────────────────────────────────────────────
  if (useFriendlyUI) {
    return (
      <FriendlyUI
        phase={phase}
        setPhase={setPhase}
        candidateName={candidateName}
        setCandidateName={setCandidateName}
        cvText={cvText}
        setCvText={setCvText}
        jdText={jdText}
        setJdText={setJdText}
        cvFileName={cvFileName}
        isParsing={isParsing}
        setupErr={setupErr}
        numQuestions={numQuestions}
        setNumQuestions={setNumQuestions}
        interviewDuration={interviewDuration}
        setInterviewDuration={setInterviewDuration}
        isCallActive={isCallActive}
        callStatus={callStatus}
        isMuted={isMuted}
        micLevel={micLevel}
        duration={duration}
        isCallEnded={isCallEnded}
        logs={logs}
        scores={scores}
        currentTopic={currentTopic}
        interviewTimeLeft={interviewTimeLeft}
        behavior={behavior}
        usage={usage}
        historySummary={historySummary}
        strategy={strategy}
        observerStatus={observerStatus}
        silenceTimeLeft={silenceTimeLeft}
        silenceDuration={silenceDurationRef.current}
        warmupTurns={warmupTurns}
        WARMUP_TURNS_REQUIRED={WARMUP_TURNS_REQUIRED}
        handleCvFile={handleCvFile}
        startCall={startCall}
        toggleMute={toggleMute}
        endCall={endCall}
        computeVoiceCost={computeVoiceCost}
        computeIntelCost={computeIntelCost}
        ScoreBadge={ScoreBadge}
        fmtTime={fmtTime}
        PhaseDot={PhaseDot}
        useFriendlyUI={useFriendlyUI}
        setUseFriendlyUI={setUseFriendlyUI}
      />
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="noise" />
      <div className="live">

        {/* LEFT PANEL */}
        <div className="live-left">
          <div className="agent-top">
            <div className={`avatar ${isSpeaking ? 'speaking' : ''}`}>🎙️</div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 700 }}>Aria</div>
              <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>v5 · RT-BRAIN</div>
            </div>

            <div className="status-pill" style={{ background: isSpeaking ? 'rgba(59,123,255,.12)' : 'rgba(255,255,255,.04)', color: isSpeaking ? '#60a5fa' : 'var(--text2)' }}>
              {observerStatus === 'scoring' ? '⚡ Scoring...' : observerStatus === 'phasing' ? '🔄 Phase shift...' : callStatus}
            </div>

            {silenceTimeLeft !== null && !isSpeaking && (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                  <span>Silence</span><span>{(silenceTimeLeft / 1000).toFixed(1)}s</span>
                </div>
                <div className="silence-bar">
                  <div className="silence-fill" style={{ width: `${(silenceTimeLeft / silenceDurationRef.current) * 100}%`, background: silenceTimeLeft < 5000 ? 'var(--red)' : 'var(--blue)' }} />
                </div>
              </div>
            )}

            <div className="wave">
              {waveHeights.map((h, i) => <div key={i} className="wbar" style={{ height: h, background: isSpeaking ? 'var(--blue)' : 'var(--line2)' }} />)}
            </div>
          </div>

          {/* Architecture Display */}
          <div style={{ margin: '8px', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', flexShrink: 0 }}>
            <div style={{ padding: '7px 12px', background: 'rgba(255,255,255,.02)', borderBottom: '1px solid var(--line)', fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: '.1em' }}>ARCHITECTURE</div>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8, background: isSpeaking ? 'rgba(59,123,255,.04)' : 'transparent' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e66' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 600 }}>RT Actor (Brain)</div>
                <div style={{ fontSize: 9, color: 'var(--text3)' }}>Full conversational autonomy</div>
              </div>
              <span className="arch-tag" style={{ background: 'rgba(34,197,94,.1)', color: '#22c55e' }}>BRAIN</span>
            </div>
            <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, background: observerStatus !== 'idle' ? 'rgba(192,132,252,.04)' : 'transparent' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: observerStatus !== 'idle' ? '#c084fc' : 'var(--line2)', boxShadow: observerStatus !== 'idle' ? '0 0 8px #c084fc66' : 'none', transition: '.3s' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 600 }}>Observer (Enforcer)</div>
                <div style={{ fontSize: 9, color: 'var(--text3)' }}>Score + phase only</div>
              </div>
              <span className="arch-tag" style={{ background: 'rgba(192,132,252,.1)', color: '#c084fc' }}>
                {observerStatus === 'idle' ? 'IDLE' : observerStatus === 'scoring' ? 'SCORING' : 'PHASING'}
              </span>
            </div>

            {/* Behavioral Intelligence */}
            <div style={{ padding: '10px 12px', background: 'rgba(0,0,0,.1)', borderTop: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700 }}>BEHAVIORAL INTEL</div>
                <div style={{ fontSize: 9, color: behavior.moodScore < 40 ? 'var(--green)' : behavior.moodScore > 60 ? 'var(--red)' : 'var(--blue)', fontFamily: 'var(--mono)', fontWeight: 800 }}>
                  {observerStatus !== 'idle' ? 'ANALYZING...' : `ARIA: ${behavior.moodScore < 35 ? 'NICE' : behavior.moodScore > 65 ? 'STRICT' : 'NEUTRAL'}`}
                </div>
              </div>

              {/* Mood Meter */}
              <div style={{ height: 4, background: 'var(--line)', borderRadius: 2, marginBottom: 10, position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${behavior.moodScore}%`, background: `linear-gradient(90deg, #22c55e, #3b82f6 ${behavior.moodScore}%, transparent)`, transition: 'all 1s ease' }} />
                <div style={{ position: 'absolute', left: '35%', top: 0, height: '100%', width: 1, background: 'rgba(255,255,255,.1)' }} />
                <div style={{ position: 'absolute', left: '65%', top: 0, height: '100%', width: 1, background: 'rgba(255,255,255,.1)' }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <div className="card" style={{ padding: '5px 8px', gap: 2, background: 'rgba(255,255,255,.02)' }}>
                  <div style={{ fontSize: 7, color: 'var(--text3)' }}>STYLE</div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--cyan)' }}>{behavior.style.toUpperCase()}</div>
                </div>
                <div className="card" style={{ padding: '5px 8px', gap: 2, background: 'rgba(255,255,255,.02)' }}>
                  <div style={{ fontSize: 7, color: 'var(--text3)' }}>SOFT SKILLS</div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--amber)' }}>{behavior.softSkills}/10</div>
                </div>
              </div>
            </div>

            {/* Token Intel */}
            <div style={{ padding: '10px 12px', background: 'rgba(0,0,0,.15)', borderTop: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700 }}>RT TOKEN INTEL</div>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#22c55e', fontFamily: 'var(--mono)' }}>${computeVoiceCost(usage).toFixed(4)}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <div style={{ background: 'rgba(255,255,255,.02)', padding: '5px 8px', borderRadius: 4, border: '1px solid var(--line2)' }}>
                  <div style={{ fontSize: 7, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>INPUT AUDIO</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--cyan)' }}>{usage.rtAudioIn.toLocaleString()}</div>
                </div>
                <div style={{ background: 'rgba(255,255,255,.02)', padding: '5px 8px', borderRadius: 4, border: '1px solid var(--line2)' }}>
                  <div style={{ fontSize: 7, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>INPUT TEXT</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)' }}>{usage.rtTextIn.toLocaleString()}</div>
                </div>
                <div style={{ background: 'rgba(255,255,255,.02)', padding: '5px 8px', borderRadius: 4, border: '1px solid var(--line2)', gridColumn: 'span 2' }}>
                  <div style={{ fontSize: 7, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>OUTPUT AUDIO (REALTIME)</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--violet)' }}>{usage.rtAudioOut.toLocaleString()}</div>
                </div>
              </div>
            </div>

            {/* Context Memory */}
            {historySummary && (
              <div className="fade" style={{ padding: '10px 12px', background: 'rgba(59,123,255,.03)', borderTop: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <div className="dot-pulse" style={{ background: 'var(--blue)', width: 6, height: 6 }} />
                  <div style={{ fontSize: 9, color: 'var(--blue)', fontFamily: 'var(--mono)', fontWeight: 700 }}>CONTEXT MEMORY</div>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text2)', fontStyle: 'italic', lineHeight: 1.4, borderLeft: '1px solid var(--line2)', paddingLeft: 8 }}>
                  "{historySummary}"
                </div>
              </div>
            )}
          </div>

          {/* Strategy Display */}
          {strategy && (
            <div style={{ margin: '0 8px 8px', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', flexShrink: 0 }}>
              <div style={{ padding: '7px 12px', background: 'rgba(255,255,255,.02)', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: '.1em' }}>INTERVIEW STRATEGY</span>
                <span style={{ fontSize: 9, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>{scores.length}/{numQuestions} scored</span>
              </div>
              {strategy.topics.map((t, i) => (
                <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.03)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: t.source === 'cv' ? 'var(--cyan)' : 'var(--violet)', flexShrink: 0 }} />
                  <div style={{ flex: 1, fontSize: 10, color: 'var(--text2)' }}>{t.name}</div>
                  <span style={{ fontSize: 8, fontFamily: 'var(--mono)', color: t.source === 'cv' ? 'var(--cyan)' : 'var(--violet)', fontWeight: 700 }}>{t.source.toUpperCase()}</span>
                </div>
              ))}
            </div>
          )}

          {/* Intel Log */}
          {intelLog.length > 0 && (
            <div className="intel-box" style={{ flex: 1, overflowY: 'auto' }}>
              <div className="intel-hd"><span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>OBSERVER LOG</span></div>
              {intelLog.map(log => (
                <div key={log.id} className="intel-row">
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: log.status === 'done' ? 'var(--green)' : log.status === 'error' ? 'var(--red)' : 'var(--amber)', flexShrink: 0 }} />
                  <div style={{ fontSize: 10, color: log.status === 'error' ? 'var(--red)' : 'var(--text2)' }}>{log.message}</div>
                </div>
              ))}
            </div>
          )}

          <div className="controls">
            <button className="btn btn-mute" onClick={toggleMute}>{isMuted ? '🔇 Unmute' : '🎤 Mute'}</button>
            <button className="btn btn-end" onClick={endCall}>End Interview</button>
          </div>
        </div>

        {/* CENTER PANEL */}
        <div className="live-center">
          <div className="phase-strip">
            <div className="phase-flow">
              {(['warmup', 'interview', 'wrapup', 'closing'] as AppPhase[]).map((p, i) => (
                <Fragment key={p}>
                  {i > 0 && <div className="phase-sep" />}
                  <PhaseDot phase={p} current={phase} label={p.charAt(0).toUpperCase() + p.slice(1)} />
                </Fragment>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {phase === 'warmup' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg3)', border: '1px solid var(--line)', padding: '3px 10px', borderRadius: 6 }}>
                  <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>WARMUP</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>{warmupTurns}</span>
                  <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>/{WARMUP_TURNS_REQUIRED}</span>
                </div>
              )}
              {phase === 'interview' && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg3)', border: '1px solid var(--line)', padding: '3px 10px', borderRadius: 6 }}>
                    <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>SCORED</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>{scores.length}</span>
                    <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>/{numQuestions}</span>
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: timerColor }}>{fmtTime(interviewTimeLeft)}</div>
                </>
              )}
            </div>
          </div>

          <div className="center-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Live Session · {candidateName || 'Candidate'}</div>
              <button onClick={() => setUseFriendlyUI(true)} style={{ background: 'var(--blue)', color: 'white', border: 'none', padding: '2px 8px', borderRadius: 4, fontSize: 9, fontWeight: 700, cursor: 'pointer' }}>PREMIUM UI</button>
            </div>
            {avgScore > 0 && <div style={{ fontSize: 12, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>Avg: {avgScore.toFixed(1)}</div>}
          </div>

          <div className="center-body">
            {isCallEnded && (
              <div className="fade" style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'rgba(7,11,18,.92)', backdropFilter: 'blur(10px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 40, textAlign: 'center' }}>
                <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(34,197,94,.1)', border: '1px solid rgba(34,197,94,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>✅</div>
                <div>
                  <h2 style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 700, marginBottom: 8 }}>Interview Complete</h2>
                  <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.6 }}>Click below to view your detailed performance report.</p>
                </div>
                <button className="start-btn" style={{ maxWidth: 260 }} onClick={() => { phaseRef.current = 'report'; setPhase('report'); }}>View Report</button>
              </div>
            )}
            {activeLogs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                {isSpeaking ? '🎙️ Aria is speaking...' : 'Waiting to begin...'}
              </div>
            ) : activeLogs.slice(-16).map((log, i) => (
              <div key={log.id || i} className="log-entry fade">
                <div className={`log-av ${log.role}`}>{log.role === 'ai' ? 'AI' : 'You'}</div>
                <div className="log-text">{log.text || <span style={{ color: 'var(--text3)' }}>...</span>}</div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="live-right">
          <div style={{ padding: '18px 18px 10px', fontSize: 14, fontWeight: 600 }}>Live Scores</div>

          {lastScore && (
            <div className="score-card fade" style={{ borderColor: 'var(--amber)33', background: 'var(--amber)04' }}>
              <div style={{ fontSize: 9, color: 'var(--amber)', fontFamily: 'var(--mono)', fontWeight: 700 }}>LATEST</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{lastScore.questionSummary || lastScore.question}</div>
                <ScoreBadge score={lastScore.score} />
              </div>
              {lastScore.logicEvaluation && <div style={{ fontSize: 10, color: 'var(--text3)' }}>{lastScore.logicEvaluation}</div>}
              {lastScore.missedOpportunities && lastScore.missedOpportunities.length > 0 && (
                <div>
                  <div style={{ fontSize: 8, color: 'var(--amber)', fontWeight: 700, marginBottom: 3 }}>MISSED:</div>
                  {lastScore.missedOpportunities.slice(0, 2).map((o, idx) => <div key={idx} style={{ fontSize: 9, color: 'var(--text3)', display: 'flex', gap: 4 }}><span style={{ color: 'var(--amber)' }}>•</span>{o}</div>)}
                </div>
              )}
            </div>
          )}

          {scores.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Scores appear after each answer...</div>
          ) : [...scores].reverse().slice(0, 8).map((s, i) => (
            <div className="score-card" key={i}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text2)', flex: 1 }}>{(s.questionSummary || s.question).slice(0, 45)}...</div>
                <ScoreBadge score={s.score} />
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{s.answerSummary.slice(0, 70)}...</div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                {s.confidence && <span className="metric-pill">Conf: {s.confidence}</span>}
                {s.clarity && <span className="metric-pill">Clarity: {s.clarity}</span>}
                {s.topic && <span className="metric-pill" style={{ color: 'var(--cyan)' }}>{s.topic.slice(0, 15)}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}