'use client';

/**
 * Aria v4 — AI Interview System (Universal Domain Architecture)
 * Architecture: Asynchronous Sidecar (Actor-Observer Pattern)
 *
 * 1. The Actor (RT Voice Pipe):
 * - Zero tools, zero signal instructions. Purely conversational.
 * - Intelligent boundaries: instructed strictly NOT to hallucinate and to maintain natural flow.
 *
 * 2. The Specialized Observers (GPT-4o-mini REST):
 * - Constantly watches the transcript array asynchronously.
 * - SPLIT BY PHASE to reduce hallucination and enforce Phase-Specific Goals.
 * - Acts as an Intelligent "Punisher": Generating custom, context-aware corrections if the RT drifts.
 *
 * 3. The Injector:
 * - Pushes out-of-band `role: "system"` messages into the RT context silently.
 * - **AUTO-CLEANUP**: Deletes the previous system directive before adding a new one to prevent RT model confusion/stacking loops.
 */

import { useState, useEffect, useRef, useCallback, Fragment } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type AppPhase = 'setup' | 'connecting' | 'greeting' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'report';

type LogEntry = {
  id: string;
  role: 'user' | 'ai' | 'system';
  text: string;
  pending?: boolean;
  archived?: boolean;
};

type AnswerScore = {
  question: string;
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
  questionSummary?: string;
  missedOpportunities?: string[];
  logicEvaluation?: string;
};

type TopicDepth = {
  topic: string;
  level: number; // 1=Foundational, 2=Applied, 3=Complex
  answerCount: number;
  questions: string[];
  currentQIndex: number;
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
  type: 'observer' | 'score' | 'cv' | 'strategy' | 'gap' | 'notes' | 'bridge' | 'director';
  message: string;
  status: 'active' | 'done' | 'error';
  timestamp: number;
};

type InterviewStrategy = {
  topics: string[];
  questionQueue: Record<string, string[]>;
  gapAreas: string[];
};

type ObserverAnalysis = {
  is_filler_pause: boolean;
  is_substantive_answer: boolean;
  answer_summary: string;
  needs_cv_lookup: boolean;
  cv_topic: string;
  topic_exhausted: boolean;
  suggested_phase_advance: 'none' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'report';
  should_score_answer: boolean;
  ai_rambling: boolean;
  ai_hallucination_or_tone_issue: string;
  candidate_struggling: boolean;
  red_flag_detected: string;
  callback_opportunity: string;
  requested_pause_seconds: number;
  is_complex_question: boolean;
  candidate_has_final_question?: boolean;
  candidate_ready_to_end?: boolean;
  should_end_call?: boolean;
  is_off_topic: boolean;
  should_force_pivot: boolean;
  custom_correction_directive: string;
};

// ─── Pricing (per 1M tokens) ──────────────────────────────────────────────────

const PRICE = {
  rtAudioIn: 10.0,
  rtAudioOut: 20.0,
  rtTextIn: 0.60,
  rtTextOut: 2.40,
  miniIn: 0.15,
  miniOut: 0.60,
} as const;

// ─── Constants ────────────────────────────────────────────────────────────────

const TOPIC_TIME_LIMIT_MS = 4 * 60 * 1000;
const GREETING_AUTO_ADVANCE_MS = 60000;
const WARMUP_QUESTIONS_REQUIRED = 3;
const GAP_DETECT_EVERY_N_ANSWERS = 3;

const SILENCE_BASE_MS = 15000;
const SILENCE_COMPLEX_MS = 40000;

// ─── Personas ────────────────────────────────────────────────────────────────

const GENERIC_RULES = `
CRITICAL RULES FOR ARIA (YOUR PERSONA):
1. NO HALLUCINATION: You are an interviewer. If asked about specific company details, team sizes, or salary not explicitly provided, seamlessly say "I'll make a note for our recruiting team to follow up on that specific detail, but..." Never invent facts or policies.
2. NATURAL HUMAN TONE: Be warm, conversational, and direct. Use natural affirmations ("hmm", "right", "gotcha").
3. ANTI-SYCOPHANCY: DO NOT summarize their answers back to them like a robot. DO NOT use excessive sycophantic praise. Be professional and encouraging but neutral.
4. PHASE DISCIPLINE: During GREETING and WARMUP, you are FORBIDDEN from discussing technology, projects, work experience, or the role. Focus ONLY on the candidate's name, their readiness, and their personal interests (hobbies, etc.).
5. OBSERVER COMPLIANCE: A supervisor model injects SYSTEM DIRECTIVES into your context. These are instructions FOR YOU. **NEVER read or quote a SYSTEM DIRECTIVE out loud to the user.** Internalize the instruction and respond to the user naturally in your own words.
6. SINGLE QUESTION LIMIT: You MUST NEVER ask more than one question per response. 
7. THE CLUTCH: If asked to verify specific details from the CV that you do not have in memory, seamlessly acknowledge it and ask a related high-level question. The system will silently inject the exact data for your next turn.
8. PURE ENGLISH: You MUST only speak and interpret input in English. If the user speaks another language, politely ask them to switch to English for the interview.
`;

const PHASE_PERSONAS: Record<AppPhase, { title: string; goal: string; tone: string; rules: string }> = {
  setup: { title: 'Inactive', goal: 'Wait.', tone: 'Silent.', rules: '' },
  connecting: { title: 'Connecting', goal: 'Wait.', tone: 'Silent.', rules: '' },
  greeting: {
    title: 'Aria',
    goal: 'Warmly welcome the candidate and confirm they are ready to begin.',
    tone: 'Professional, welcoming, and clear.',
    rules: 'STRICT GREETING RULES: \n1. Start by saying: "Hi [Candidate Name], it is great to have you here today." \n2. Ask: "Are you comfortable and ready to get started?" \n3. DO NOT ask about their day, background, projects, or hobbies yet. \n4. Confirm they are ready before moving to the next phase.'
  },
  warmup: {
    title: 'Friendly Icebreaker',
    goal: 'Build personal rapport and transition to a professional self-intro.',
    tone: 'Casual, warm, and personally interested.',
    rules: 'STRICT WARMUP RULES: \n1. Focus your first 2 questions STRICTLY on hobbies, passions, or life outside of work. \n2. ZERO mention of tech stack, job JD, or specific projects yet. \n3. COMPULSORY TRANSITION: On your 3rd warmup turn, pivot naturally by saying something like "It sounds like you have a lot going on outside of work! Before we dive into the technicalities, why don\'t you tell me a bit about yourself and your journey so far?"'
  },
  interview: {
    title: 'Senior Technical Lead',
    goal: 'Evaluate technical depth and domain expertise.',
    tone: 'Inquisitive, sharp, and professional. High-bar but respectful.',
    rules: 'Ask deep-dive questions based on the JD and CV. Use injected directives to steer. Listen for "how" and "why".'
  },
  wrapup: {
    title: 'Company Ambassador',
    goal: 'Answer the candidate\'s questions and provide role context.',
    tone: 'Welcoming, transparent, and prideful of the company.',
    rules: 'The evaluation is over. Shift to answering THEIR questions. If they have none, ask what they look for in a team culture. NO MORE technical probing.'
  },
  closing: {
    title: 'Aria',
    goal: 'Graceful Host',
    tone: 'Warm, appreciative, and clear.',
    rules: 'Provide a final farewell. Do not start new topics. Wish them a great day.'
  },
  report: { title: 'Ghost', goal: 'Silent.', tone: 'Silent.', rules: '' },
};

const JD_TEMPLATES = {
  frontend: `Role: Senior Frontend Engineer
Focus: React.js, TypeScript, Next.js, CSS Architecture, Performance Optimization.
JD: Build modular, high-performance UIs. Deep understanding of React hooks, state management, and accessibility is foundational.`,
  backend: `Role: Senior Backend Engineer
Focus: Node.js, Go, Microservices, PostgreSQL, System Design, Scalability.
JD: Design robust APIs and distributed systems. Focus on performance, data integrity, and throughput.`,
  fullstack: `Role: Senior Fullstack Developer
Focus: Next.js, TRPC, Prisma, PostgreSQL, React, Tailwind CSS.
JD: Build end-to-end features using the T3 stack. Focus on clean architecture, type safety, and seamless UI/UX.`,
  ai: `Role: AI/ML Engineer (LLMs)
Focus: Python, PyTorch, LangChain, Transformers, Vector DBs (Pinecone/Milvus), RAG.
JD: Develop and optimize LLM-based applications. Focus on prompt engineering, fine-tuning, and scalable inference pipelines.`,
  devops: `Role: DevOps/SRE Engineer
Focus: AWS, Kubernetes, Terraform, Docker, CI/CD, Observability (Prometheus/Grafana).
JD: Manage scalable cloud infrastructure. Focus on automation, reliability, and security of distributed systems.`,
  mobile: `Role: Senior Mobile Developer
Focus: React Native, Swift, Kotlin, Performance, App Store/Play Store deployment.
JD: Build high-quality cross-platform applications. Focus on smooth animations, offline-first logic, and platform-specific optimizations.`,
  qa: `Role: SDET / QA Engineer
Focus: Playwright, Cypress, Jest, Integration Testing, Performance Testing.
JD: Build robust automated testing suites. Focus on end-to-end testing, CI integration, and high-quality software delivery.`,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function computeCost(u: Usage): number {
  return (
    u.rtTextIn * PRICE.rtTextIn +
    u.rtAudioIn * PRICE.rtAudioIn +
    u.rtTextOut * PRICE.rtTextOut +
    u.rtAudioOut * PRICE.rtAudioOut +
    u.miniPrompt * PRICE.miniIn +
    u.miniCompletion * PRICE.miniOut
  ) / 1_000_000;
}

function computeVoiceCost(u: Usage): number {
  return (
    u.rtTextIn * PRICE.rtTextIn +
    u.rtAudioIn * PRICE.rtAudioIn +
    u.rtTextOut * PRICE.rtTextOut +
    u.rtAudioOut * PRICE.rtAudioOut
  ) / 1_000_000;
}

function computeIntelCost(u: Usage): number {
  return (
    u.miniPrompt * PRICE.miniIn +
    u.miniCompletion * PRICE.miniOut
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
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: color + '1a', color, border: `1px solid ${color}40`,
      borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 700,
      whiteSpace: 'nowrap', fontFamily: 'var(--mono)',
    }}>
      {score}/10 · {label}
    </span>
  );
}

function DepthBadge({ level }: { level: number }) {
  const [color, label] =
    level >= 3 ? ['#c084fc', 'Complex'] :
      level >= 2 ? ['#38bdf8', 'Applied'] :
        ['#94a3b8', 'Foundation'];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      background: color + '18', color, border: `1px solid ${color}33`,
      borderRadius: 4, padding: '1px 6px', fontSize: 9, fontWeight: 600,
      fontFamily: 'var(--mono)',
    }}>
      {'▸'.repeat(level)} {label}
    </span>
  );
}

function PhaseDot({ phase, current, label, sub }: { phase: AppPhase; current: AppPhase; label: string; sub?: string }) {
  const phases: AppPhase[] = ['greeting', 'warmup', 'interview', 'wrapup', 'closing', 'report'];
  const ci = phases.indexOf(current);
  const pi = phases.indexOf(phase);
  const done = ci > pi;
  const active = ci === pi;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <div style={{
        width: 8, height: 8, borderRadius: '50%',
        background: active ? '#3b82f6' : done ? '#22c55e' : 'var(--line2)',
        boxShadow: active ? '0 0 8px #3b82f6' : done ? '0 0 6px #22c55e66' : 'none',
        transition: 'all .4s',
      }} />
      <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: active ? '#3b82f6' : done ? '#22c55e' : 'var(--text3)', letterSpacing: '.08em' }}>{label}</span>
      {sub && active && <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--text3)' }}>{sub}</span>}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AriaV4() {

  // ── Setup State ──────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<AppPhase>('setup');
  const [cvText, setCvText] = useState('');
  const [jdText, setJdText] = useState('');
  const [candidateName, setCandidateName] = useState('');
  const [cvFileName, setCvFileName] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [setupErr, setSetupErr] = useState('');

  // ── Live State ───────────────────────────────────────────────────────────
  const [isCallActive, setIsCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState('Ready');
  const [isMuted, setIsMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [duration, setDuration] = useState(0);
  const [liveCost, setLiveCost] = useState(0);
  const [isCallEnded, setIsCallEnded] = useState(false);

  // ── Interview State ──────────────────────────────────────────────────────
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scores, setScores] = useState<AnswerScore[]>([]);
  const [topicsCovered, setTopicsCovered] = useState<string[]>([]);
  const [questionCount, setQuestionCount] = useState(0);
  const [numQuestions, setNumQuestions] = useState(5);
  const [interviewDuration, setInterviewDuration] = useState(10);
  const [currentQ, setCurrentQ] = useState('');
  const [cvSummary, setCvSummary] = useState('');

  const [greetingCount, setGreetingCount] = useState(0);
  const [warmupCount, setWarmupCount] = useState(0);
  const [wrapupCount, setWrapupCount] = useState(0);

  const [isBridging, setIsBridging] = useState(false);
  const [isCvLooking, setIsCvLooking] = useState(false);
  const [isCvAnalyzing, setIsCvAnalyzing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [interviewTimeLeft, setInterviewTimeLeft] = useState(600);
  const [currentTopicDisplay, setCurrentTopicDisplay] = useState('');
  const [currentDepth, setCurrentDepth] = useState(1);
  const [detectedGap, setDetectedGap] = useState('');
  const [strategyTopics, setStrategyTopics] = useState<string[]>([]);
  const [intelLog, setIntelLog] = useState<IntelLog[]>([]);
  const [jdTab, setJdTab] = useState<'manual' | 'templates'>('manual');
  const [lastObserverAnalysis, setLastObserverAnalysis] = useState<ObserverAnalysis | null>(null);
  const [silenceTimeLeft, setSilenceTimeLeft] = useState<number | null>(null);
  const [lastInjection, setLastInjection] = useState<string | null>(null);
  const [observerActivity, setObserverActivity] = useState<'idle' | 'scanning' | 'analyzing' | 'injecting'>('idle');
  const [isObserverActive, setIsObserverActive] = useState(false);
  const [driftCount, setDriftCount] = useState(0);
  const [silenceStrikes, setSilenceStrikes] = useState(0);
  const [usage, setUsage] = useState<Usage>({
    rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0, miniPrompt: 0, miniCompletion: 0,
  });

  // ── Refs ─────────────────────────────────────────────────────────────────
  const phaseRef = useRef<AppPhase>('setup');
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isEndingRef = useRef(false);
  const isStartingRef = useRef(false);

  const convHistoryRef = useRef<{ role: 'user' | 'assistant' | 'system'; content: string }[]>([]);
  const rtItemIdsRef = useRef<string[]>([]);
  const userTurnCountRef = useRef(0);
  const observerRunTurnRef = useRef(-1);
  const isObserverRunningRef = useRef(false);
  const lastAiQuestionRef = useRef('');
  const answerCountRef = useRef(0);

  const greetingCountRef = useRef(0);
  const warmupCountRef = useRef(0);
  const wrapupCountRef = useRef(0);

  const lastSystemItemIdRef = useRef<string | null>(null); // To clear old directives!

  const strategyRef = useRef<InterviewStrategy | null>(null);
  const topicDepthMapRef = useRef<Map<string, TopicDepth>>(new Map());
  const currentTopicRef = useRef('general');
  const topicStartTimeRef = useRef<number>(0);
  const warmupQueueRef = useRef<string[]>([]);
  const warmupQIndexRef = useRef(0);

  const cvTextRef = useRef('');
  const jdTextRef = useRef('');
  const cvSummaryRef = useRef('');
  const topicsCoveredRef = useRef<string[]>([]);
  const scoresRef = useRef<AnswerScore[]>([]);
  const candidateNameRef = useRef('');
  const cvLookupCacheRef = useRef<Map<string, string>>(new Map());

  const greetingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interviewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interviewStartTimeRef = useRef<number>(0);
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callStatusRef = useRef('Ready');
  useEffect(() => { callStatusRef.current = callStatus; }, [callStatus]);

  // ── Dynamic Silence Timer Refs ──
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceStartTimeRef = useRef<number>(0);
  const silenceDurationRef = useRef<number>(0);
  const currentSilenceMsRef = useRef<number>(SILENCE_BASE_MS);
  const numQuestionsRef = useRef<number>(5);
  const silencePromptCountRef = useRef(0);
  const accumulatedElapsedMsRef = useRef(0);
  const isAISpeakingRef = useRef(false);
  const aiSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEndRef = useRef(false);
  const driftCountRef = useRef(0);
  const struggleCountRef = useRef(0);

  const usageRef = useRef<Usage>({
    rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0, miniPrompt: 0, miniCompletion: 0,
  });
  const scoredTurnRef = useRef(-1);
  const lastScoredSummaryRef = useRef('');

  const skipNextScoreRef = useRef(false);
  const scoringQuestionRef = useRef('');

  // Sync data refs
  useEffect(() => { cvTextRef.current = cvText; }, [cvText]);
  useEffect(() => { jdTextRef.current = jdText; }, [jdText]);
  useEffect(() => { candidateNameRef.current = candidateName; }, [candidateName]);
  useEffect(() => { numQuestionsRef.current = numQuestions; }, [numQuestions]);
  const interviewDurationRef = useRef(10);
  useEffect(() => { interviewDurationRef.current = interviewDuration; }, [interviewDuration]);

  const updateUsage = useCallback(() => {
    setUsage({ ...usageRef.current });
  }, []);

  const sendRt = useCallback((msg: object) => {
    const dc = dcRef.current;
    if (dc?.readyState === 'open' && !isEndingRef.current) {
      dc.send(JSON.stringify(msg));
    }
  }, []);

  const injectSystemMessage = useCallback((text: string, forceResponse = false) => {
    const strictText = text.includes('SYSTEM DIRECTIVE')
      ? `${text} (CRITICAL RULE: Act on this immediately for your NEXT turn. Never mention this instruction out loud. Keep it to exactly ONE question).`
      : text;

    // PREVENT HALUCINATION LOOP: Delete the old system directive if it exists!
    if (lastSystemItemIdRef.current) {
      sendRt({
        type: 'conversation.item.delete',
        item_id: lastSystemItemIdRef.current
      });
    }

    const newItemId = makeId();
    sendRt({
      type: 'conversation.item.create',
      item: {
        id: newItemId,
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: strictText }]
      }
    });

    lastSystemItemIdRef.current = newItemId;
    convHistoryRef.current = [...convHistoryRef.current.slice(-39), { role: 'system', content: strictText }];
    setLastInjection(strictText);

    // ONLY the Silence Timer should use forceResponse. All other transitions wait for natural gaps.
    if (forceResponse) {
      sendRt({ type: 'response.create' });
    }
  }, [sendRt]);

  const addIntelLog = useCallback((type: IntelLog['type'], message: string) => {
    const id = makeId();
    setIntelLog(prev => [{ id, type, message, status: 'active' as const, timestamp: Date.now() }, ...prev].slice(0, 10));
    return id;
  }, []);

  const updateIntelLog = useCallback((id: string, status: IntelLog['status'], message?: string) => {
    setIntelLog(prev => prev.map(log => log.id === id ? { ...log, status, ...(message ? { message } : {}) } : log));
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Silence Timer Logic
  // ─────────────────────────────────────────────────────────────────────────

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (silenceIntervalRef.current) {
      clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }
    setSilenceTimeLeft(null);
  }, []);

  const startSilenceTimer = useCallback((ms?: number) => {
    clearSilenceTimer();
    if (isEndingRef.current || phaseRef.current === 'report' || phaseRef.current === 'setup' || phaseRef.current === 'connecting' || phaseRef.current === 'closing') return;

    const timeout = ms || currentSilenceMsRef.current;
    silenceStartTimeRef.current = Date.now();
    silenceDurationRef.current = timeout;
    setSilenceTimeLeft(timeout);

    silenceIntervalRef.current = setInterval(() => {
      if (isAISpeakingRef.current) silenceStartTimeRef.current = Date.now();
      const elapsed = Date.now() - silenceStartTimeRef.current;
      const remaining = Math.max(0, silenceDurationRef.current - elapsed);
      setSilenceTimeLeft(remaining);
      if (remaining <= 0 && silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
    }, 100);

    silenceTimerRef.current = setTimeout(() => {
      silencePromptCountRef.current++;
      setSilenceStrikes(silencePromptCountRef.current);

      if (silencePromptCountRef.current >= 3) {
        const d_tid = addIntelLog('director', 'Max silence limit reached. Terminating.');
        updateIntelLog(d_tid, 'error', 'Inactivity timeout ✓');
        endCall();
        return;
      }
      // FORCED RESPONSE ONLY FOR SILENCE
      injectSystemMessage(`SYSTEM DIRECTIVE: The user has been completely silent (Strike ${silencePromptCountRef.current}/3). Politely ask if they are still there or need more time.`, true);
      currentSilenceMsRef.current = SILENCE_BASE_MS;
      clearSilenceTimer();
    }, timeout);
  }, [clearSilenceTimer, injectSystemMessage]);


  // ─────────────────────────────────────────────────────────────────────────
  // Prompt Builder (The Intelligent Universal Actor)
  // ─────────────────────────────────────────────────────────────────────────

  const buildActorPrompt = useCallback((forPhase?: AppPhase): string => {
    const p = forPhase ?? phaseRef.current;
    const persona = PHASE_PERSONAS[p];
    const name = candidateNameRef.current || 'the candidate';
    const jd = jdTextRef.current;
    const cv = cvSummaryRef.current;

    return `YOU ARE ARIA.
CURRENT PERSONA: ${persona.title}
CURRENT PHASE: ${p.toUpperCase()}
GOAL: ${persona.goal}
TONE: ${persona.tone}

STRICT PHASE RULES:
${persona.rules}

─────────────────────────────────────────
CANDIDATE: ${name}
JOB CONTEXT: ${jd ? jd.split('\n')[0] : 'General Role'}
CV SUMMARY: ${cv || 'Loading...'}
─────────────────────────────────────────

${GENERIC_RULES}
`;
  }, []);

  const transitionPhase = useCallback((newPhase: AppPhase) => {
    if (isEndingRef.current) return;
    phaseRef.current = newPhase;
    setPhase(newPhase);

    if (newPhase === 'interview') {
      skipNextScoreRef.current = true;
    }

    sendRt({
      type: 'session.update',
      session: {
        instructions: `IMPORTANT: ONLY COMMUNICATE IN ENGLISH. \n\n` + buildActorPrompt(newPhase),
        input_audio_transcription: { model: 'whisper-1', language: 'en' }
      },
    });
  }, [sendRt, buildActorPrompt]);

  const endCall = useCallback(() => {
    if (isEndingRef.current) return;
    isEndingRef.current = true;

    clearSilenceTimer();
    if (greetingTimeoutRef.current) clearTimeout(greetingTimeoutRef.current);
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

  const startInterviewTimer = useCallback(() => {
    interviewStartTimeRef.current = Date.now();
    topicStartTimeRef.current = Date.now();
    if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);

    interviewTimerRef.current = setInterval(() => {
      if (isEndingRef.current) { clearInterval(interviewTimerRef.current!); return; }
      const totalMs = interviewDurationRef.current * 60 * 1000;

      if (callStatusRef.current !== 'Speaking...' && !isAISpeakingRef.current) {
        accumulatedElapsedMsRef.current += 1000;
      }

      const elapsed = accumulatedElapsedMsRef.current;
      const remaining = Math.max(0, totalMs - elapsed);
      setInterviewTimeLeft(Math.floor(remaining / 1000));

      const warningThreshold = totalMs * 0.8;
      if (elapsed >= warningThreshold && elapsed < warningThreshold + 1000) {
        injectSystemMessage('SYSTEM DIRECTIVE: We are reaching the end of our allotted time. Transition your current thought towards a wrap-up naturally.', false);
      }

      if (elapsed >= totalMs) {
        clearInterval(interviewTimerRef.current!);
        injectSystemMessage('SYSTEM DIRECTIVE: Time limit reached. Wrap up the interview conversation gracefully and ask if the candidate has any final questions.', false);
        transitionPhase('wrapup');
      }

      if (phaseRef.current === 'interview') {
        const topicElapsed = Date.now() - topicStartTimeRef.current;
        if (topicElapsed >= TOPIC_TIME_LIMIT_MS && !isBridging) {
          topicStartTimeRef.current = Date.now();
          const tid = addIntelLog('director', 'Topic time limit reached.');
          injectSystemMessage(`SYSTEM DIRECTIVE: Time is up for topic "${currentTopicRef.current}". On your next turn, wrap it up naturally and pivot to the next subject.`, false);
          updateIntelLog(tid, 'done', 'Time-box pivot injected ✓');
        }
      }
    }, 1000);
  }, [endCall, injectSystemMessage, transitionPhase, addIntelLog, updateIntelLog, isBridging]);


  // ─────────────────────────────────────────────────────────────────────────
  // 🧠 THE STRICT OBSERVER ENGINE (Counter Driven Progression)
  // ─────────────────────────────────────────────────────────────────────────

  const runObserverPipeline = useCallback(async () => {
    if (isObserverRunningRef.current || isEndingRef.current || phaseRef.current === 'connecting' || phaseRef.current === 'setup' || phaseRef.current === 'report') return;
    if (userTurnCountRef.current <= observerRunTurnRef.current) return;

    isObserverRunningRef.current = true;
    setIsObserverActive(true);
    setObserverActivity('scanning');

    const currentPhase = phaseRef.current;
    const tid = addIntelLog('observer', `[${currentPhase.toUpperCase()}] Observer scanning transcript...`);

    try {
      const recentHistory = convHistoryRef.current.slice(-10).map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n');
      const topicElapsedSeconds = Math.floor((Date.now() - topicStartTimeRef.current) / 1000);
      const topicScoreHistory = scoresRef.current
        .filter(s => s.topic === currentTopicRef.current)
        .map(s => `${s.score}/10`)
        .join(', ') || 'No scores yet';

      let prompt = '';
      let systemRole = `You are a strict, highly perceptive Observer/Punisher model. Monitor the interview transcript. Enforce the rules of the CURRENT PHASE rigidly.`;

      // ── PHASE: GREETING ──
      if (currentPhase === 'greeting') {
        prompt = `CURRENT PHASE: GREETING
GOAL: Audio check and basic welcome ONLY. Aria MUST NOT ask about the job, skills, or personal life.
TURN COUNT: ${greetingCountRef.current}/2

Transcript:
${recentHistory}

Task: Return JSON matching this schema exactly:
{
  "is_filler_pause": boolean,
  "is_substantive_answer": boolean, // TRUE if candidate confirms they can hear Aria or says they are ready to start.
  "answer_summary": "string",
  "is_off_topic": boolean, // TRUE if Aria asks about their background, skills, or projects too early. FALSE for professional welcomes.
  "should_force_pivot": boolean,
  "ai_rambling": boolean,
  "ai_hallucination_or_tone_issue": "string", 
  "candidate_struggling": boolean,
  "red_flag_detected": "string",
  "requested_pause_seconds": number,
  "custom_correction_directive": "string" // Universal command to fix Aria if she deviates (rambling, tone issues, technical loops, etc.).
}`;
      }
      // ── PHASE: WARMUP ──
      else if (currentPhase === 'warmup') {
        prompt = `CURRENT PHASE: WARMUP
GOAL: Personal rapport & Professional Intro transition.
TURN COUNT: ${warmupCountRef.current}/${WARMUP_QUESTIONS_REQUIRED}
NOTE: On the final turn (${WARMUP_QUESTIONS_REQUIRED}), it is EXPECTED that Aria asks the candidate to "tell me about yourself." This is not off-topic.

Transcript:
${recentHistory}

Task: Return JSON matching this schema exactly:
{
  "is_filler_pause": boolean, 
  "is_substantive_answer": boolean, // TRUE if candidate engaged with Aria's personal warmup question.
  "answer_summary": "string",
  "is_off_topic": boolean, // TRUE if Aria asks about the job/CV during warmup, or if candidate is completely unengaged.
  "should_force_pivot": boolean,
  "ai_rambling": boolean, 
  "ai_hallucination_or_tone_issue": "string", 
  "candidate_struggling": boolean,
  "red_flag_detected": "string",
  "requested_pause_seconds": number,
  "custom_correction_directive": "string" // Universal command to fix Aria if she deviates from the warmup goals.
}`;
      }
      // ── PHASE: INTERVIEW ──
      else if (currentPhase === 'interview') {
        prompt = `CURRENT PHASE: INTERVIEW
GOAL: Core domain evaluation based on Job Description.
STATE: 
Topic: ${currentTopicRef.current}
Topic Scores: [${topicScoreHistory}]
Scored Domain Answers: ${scoresRef.current.length} / ${numQuestionsRef.current}
Time on Topic: ${topicElapsedSeconds}s / ${TOPIC_TIME_LIMIT_MS / 1000}s max

Transcript:
${recentHistory}

Task: Return JSON matching this schema exactly:
{
  "is_filler_pause": boolean, 
  "is_substantive_answer": boolean, // TRUE if candidate provided ANY domain-related response (including "I don't know").
  "should_score_answer": boolean, // TRUE if answer contains ANY attempt at an answer (even a wrong one) so we can adjust difficulty.
  "answer_summary": "string", 
  "cv_topic": "string", 
  "needs_cv_lookup": boolean,
  "topic_exhausted": boolean, // TRUE if topic is covered OR if candidate has given 2+ low-substance/evasive/stuck answers on this topic.
  "candidate_ready_to_end": boolean,
  "is_off_topic": boolean, // TRUE if meta-talk cycle > 1 message.
  "should_force_pivot": boolean, 
  "ai_rambling": boolean, 
  "ai_hallucination_or_tone_issue": "string", 
  "candidate_struggling": boolean,
  "red_flag_detected": "string",
  "callback_opportunity": "string",
  "requested_pause_seconds": number,
  "is_complex_question": boolean,
  "custom_correction_directive": "string" // Universal command to fix Aria if she deviates (e.g., technical loops, rambling, or tone issues).
}`;
      }
      // ── PHASE: WRAPUP & CLOSING ──
      else if (currentPhase === 'wrapup' || currentPhase === 'closing') {
        prompt = `CURRENT PHASE: ${currentPhase.toUpperCase()}
GOAL: Housekeeping, Farewell, and Answering Candidate's Questions.
WRAPUP TURN COUNT: ${wrapupCountRef.current}

Transcript:
${recentHistory}

Task: Return JSON matching this schema exactly:
{
  "is_filler_pause": boolean, 
  "candidate_has_final_question": boolean, 
  "candidate_ready_to_end": boolean, // TRUE ONLY IF candidate EXPLICITLY says they have "no more questions", "that's all", or "thanks". DO NOT set true just because they finished answering a question.
  "should_end_call": boolean, // TRUE ONLY if BOTH sides have acknowledged goodbye.
  "answer_summary": "string", 
  "is_off_topic": boolean, // FALSE if candidate is asking about the role, company, or feedback. ONLY TRUE if discussing completely unrelated personal topics.
  "should_force_pivot": boolean,
  "ai_rambling": boolean, 
  "ai_hallucination_or_tone_issue": "string",
  "custom_correction_directive": "string" // Universal command to fix Aria if she deviates from the wrapup/closing goals.
}`;
      }

      setObserverActivity('analyzing');
      const raw = await callMini(prompt, systemRole, usageRef, true);
      updateUsage();

      let parsedJson: Partial<ObserverAnalysis> = {};
      try {
        const cleaned = raw.replace(/```json|```/gi, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON object found');
        parsedJson = JSON.parse(cleaned.substring(start, end + 1));
      } catch (e) {
        updateIntelLog(tid, 'error', 'Observer parse failure');
        return;
      }

      const analysis: ObserverAnalysis = {
        is_filler_pause: false, is_substantive_answer: false, answer_summary: '',
        needs_cv_lookup: false, cv_topic: '', topic_exhausted: false,
        suggested_phase_advance: 'none', should_score_answer: false,
        ai_rambling: false, ai_hallucination_or_tone_issue: '',
        candidate_struggling: false, red_flag_detected: '', callback_opportunity: '',
        requested_pause_seconds: 0, is_complex_question: false, candidate_has_final_question: false,
        candidate_ready_to_end: false, should_end_call: false, is_off_topic: false, should_force_pivot: false,
        custom_correction_directive: '',
        ...parsedJson
      };

      updateIntelLog(tid, 'done', 'Observer scan complete ✓');
      setLastObserverAnalysis(analysis);
      observerRunTurnRef.current = userTurnCountRef.current;

      // ── 0. Dynamic Silence Timer ──
      if (analysis.requested_pause_seconds > 0) {
        currentSilenceMsRef.current = analysis.requested_pause_seconds * 1000;
        startSilenceTimer(currentSilenceMsRef.current);
        const d_tid = addIntelLog('director', `Pause requested: ${analysis.requested_pause_seconds}s`);
        updateIntelLog(d_tid, 'done', 'Silence timer updated ✓');
        return;
      } else if (analysis.is_complex_question) {
        currentSilenceMsRef.current = SILENCE_COMPLEX_MS;
        startSilenceTimer(currentSilenceMsRef.current);
      } else {
        if (currentSilenceMsRef.current !== SILENCE_BASE_MS) currentSilenceMsRef.current = SILENCE_BASE_MS;
      }

      // ── 0. Drift Control ──
      if (analysis.is_off_topic) driftCountRef.current++;
      else if (analysis.is_substantive_answer || analysis.is_complex_question) driftCountRef.current = 0;
      setDriftCount(driftCountRef.current);

      // ── AI-DRIVEN CORRECTION INJECTIONS (SILENT/SOFT) ──
      let injectedDirector = false;

      // Custom AI Correction (Rambling, Hallucinations, Tone)
      const needsCorrection = analysis.ai_rambling || analysis.ai_hallucination_or_tone_issue || analysis.should_force_pivot;
      if (needsCorrection && analysis.custom_correction_directive && analysis.custom_correction_directive.length > 5) {
        setObserverActivity('injecting');
        const d_tid = addIntelLog('director', 'AI-Driven Correction Injected.');
        injectSystemMessage(`SYSTEM DIRECTIVE: ${analysis.custom_correction_directive}`, false);
        updateIntelLog(d_tid, 'done', 'Course-correction injected ✓');
        injectedDirector = true;
        if (analysis.should_force_pivot) {
          driftCountRef.current = 0;
          setDriftCount(0);
        }
      }

      // Drift Refocus (If custom wasn't provided)
      const shouldForcePivot = analysis.should_force_pivot || driftCountRef.current >= 2;
      if (shouldForcePivot && !injectedDirector) {
        setObserverActivity('injecting');
        const d_tid = addIntelLog('director', 'Persistent drift. Forcing phase refocus...');
        let pivotMsg = "CRITICAL: Stop the tangent.";
        if (currentPhase === 'greeting') pivotMsg = `CRITICAL: You are only doing an audio check. Ask ONLY: "Are you ready to begin?"`;
        else if (currentPhase === 'warmup') {
          const nextQ = warmupQueueRef.current[warmupQIndexRef.current] || "What do you enjoy doing outside of work?";
          pivotMsg = `CRITICAL: Acknowledge naturally and organically ask your next personal warmup question: "${nextQ}"`;
          warmupQIndexRef.current += 1;
        } else if (currentPhase === 'interview') pivotMsg = `CRITICAL: Pivot back to the domain interview topic: ${currentTopicRef.current}.`;
        else if (currentPhase === 'wrapup') pivotMsg = "CRITICAL: Focus ONLY on answering their final questions about the role or company.";

        injectSystemMessage(`SYSTEM DIRECTIVE: ${pivotMsg}`, false);
        driftCountRef.current = 0;
        setDriftCount(0);
        updateIntelLog(d_tid, 'done', 'Hard refocus directive injected ✓');
        injectedDirector = true;
      }

      // Explicit Guardrails
      if (analysis.candidate_struggling && !injectedDirector) {
        struggleCountRef.current++;
        setObserverActivity('injecting');
        const d_tid = addIntelLog('director', 'Detected candidate struggle.');
        injectSystemMessage("SYSTEM DIRECTIVE: The candidate is struggling. On your next turn, ONLY offer a helpful hint or simplify your previous question.", false);
        updateIntelLog(d_tid, 'done', 'Injected help prompt ✓');
        injectedDirector = true;
      } else if (!analysis.candidate_struggling) {
        struggleCountRef.current = 0;
      }

      if (analysis.red_flag_detected && !injectedDirector) {
        setObserverActivity('injecting');
        const d_tid = addIntelLog('director', `Red Flag: ${analysis.red_flag_detected}`);
        injectSystemMessage(`SYSTEM DIRECTIVE: RED FLAG: ${analysis.red_flag_detected}. On your next turn, abandon the queue and cleanly ask ONE question probing this concern.`, false);
        updateIntelLog(d_tid, 'done', 'Injected red flag pivot ✓');
        injectedDirector = true;
      }

      if (analysis.callback_opportunity && !injectedDirector) {
        addIntelLog('director', 'Contextual callback opportunity identified.');
        injectSystemMessage(`SYSTEM DIRECTIVE: If appropriate, tie your next question into this past context seamlessly: ${analysis.callback_opportunity}`, false);
      }

      // ── The "Clutch" CV Lookup (Soft Injection) ──
      if (analysis.needs_cv_lookup && analysis.cv_topic && currentPhase !== 'warmup' && currentPhase !== 'greeting') {
        handleCvLookup(analysis.cv_topic);
      }

      // ── Topic Exhaustion (Bridge) ──
      // FIX: Prioritize bridging over struggle directives if the topic is truly exhausted or candidate is totally stuck.
      if ((analysis.topic_exhausted || struggleCountRef.current >= 2) && phaseRef.current === 'interview') {
        struggleCountRef.current = 0;
        handleTopicExhausted(currentTopicRef.current);
        injectedDirector = true; // Mark as handled so we don't stack directives
      }

      // ── COUNTER-BASED PHASE TRANSITIONS ──
      let targetPhase = 'none';

      // 1. GREETING -> WARMUP
      if (phaseRef.current === 'greeting' && analysis.is_substantive_answer) {
        greetingCountRef.current += 1;
        setGreetingCount(greetingCountRef.current);
        if (greetingCountRef.current >= 1) { // 1 user answer means we are ready to transition.
          targetPhase = 'warmup';
        } else {
          if (!injectedDirector) {
            injectSystemMessage(`SYSTEM DIRECTIVE: Confirm they are ready to begin.`, false);
          }
        }
      }

      // 2. WARMUP -> INTERVIEW (Strict 3 turns)
      if (phaseRef.current === 'warmup' && (analysis.is_substantive_answer || analysis.answer_summary.length > 5)) {
        warmupCountRef.current += 1;
        setWarmupCount(warmupCountRef.current);

        if (warmupCountRef.current >= WARMUP_QUESTIONS_REQUIRED) {
          targetPhase = 'interview';
        } else {
          const nextQ = warmupQueueRef.current[warmupQIndexRef.current] || "What else do you do for fun?";
          warmupQIndexRef.current += 1;
          if (!injectedDirector) {
            injectSystemMessage(`SYSTEM DIRECTIVE: Acknowledge their answer naturally, then ask your next casual warmup question: "${nextQ}"`, false);
          }
        }
      }

      // Answer Scoring Trigger
      if (analysis.should_score_answer && analysis.answer_summary && phaseRef.current === 'interview') {
        await handleScoreAnswer(analysis.answer_summary, injectedDirector);
      }

      // Explicit Skip Trigger
      const isExplicitSkip = analysis.answer_summary?.toLowerCase().includes('skip') || analysis.answer_summary?.toLowerCase().includes('start interview');
      if ((phaseRef.current === 'warmup' || phaseRef.current === 'greeting') && isExplicitSkip) {
        targetPhase = 'interview';
      }

      // 3. INTERVIEW -> WRAPUP
      if (phaseRef.current === 'interview' && scoresRef.current.length >= numQuestionsRef.current) {
        targetPhase = 'wrapup';
      }

      // 4. WRAPUP -> CLOSING
      if (phaseRef.current === 'wrapup') {
        if (analysis.is_substantive_answer) {
          wrapupCountRef.current += 1;
          setWrapupCount(wrapupCountRef.current);
        }
        // ONLY transition to closing if candidate explicitly says they are ready OR we've exhausted 3 wrapup turns.
        if (analysis.candidate_ready_to_end || wrapupCountRef.current >= 3) {
          targetPhase = 'closing';
        }
      }

      // Natural Termination Trigger
      if (analysis.should_end_call) {
        const d_tid = addIntelLog('director', 'Final goodbye detected. Preparing termination...');
        if (isAISpeakingRef.current) pendingEndRef.current = true; else endCall();
        updateIntelLog(d_tid, 'done', 'Intent: Natural Conclusion ✓');
        return;
      }

      // ── EXECUTE PHASE ADVANCEMENTS ──
      if (targetPhase !== 'none' && targetPhase !== phaseRef.current) {

        if (targetPhase === 'warmup') {
          if (greetingTimeoutRef.current) clearTimeout(greetingTimeoutRef.current);
          transitionPhase('warmup');
          const firstWQ = warmupQueueRef.current[0] || "So, what do you enjoy doing when you're not working?";
          warmupQIndexRef.current = 1;
          topicStartTimeRef.current = Date.now();
          const d_tid = addIntelLog('director', 'Candidate ready. Starting warmup...');
          injectSystemMessage(`SYSTEM DIRECTIVE: Acknowledge and smoothly ask your first personal warmup question: "${firstWQ}"`, false);
          updateIntelLog(d_tid, 'done', 'Warmup started ✓');
          return;
        }

        if (targetPhase === 'interview') {
          if (greetingTimeoutRef.current) clearTimeout(greetingTimeoutRef.current);
          const t_tid = addIntelLog('director', 'Warmup complete. Pivoting to domain interview...');
          setQuestionCount(0);
          transitionPhase('interview');
          startInterviewTimer();
          generateInterviewStrategy(); // Injects the first tech question silently
          updateIntelLog(t_tid, 'done', 'Transitioned to Interview ✓');
          return;
        }

        if (targetPhase === 'wrapup') {
          const d_tid = addIntelLog('director', 'Domain phase complete. Transitioning to wrap-up...');
          injectSystemMessage("SYSTEM DIRECTIVE: The core evaluation is NOW finished. Transition smoothly to wrap-up. STRICTLY NO MORE domain questions. Ask if they have final questions for you.", false);
          transitionPhase('wrapup');
          wrapupCountRef.current = 0;
          setWrapupCount(0);
          updateIntelLog(d_tid, 'done', 'Wrap-up phase started ✓');
          return;
        }

        if (targetPhase === 'closing') {
          const d_tid = addIntelLog('director', 'Pivoting to final closing phase...');
          injectSystemMessage("SYSTEM DIRECTIVE: Wrap-up is complete. On your next turn, provide a warm, final farewell and stop.", false);
          transitionPhase('closing');
          updateIntelLog(d_tid, 'done', 'Closing farewell injected ✓');
          return;
        }
      }

    } catch (e) {
      console.error('[Observer] pipeline error:', e);
      updateIntelLog(tid, 'error', 'Observer analysis failed');
    } finally {
      isObserverRunningRef.current = false;
      setIsObserverActive(false);
      setObserverActivity('idle');
    }
  }, [addIntelLog, updateIntelLog, injectSystemMessage, transitionPhase, startInterviewTimer, endCall, startSilenceTimer]);


  // ─────────────────────────────────────────────────────────────────────────
  // Intelligence Functions (Triggered by Observer)
  // ─────────────────────────────────────────────────────────────────────────

  const handleCvLookup = async (topic: string) => {
    if (cvLookupCacheRef.current.has(topic)) {
      const cachedResult = cvLookupCacheRef.current.get(topic)!;
      addIntelLog('cv', `Using cached info for "${topic}"...`);
      injectSystemMessage(`SYSTEM DATA - CV LOOKUP [MEMORY] for "${topic}": ${cachedResult}. Seamlessly weave this into your next organic response.`, false);
      return;
    }

    setIsCvLooking(true);
    const tid = addIntelLog('cv', `Analyzing CV for "${topic}"...`);
    try {
      const result = await callMini(
        `FULL CV:\n${cvTextRef.current}\n\nThe interviewer needs info about: "${topic}". \nProvide a brief, factual extract about this topic from the CV. If completely missing, say "Not mentioned in the CV."`,
        'CV lookup tool. Factual, brief, no commentary.',
        usageRef
      );
      updateUsage();
      cvLookupCacheRef.current.set(topic, result);
      injectSystemMessage(`SYSTEM DATA - CV LOOKUP for "${topic}": ${result}. Seamlessly weave this into your next organic response.`, false);
      updateIntelLog(tid, 'done', `CV lookup: "${topic}" ✓`);
    } catch {
      injectSystemMessage('SYSTEM DIRECTIVE: CV data unavailable. Acknowledge smoothly and pivot to the next question.', false);
      updateIntelLog(tid, 'error', 'CV lookup failed');
    } finally {
      setIsCvLooking(false);
    }
  };

  const [queuedCvProjects, setQueuedCvProjects] = useState<string[]>([]);

  const handleScoreAnswer = async (answerSummary: string, suppressInjection: boolean = false) => {
    // ── DE-DUPLICATION & GRACE TURN GUARD ──
    const currentTurn = userTurnCountRef.current;
    if (scoredTurnRef.current === currentTurn || lastScoredSummaryRef.current === answerSummary) {
      return;
    }

    if (skipNextScoreRef.current) {
      console.log('Scoring skipped: First turn after phase transition (Grace Turn).');
      skipNextScoreRef.current = false;
      return;
    }

    scoredTurnRef.current = currentTurn;
    lastScoredSummaryRef.current = answerSummary;

    const tid = addIntelLog('score', `Sub-Observer scoring answer...`);
    try {
      const scoringPrompt = `Evaluate the candidate's technical response with high precision.
Question: "${scoringQuestionRef.current}"
Answer: "${answerSummary}"

Task: Provide a premium technical evaluation.
1. "question_summary": 5-8 word summary of what was asked.
2. "score": 1-10.
3. "technical_accuracy": 1-10 (Strictly on facts).
4. "logic_evaluation": 1-sentence assessment of their reasoning.
5. "missed_opportunities": List of 2-3 key technical points or keywords they OMITTED.
6. "confidence/grammar/clarity/depth": standard metrics.

Return JSON only:
{
  "question_summary": "string",
  "score": number,
  "technical_accuracy": number,
  "logic_evaluation": "string",
  "missed_opportunities": ["string"],
  "confidence": "high|medium|low",
  "grammar": "good|average|poor",
  "clarity": "good|average|poor",
  "depth": "shallow|adequate|deep"
}`;

      const followUpPrompt = `Context:
Question: "${lastAiQuestionRef.current}"
Answer: "${answerSummary}"
Topic: ${currentTopicRef.current}

Return JSON only:
{
  "feedback": "<one sentence>",
  "tags": ["<tag1>", "<tag2>"],
  "suggested_followup": "<specific follow-up connecting to what they just said, max 25 words>"
}`;

      const cvDeepDivePrompt = `CV:
${cvTextRef.current.slice(0, 4000)}

Current answer: "${answerSummary}"

Identify ONE specific project/experience from the CV relating to this answer. Generate ONE deep-dive follow-up connecting their answer to that specific CV experience.
Return JSON only:
{
  "project_reference": "<project name>",
  "cv_followup": "<follow-up question>"
}`;

      setIsCvAnalyzing(true);
      const [scoreRaw, followUpRaw, cvDeepDiveRaw] = await Promise.all([
        callMini(scoringPrompt, 'Scoring Sub-Observer. JSON only.', usageRef, true),
        callMini(followUpPrompt, 'Follow-up generator. JSON only.', usageRef, true),
        callMini(cvDeepDivePrompt, 'CV-Deep-Dive Sub-Observer. JSON only.', usageRef, true)
      ]);
      setIsCvAnalyzing(false);
      updateUsage();

      let parsedScore = { 
        score: 5, technical_accuracy: 5, logic_evaluation: '', missed_opportunities: [], 
        question_summary: '', confidence: 'medium', grammar: 'average', clarity: 'average', depth: 'adequate' 
      };
      try { parsedScore = JSON.parse(scoreRaw.replace(/```json|```/g, '').trim()); } catch (e) { }
      let parsedFollowUp = { feedback: 'Answer recorded.', tags: [], suggested_followup: '' };
      try { parsedFollowUp = JSON.parse(followUpRaw.replace(/```json|```/g, '').trim()); } catch (e) { }
      let parsedCvDeepDive = { project_reference: '', cv_followup: '' };
      try { parsedCvDeepDive = JSON.parse(cvDeepDiveRaw.replace(/```json|```/g, '').trim()); } catch (e) { }

      const finalScore = Math.min(10, Math.max(1, parsedScore.score || 5));

      const score: AnswerScore = {
        question: parsedScore.question_summary || scoringQuestionRef.current || 'Technical Evaluation',
        answerSummary: answerSummary.slice(0, 200),
        score: finalScore, feedback: parsedFollowUp.feedback || '', tags: parsedFollowUp.tags || [],
        topic: currentTopicRef.current, depth: topicDepthMapRef.current.get(currentTopicRef.current)?.level || 1,
        confidence: (parsedScore as any).confidence || 'medium', grammar: (parsedScore as any).grammar || 'average',
        clarity: (parsedScore as any).clarity || 'average', depthStr: (parsedScore as any).depth || 'adequate',
        technicalAccuracy: parsedScore.technical_accuracy,
        questionSummary: parsedScore.question_summary,
        missedOpportunities: parsedScore.missed_opportunities,
        logicEvaluation: parsedScore.logic_evaluation
      };

      scoresRef.current = [...scoresRef.current, score];
      setScores([...scoresRef.current]);
      updateIntelLog(tid, 'done', `Scored: ${finalScore}/10 ✓`);

      const depthInfo = topicDepthMapRef.current.get(currentTopicRef.current);
      const ansCount = (depthInfo?.answerCount || 0) + 1;
      let newLevel = depthInfo?.level || 1;

      if (!suppressInjection) {
        if (finalScore <= 3) {
          newLevel = Math.max(1, newLevel - 1);
          // EXPLICIT Adaptive instruction - Stronger pivot for very low scores
          const advice = finalScore <= 2 
            ? "Candidate is significantly stuck. Acknowledge, offer a Tiny hint, and then pivot to a different technical area entirely."
            : `Candidate struggled. Lower difficulty to Level ${newLevel}. Ask a simpler, foundational question.`;
          injectSystemMessage(`SYSTEM DIRECTIVE: ${advice}`, false);
        } else if (finalScore >= 8) {
          newLevel = Math.min(3, newLevel + 1);
          // EXPLICIT Adaptive instruction
          injectSystemMessage(`SYSTEM DIRECTIVE: Candidate excelled (Score ${finalScore}/10). Increase difficulty to Level ${newLevel}. Ask a more complex or edge-case question about "${currentTopicRef.current}".`, false);
        } else {
          if (parsedFollowUp.suggested_followup) {
            const topicInfo = topicDepthMapRef.current.get(currentTopicRef.current);
            if (topicInfo) {
              topicInfo.questions.push(parsedFollowUp.suggested_followup);
              addIntelLog('notes', `Queued follow-up: "${parsedFollowUp.suggested_followup.slice(0, 30)}..."`);
              if (parsedScore.depth === 'shallow' && ansCount < 3) {
                injectSystemMessage(`SYSTEM NOTE: Consider probing deeper naturally on your next turn using: "${parsedFollowUp.suggested_followup}".`, false);
              }
            }
          }
          if (parsedCvDeepDive.cv_followup) {
            const topicInfo = topicDepthMapRef.current.get(currentTopicRef.current);
            if (topicInfo) {
              topicInfo.questions.push(parsedCvDeepDive.cv_followup);
              setQueuedCvProjects(prev => [...new Set([...prev, parsedCvDeepDive.project_reference])]);
              addIntelLog('cv', `Queued CV Follow-up: "${parsedCvDeepDive.project_reference}" ✓`);
              injectSystemMessage(`SYSTEM CONTEXT: CV mentions "${parsedCvDeepDive.project_reference}". A great organic follow-up for your NEXT turn: "${parsedCvDeepDive.cv_followup}"`, false);
            }
          }
        }
      } else {
        if (finalScore <= 4) newLevel = Math.max(1, newLevel - 1);
        if (finalScore >= 8) newLevel = Math.min(3, newLevel + 1);
      }

      if (depthInfo) {
        topicDepthMapRef.current.set(currentTopicRef.current, { ...depthInfo, level: newLevel, answerCount: ansCount });
        setCurrentDepth(newLevel);
      }

      answerCountRef.current += 1;
      if (answerCountRef.current % GAP_DETECT_EVERY_N_ANSWERS === 0 && !suppressInjection) handleGapDetection();

    } catch (e) { console.error('[Score] failed:', e); }
  };

  const handleTopicExhausted = async (exhaustedTopic: string) => {
    setIsBridging(true);
    if (!topicsCoveredRef.current.includes(exhaustedTopic)) {
      topicsCoveredRef.current = [...topicsCoveredRef.current, exhaustedTopic];
      setTopicsCovered([...topicsCoveredRef.current]);
    }

    const tid = addIntelLog('bridge', `Bridging from "${exhaustedTopic}"...`);
    try {
      const strategy = strategyRef.current;
      const nextTopic = strategy?.topics.find(t => !topicsCoveredRef.current.includes(t)) || '';
      const nextQ = nextTopic ? (strategy?.questionQueue[nextTopic]?.[0] || '') : '';

      if (!nextTopic) {
        addIntelLog('notes', 'All core strategy topics covered. Continuing with deep-dives.');
        setIsBridging(false);
        updateIntelLog(tid, 'done', 'Core topic list complete ✓');
        // No wrap-up injection here; let the phase transition logic handle it.
        return;
      }

      currentTopicRef.current = nextTopic;
      setCurrentTopicDisplay(nextTopic);
      setCurrentDepth(1);
      topicStartTimeRef.current = Date.now();

      topicDepthMapRef.current.set(nextTopic, { topic: nextTopic, level: 1, answerCount: 0, questions: strategy?.questionQueue[nextTopic] || [], currentQIndex: 0 });

      injectSystemMessage(`SYSTEM DIRECTIVE: Topic "${exhaustedTopic}" is done. On your next turn, pivot smoothly to: "${nextTopic}". You can use this question naturally: "${nextQ}".`, false);
      updateIntelLog(tid, 'done', `Bridged to "${nextTopic}" ✓`);
    } catch (e) {
      console.error('[Bridge] failed:', e);
    } finally { setIsBridging(false); }
  };

  const handleGapDetection = async () => {
    if (!jdTextRef.current) return;
    const tid = addIntelLog('gap', 'Scanning JD for missing coverage...');
    try {
      const gap = await callMini(
        `JD:\n${jdTextRef.current.slice(0, 600)}\n\nTopics covered: ${topicsCoveredRef.current.join(', ')}\n\nWhat important core requirement has NOT been probed yet? Return ONE specific gap area in 10 words or less. If no gap, return "none".`,
        'Gap detection engine. Return only gap area name or "none".', usageRef
      );
      updateUsage();
      if (gap && gap !== 'none' && gap.length < 80) {
        setDetectedGap(gap);
        const gapQ = await callMini(
          `Gap area not yet covered: "${gap}"\nGenerate ONE targeted question to probe this gap naturally. Max 25 words.`,
          'Question generator. Return only the question.', usageRef
        );
        updateUsage();
        if (gapQ) {
          injectSystemMessage(`SYSTEM DIRECTIVE: JD Gap Identified - "${gap}". At your next conversational opening, probe this by organically asking: "${gapQ}".`, false);
          updateIntelLog(tid, 'done', `Identified gap: "${gap}" ✓`);
        }
      } else {
        updateIntelLog(tid, 'done', 'JD coverage complete ✓');
      }
    } catch (e) { console.error('[Gap] failed:', e); }
  };

  const generateInterviewStrategy = async () => {
    setIsThinking(true);
    const tid = addIntelLog('strategy', 'Generating Universal Domain Strategy...');
    try {
      const raw = await callMini(
        `CV Summary: ${cvSummaryRef.current}
JD Context: ${jdTextRef.current.slice(0, 1000)}

Task: Generate a domain-specific interview strategy.
RULES:
1. STRICTLY FORBID generic "tell me about yourself" questions. 
2. EVERY question MUST include a specific domain concept, methodology, or tool from the CV/JD.
3. LVL 1: Foundational core concept.
4. LVL 2: Applied scenario or trade-off.
5. LVL 3: Complex problem-solving or edge cases.

Return JSON strictly matching:
{
  "topics": ["<CoreTopic1>", "<CoreTopic2>", "<CoreTopic3>"],
  "questionQueue": {
    "<CoreTopic1>": ["<LVL1 Specific Q>", "<LVL2 Specific Q>", "<LVL3 Specific Q>"],
    ...
  },
  "gapAreas": ["<gap>"]
}`,
        'Strategy Engine. Factual and direct. JSON only.', usageRef, true
      );
      updateUsage();

      let strategy: InterviewStrategy;
      try { strategy = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
      catch { strategy = { topics: ['Core Competencies', 'Experience'], questionQueue: {}, gapAreas: [] }; }

      strategyRef.current = strategy;
      setStrategyTopics(strategy.topics);

      for (const topic of strategy.topics) {
        topicDepthMapRef.current.set(topic, { topic, level: 1, answerCount: 0, questions: strategy.questionQueue[topic] || [], currentQIndex: 0 });
      }

      const firstTopic = strategy.topics[0] || 'Core Competencies';
      const firstQ = strategy.questionQueue[firstTopic]?.[0] || '';

      currentTopicRef.current = firstTopic;
      setCurrentTopicDisplay(firstTopic);
      topicStartTimeRef.current = Date.now();

      injectSystemMessage(`SYSTEM DIRECTIVE: Formal evaluation starting. For your NEXT turn, smoothly pivot from the casual talk into the interview using this domain question: "${firstQ}".`, false);
      updateIntelLog(tid, 'done', 'Domain Strategy ready ✓');

    } catch (e) {
      console.error('[Strategy] failed:', e);
    } finally { setIsThinking(false); }
  };

  const generateWarmupQuestions = async () => {
    try {
      const raw = await callMini(
        `CV Summary: ${cvSummaryRef.current.slice(0, 500)}\n\nGenerate 2 unique, engaging personal warmup questions. 
        RULES:
        1. FOCUS ONLY on personal life, hobbies, pets, travel, or off-work passions found or implied in the CV.
        2. STRICTLY FORBIDDEN: Any mention of projects, work experience, tech stack, education, or professional goals.
        3. TONE: Extreme casual icebreaker. 
        
        Return JSON array only: ["<q1>", "<q2>"]`,
        'Personal warmup generator. JSON array only.', usageRef, true
      );
      let qs: string[] = [];
      try { qs = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { }
      if (qs.length >= 2) { 
        // Force the 3rd question to be "Tell me about yourself"
        warmupQueueRef.current = [...qs, "That's wonderful! Before we dive into the technical stuff, why don't you tell me a bit about yourself and your professional journey?"]; 
        warmupQIndexRef.current = 0; 
      }
    } catch { }
  };


  // ─────────────────────────────────────────────────────────────────────────
  // RT Event Handler
  // ─────────────────────────────────────────────────────────────────────────

  const handleRtEvent = useCallback((ev: Record<string, unknown>) => {
    switch (ev.type as string) {
      case 'conversation.item.created': {
        const item = ev.item as Record<string, unknown>;
        if (!item?.id) break;
        const id = item.id as string;
        rtItemIdsRef.current = [...rtItemIdsRef.current, id];

        // ACTOR MEMORY PRUNING (USER LIMIT: 8 ITEMS)
        if (rtItemIdsRef.current.length > 8) {
          const oldestId = rtItemIdsRef.current.shift();
          if (oldestId) {
            sendRt({ type: 'conversation.item.delete', item_id: oldestId });
            addIntelLog('director', `Pruned oldest Actor turn (Memory: 8 items) ✓`);
          }
        }

        if ((item.type as string) === 'message') {
          const role = item.role as 'user' | 'assistant' | 'system';
          if (role !== 'system') {
            setLogs(prev => prev.find(l => l.id === id) ? prev : [...prev, { id, role: role === 'assistant' ? 'ai' : 'user', text: '', pending: true }]);
          }
        }
        break;
      }

      case 'input_audio_buffer.speech_started':
        setCallStatus('Listening...');
        silencePromptCountRef.current = 0;
        clearSilenceTimer();
        if (greetingTimeoutRef.current) {
          clearTimeout(greetingTimeoutRef.current);
          greetingTimeoutRef.current = null;
        }
        // LOCK THE QUESTION: Capture what the AI just asked before the user started responding.
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
          setLogs(prev => {
            const idx = prev.findIndex(l => l.id === itemId);
            if (idx === -1) return [...prev, { id: itemId, role: 'ai', text: transcript }];
            const copy = [...prev];
            copy[idx] = { ...copy[idx], text: transcript, pending: false };
            return copy;
          });
          convHistoryRef.current = [...convHistoryRef.current.slice(-39), { role: 'assistant', content: transcript }];
          if (transcript.includes('?')) {
            lastAiQuestionRef.current = transcript;
            if (phaseRef.current === 'interview') setQuestionCount(p => p + 1);
            setCurrentQ(transcript);
          }
        }
        setCallStatus('Listening...');
        startSilenceTimer();
        runObserverPipeline();
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const text = ((ev.transcript as string) || '').trim();
        const itemId = ev.item_id as string;
        if (!text) break;

        convHistoryRef.current = [...convHistoryRef.current.slice(-39), { role: 'user', content: text }];
        setLogs(prev => {
          const idx = prev.findIndex(l => l.id === itemId);
          if (idx === -1) return [...prev, { id: itemId, role: 'user', text }];
          const copy = [...prev];
          copy[idx] = { ...copy[idx], text, pending: false };
          return copy;
        });

        userTurnCountRef.current += 1;
        runObserverPipeline();
        break;
      }

      case 'response.done': {
        const resp = ev.response as Record<string, unknown> | undefined;
        if (resp?.usage) {
          const usage = resp.usage as Record<string, unknown>;
          const inp = (usage.input_token_details as Record<string, number>) || {};
          const out = (usage.output_token_details as Record<string, number>) || {};
          usageRef.current.rtTextIn += inp.text_tokens || 0;
          usageRef.current.rtAudioIn += inp.audio_tokens || 0;
          usageRef.current.rtTextOut += out.text_tokens || 0;
          usageRef.current.rtAudioOut += out.audio_tokens || 0;
        }
        setCallStatus('Listening...');
        break;
      }

      case 'response.output_item.added': {
        const item = ev.item as Record<string, unknown> | undefined;
        if ((item?.role as string) === 'assistant') {
          setCallStatus('Speaking...');
          clearSilenceTimer();
          isObserverRunningRef.current = false;
          setIsObserverActive(false);
          setObserverActivity('idle');
          setLastInjection(null); // UNSTICKS THE UI DIRECTIVE MESSAGE
        }
        break;
      }
    }
  }, [runObserverPipeline, clearSilenceTimer, startSilenceTimer]);


  // ─────────────────────────────────────────────────────────────────────────
  // Call Lifecycle Handlers
  // ─────────────────────────────────────────────────────────────────────────

  const handleCvFile = async (file: File) => {
    setIsParsing(true); setSetupErr(''); setCvFileName(file.name);
    try {
      const text = await extractTextFromFile(file);
      if (!text || text.trim().length < 50) {
        setSetupErr('Could not extract text. Please paste CV text directly.');
        setCvFileName(''); setIsParsing(false); return;
      }
      setCvText(text); cvTextRef.current = text;
      try {
        const name = await callMini(
          `Extract candidate's full name from CV. Return only name.\n${text.slice(0, 1500)}`,
          'Name extraction only.', usageRef
        );
        const clean = name.replace(/["']/g, '').trim();
        if (clean && clean !== 'Unknown') { setCandidateName(clean); candidateNameRef.current = clean; }
      } catch { }
    } catch { setSetupErr('Failed to read file.'); setCvFileName(''); }
    setIsParsing(false);
  };

  const startCall = useCallback(async () => {
    if (isStartingRef.current || isCallActive) return;
    if (!cvText && !jdText) { setSetupErr('Please upload a CV or paste a Job Description.'); return; }
    isStartingRef.current = true;
    isEndingRef.current = false;

    setLogs([]); setScores([]); setTopicsCovered([]); setQuestionCount(0);
    setCurrentQ(''); setCvSummary(''); setWarmupCount(0); setGreetingCount(0); setWrapupCount(0);
    setIsBridging(false); setIsCvLooking(false); setIsThinking(false);
    setInterviewTimeLeft(interviewDuration * 60);
    setIsCallEnded(false);
    setCurrentTopicDisplay(''); setCurrentDepth(1); setDetectedGap(''); setStrategyTopics([]);
    setCallStatus('Connecting...');

    convHistoryRef.current = [];
    rtItemIdsRef.current = [];
    userTurnCountRef.current = 0;
    observerRunTurnRef.current = -1;
    isObserverRunningRef.current = false;
    cvLookupCacheRef.current.clear();
    answerCountRef.current = 0;

    greetingCountRef.current = 0;
    warmupCountRef.current = 0;
    wrapupCountRef.current = 0;
    lastSystemItemIdRef.current = null;

    lastAiQuestionRef.current = '';
    currentTopicRef.current = 'general';
    topicStartTimeRef.current = 0;
    topicsCoveredRef.current = [];
    scoresRef.current = [];
    cvSummaryRef.current = '';
    strategyRef.current = null;
    topicDepthMapRef.current.clear();
    usageRef.current = { rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0, miniPrompt: 0, miniCompletion: 0 };

    currentSilenceMsRef.current = SILENCE_BASE_MS;
    clearSilenceTimer();

    abortRef.current = new AbortController();
    const { signal } = abortRef.current;

    await Promise.allSettled([
      cvText ? callMini(
        `Create concise interviewer briefing from this CV. Include: full name, current role, years experience, top skills, notable achievements. Max 200 words. CV:\n${cvText}`,
        'CV analyst. Flowing prose.', usageRef
      ).then(result => { if (result) { cvSummaryRef.current = result; setCvSummary(result); } }) : Promise.resolve(),
    ]);

    if (cvText || jdText) await generateWarmupQuestions();

    try {
      const tokenRes = await fetch('/ai-interview/api/realtime-token', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: 'shimmer' }),
      });
      if (signal.aborted) throw new Error('aborted');
      const tokenData = await tokenRes.json();
      const KEY = tokenData.client_secret.value;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = e => {
        audioEl.srcObject = e.streams[0];
        const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const outSource = outCtx.createMediaStreamSource(e.streams[0]);
        const outAnalyser = outCtx.createAnalyser();
        outAnalyser.fftSize = 256;
        outSource.connect(outAnalyser);
        const outData = new Uint8Array(outAnalyser.frequencyBinCount);

        const checkAIAudio = () => {
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
          requestAnimationFrame(checkAIAudio);
        };
        checkAIAudio();
      };

      const ms = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 },
      });
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
        phaseRef.current = 'greeting';
        setPhase('greeting');

        sendRt({
          type: 'session.update',
          session: {
            instructions: `IMPORTANT: ONLY COMMUNICATE IN ENGLISH. \n\n` + buildActorPrompt('greeting'),
            input_audio_transcription: { model: 'whisper-1', language: 'en' },
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1500 },
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

          // This timeout handles cases where the RT model doesn't respond to the prompt.
          // Since the AI opens now, we don't need the auto-advance here unless silence timer takes over.
        }, 200);
      };

      dc.onmessage = e => {
        try { handleRtEvent(JSON.parse(e.data as string)); } catch { }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch(
        'https://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17',
        { method: 'POST', signal, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/sdp' }, body: offer.sdp }
      );
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

    } catch (err: any) {
      if (err.message !== 'aborted') {
        setCallStatus('Connection failed');
        setSetupErr(`Failed to connect: ${err.message}`);
        setPhase('setup');
      }
      pcRef.current?.close(); streamRef.current?.getTracks().forEach(t => t.stop());
      setIsCallActive(false); isStartingRef.current = false;
    }
  }, [isCallActive, cvText, jdText, buildActorPrompt, sendRt, handleRtEvent, transitionPhase, clearSilenceTimer, interviewDuration]);

  const toggleMute = () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setIsMuted(!track.enabled); }
  };

  useEffect(() => {
    if (!isCallActive) return;
    const iv = setInterval(() => {
      setDuration(d => d + 1);
      setLiveCost(computeCost(usageRef.current));
    }, 1000);
    return () => clearInterval(iv);
  }, [isCallActive]);


  // ─────────────────────────────────────────────────────────────────────────
  // UI Data Calculation
  // ─────────────────────────────────────────────────────────────────────────

  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b.score, 0) / scores.length : 0;
  const totalCost = computeCost(usageRef.current);
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
  const phaseLabel: Record<AppPhase, string> = {
    setup: 'Setup', connecting: 'Connecting',
    greeting: 'Greeting', warmup: 'Warmup', interview: 'Interview',
    wrapup: 'Wrap Up', closing: 'Closing', report: 'Complete',
  };

  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=Syne:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,700;1,400&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:     #070b12;
      --bg2:    #0c1220;
      --bg3:    #111927;
      --line:   #1c2840;
      --line2:  #263550;
      --blue:   #3b7bff;
      --indigo: #6366f1;
      --green:  #22c55e;
      --amber:  #f59e0b;
      --red:    #ef4444;
      --violet: #c084fc;
      --cyan:   #38bdf8;
      --text:   #e2eaf8;
      --text2:  #7a90b0;
      --text3:  #3a506a;
      --mono:   'DM Mono', monospace;
      --sans:   'Syne', sans-serif;
      --serif:  'Playfair Display', serif;
    }
    html, body { background: var(--bg); color: var(--text); font-family: var(--sans); overflow: hidden; height: 100vh; width: 100vw; margin: 0; }
    ::-webkit-scrollbar { width: 3px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 3px; }

    .noise { position: fixed; inset: 0; pointer-events: none; opacity: .03;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      background-size: 180px; }

    .setup { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; overflow-y: auto; padding: 28px; gap: 32px; }
    .setup-eyebrow { font-family: var(--mono); font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: var(--blue); display: flex; align-items: center; gap: 8px; }
    .setup-eyebrow::before,.setup-eyebrow::after { content:''; flex:1; height:1px; background:linear-gradient(90deg,transparent,var(--blue)33); }
    .setup-title { font-family: var(--serif); font-size: clamp(36px,6vw,60px); font-weight: 700; text-align: center; line-height: 1.05; }
    .setup-title em { font-style: italic; color: var(--blue); }
    .setup-sub { font-family: var(--mono); font-size: 11px; color: var(--text2); letter-spacing: .06em; text-align: center; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; width: 100%; max-width: 900px; }
    @media(max-width:640px) { .grid2 { grid-template-columns: 1fr; } }
    .card { background: var(--bg2); border: 1px solid var(--line); border-radius: 16px; padding: 22px; display: flex; flex-direction: column; gap: 14px; }
    .card-label { font-family: var(--mono); font-size: 9px; letter-spacing: .18em; text-transform: uppercase; color: var(--text3); display: flex; align-items: center; gap: 7px; }
    
    .drop { border: 1.5px dashed var(--line2); border-radius: 10px; padding: 30px 20px; display: flex; flex-direction: column; align-items: center; gap: 10px; cursor: pointer; transition: .2s; text-align: center; }
    .drop:hover,.drop.over { border-color: var(--blue); background: rgba(59,123,255,.04); }
    .drop-icon { width: 44px; height: 44px; border-radius: 12px; background: rgba(59,123,255,.1); display: flex; align-items: center; justify-content: center; color: var(--blue); }
    .cv-ok { display: flex; align-items: center; gap: 10px; background: rgba(34,197,94,.07); border: 1px solid rgba(34,197,94,.2); border-radius: 9px; padding: 11px 14px; }
    .cv-ok-name { font-size: 12px; font-weight: 600; color: #22c55e; }
    .textarea { width: 100%; background: #040709; border: 1px solid var(--line); border-radius: 9px; padding: 12px 14px; color: var(--text); font-family: var(--sans); font-size: 12px; resize: vertical; min-height: 160px; line-height: 1.6; outline: none; }
    .textarea:focus { border-color: var(--blue); }
    .input { width: 100%; background: #040709; border: 1px solid var(--line); border-radius: 9px; padding: 10px 14px; color: var(--text); font-family: var(--sans); font-size: 13px; outline: none; }
    
    .err { display: flex; align-items: center; gap: 8px; background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.25); border-radius: 9px; padding: 10px 14px; font-size: 12px; color: #f87171; width: 100%; max-width: 900px; }
    .start-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; max-width: 900px; padding: 17px; border-radius: 13px; background: linear-gradient(135deg,#1d4ed8,#4f46e5); border: none; cursor: pointer; color: white; font-family: var(--sans); font-size: 15px; font-weight: 700; transition: .25s; }
    .start-btn:disabled { opacity: .4; cursor: not-allowed; }
    .tags-row { display: flex; flex-wrap: wrap; gap: 7px; justify-content: center; max-width: 900px; }
    .feature-tag { font-family: var(--mono); font-size: 9px; background: rgba(255,255,255,.03); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; }

    .tab-row { display: flex; gap: 4px; background: rgba(0,0,0,.2); border: 1px solid var(--line); border-radius: 10px; padding: 4px; margin-bottom: 2px; }
    .tab-btn { flex: 1; border: none; padding: 7px; border-radius: 7px; font-family: var(--mono); font-size: 10px; font-weight: 600; cursor: pointer; transition: .2s; }
    .tab-btn.on { background: var(--blue); color: white; box-shadow: 0 4px 12px rgba(59,123,255,.2); }
    .tab-btn:not(.on) { background: transparent; color: var(--text3); }
    .tab-btn:not(.on):hover { background: rgba(255,255,255,.03); color: var(--text2); }

    .template-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; max-height: 240px; overflow-y: auto; padding-right: 4px; }
    .template-card { padding: 9px 12px; background: rgba(255,255,255,.02); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; transition: .2s; text-align: left; }
    .template-card:hover { border-color: var(--blue)44; background: rgba(59,123,255,.04); transform: translateY(-1px); }
    .template-card.on { border-color: var(--blue); background: rgba(59,123,255,.08); }
    .template-name { font-size: 11px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 6px; }
    .template-role { font-size: 9px; color: var(--text3); margin-top: 1px; }

    .connecting { display: flex; align-items: center; justify-content: center; height: 100vh; overflow: hidden; }
    .conn-inner { display: flex; flex-direction: column; align-items: center; gap: 18px; text-align: center; }
    .conn-ring { width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg,#1d4ed8,#4f46e5); display: flex; align-items: center; justify-content: center; animation: pulseRing 1.8s ease-in-out infinite; font-size: 28px; }
    @keyframes pulseRing { 0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,.5)} 50%{box-shadow:0 0 0 20px rgba(99,102,241,0)} }

    .live { display: grid; grid-template-columns: 290px 1fr 310px; height: 100vh; overflow: hidden; }
    @media(max-width:1100px) { .live { grid-template-columns: 270px 1fr; } .live-right { display: none; } }
    @media(max-width:720px) { .live { grid-template-columns: 1fr; } .live-center { display: none; } }
    .live-left { border-right: 1px solid var(--line); background: var(--bg2); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .live-center { display: flex; flex-direction: column; overflow: hidden; }
    .live-right { border-left: 1px solid var(--line); background: var(--bg2); overflow-y: auto; }

    .agent-top { padding: 22px 18px 18px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .avatar { width: 68px; height: 68px; border-radius: 50%; background: linear-gradient(135deg,#1a2b5e,#111e42); border: 2px solid var(--line2); display: flex; align-items: center; justify-content: center; font-size: 28px; transition: .4s; }
    .avatar.speaking { box-shadow: 0 0 0 4px rgba(59,123,255,.3), 0 0 20px rgba(59,123,255,.15); }
    .avatar.bridging { box-shadow: 0 0 0 4px rgba(99,102,241,.3), 0 0 20px rgba(99,102,241,.15); }
    .agent-name { font-family: var(--serif); font-size: 22px; font-weight: 700; }
    .status-pill { display: flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 100px; font-family: var(--mono); font-size: 10px; }
    
    .wave { display: flex; align-items: flex-end; gap: 2px; height: 28px; }
    .wbar { width: 3px; border-radius: 2px; transition: height .1s; }

    .tier-wrap { margin: 10px; border: 1px solid var(--line); border-radius: 11px; overflow: hidden; flex-shrink: 0; }
    .tier-hd { padding: 8px 12px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
    .tier-row { padding: 9px 12px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--line); transition: .3s; }
    .tier-row.on { background: rgba(59,123,255,.04); }
    .tdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

    .controls { padding: 14px; border-top: 1px solid var(--line); display: flex; gap: 8px; flex-shrink: 0; background: var(--bg2); }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: none; cursor: pointer; border-radius: 9px; font-family: var(--sans); font-weight: 600; font-size: 12px; padding: 10px 14px; }
    .btn-mute { background: rgba(255,255,255,.05); color: var(--text2); border: 1px solid var(--line); flex: 1; }
    .btn-end { background: rgba(239,68,68,.1); color: #f87171; border: 1px solid rgba(239,68,68,.2); flex: 2; }

    .phase-strip { padding: 10px 20px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,.015); }
    .phase-flow { display: flex; align-items: center; gap: 10px; }
    .phase-sep { width: 18px; height: 1px; background: var(--line2); }
    .center-head { padding: 12px 20px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
    .center-title { font-size: 13px; font-weight: 600; }
    .center-body { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
    .cur-q { background: rgba(59,123,255,.06); border: 1px solid rgba(59,123,255,.2); border-radius: 10px; padding: 12px 14px; margin: 0 20px; }
    
    .log-entry { display: flex; gap: 10px; align-items: flex-start; }
    .log-av { width: 28px; height: 28px; border-radius: 7px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-size: 9px; font-weight: 700; }
    .log-av.ai { background: rgba(59,123,255,.1); color: var(--blue); border: 1px solid rgba(59,123,255,.2); }
    .log-av.user { background: rgba(34,197,94,.1); color: #22c55e; border: 1px solid rgba(34,197,94,.2); }
    .log-text { font-size: 12px; line-height: 1.6; flex: 1; }
    
    .intel-feed { margin: 10px; border: 1px solid var(--line); border-radius: 11px; overflow: hidden; background: rgba(255,255,255,.01); flex-shrink: 0; }
    .intel-hd { padding: 8px 12px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
    .intel-row { padding: 8px 12px; display: flex; align-items: flex-start; gap: 10px; border-bottom: 1px solid var(--line); }
    .intel-icon { width: 16px; height: 16px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; margin-top: 1px; }

    .score-card { margin: 10px; border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 7px; }
    .sc-q { font-size: 11px; color: var(--text2); }
    .sc-a { font-family: var(--mono); font-size: 10px; color: var(--text3); }
    
    .depth-wrap { margin: 10px; border: 1px solid var(--line); border-radius: 11px; padding: 12px; background: linear-gradient(135deg, rgba(56,189,248,0.05), transparent); border-left: 3px solid var(--cyan); flex-shrink: 0; }
    .depth-label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .depth-dots { display: flex; gap: 4px; }
    .depth-dot { width: 14px; height: 4px; border-radius: 2px; background: var(--line2); transition: .4s; }
    .depth-dot.on { background: var(--cyan); box-shadow: 0 0 8px var(--cyan)66; }
    
    .metric-pill { font-family: var(--mono); font-size: 8px; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.03); border: 1px solid var(--line); color: var(--text3); text-transform: uppercase; letter-spacing: 0.05em; }

    .fade { animation: fadeUp .35s ease forwards; }
    @keyframes fadeUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
    .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.2); border-top-color: white; animation: spin .8s linear infinite; }
    @keyframes spin { to{transform:rotate(360deg)} }

    .q-counter { display: flex; align-items: center; gap: 8px; background: var(--bg3); border: 1px solid var(--line); padding: 4px 10px; border-radius: 6px; font-family: var(--mono); }
    .q-count-val { font-size: 11px; font-weight: 700; color: #f59e0b; }
    .q-count-total { font-size: 10px; color: var(--text3); }

    .report-wrap { height: 100vh; display: flex; align-items: center; justify-content: center; padding: 28px; overflow: hidden; }
    .report { width: 100%; max-width: 860px; height: 100%; max-height: 90vh; background: var(--bg2); border: 1px solid var(--line); border-radius: 20px; overflow: hidden; display: flex; flex-direction: column; }
    .report-hero { padding: 40px; background: linear-gradient(135deg,#08101f,#110e2b); border-bottom: 1px solid var(--line); text-align: center; }
    .report-avg { font-family: var(--serif); font-size: 64px; font-weight: 700; }
    .report-stats { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; background: var(--line); }
    .rstat { background: var(--bg2); padding: 18px; }
    .rstat-val { font-family: var(--serif); font-size: 28px; font-weight: 700; }
    .rstat-lbl { font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--text3); }
    .answers-section { padding: 18px; display: flex; flex-direction: column; gap: 10px; max-height: 500px; overflow-y: auto; }
    .answer-item { border: 1px solid var(--line); border-radius: 10px; padding: 13px; display: flex; flex-direction: column; gap: 7px; }
    .restart-btn { background: linear-gradient(135deg,#1d4ed8,#4f46e5); color: white; padding: 13px 36px; border-radius: 10px; font-family: var(--sans); font-size: 14px; font-weight: 700; border: none; cursor: pointer; }

    @keyframes scan {
      0% { transform: translateY(-100%); opacity: 0; }
      50% { opacity: 1; }
      100% { transform: translateY(100%); opacity: 0; }
    }
    .scanner-line {
      position: absolute; top: 0; left: 0; right: 0; height: 100%;
      background: linear-gradient(to bottom, transparent, var(--violet), transparent);
      opacity: 0.3; pointer-events: none;
      animation: scan 2s linear infinite;
    }
    @keyframes pulse-violet {
      0% { box-shadow: 0 0 0 0 rgba(192, 132, 252, 0.4); }
      70% { box-shadow: 0 0 0 10px rgba(192, 132, 252, 0); }
      100% { box-shadow: 0 0 0 0 rgba(192, 132, 252, 0); }
    }
    .observer-active-ring {
      animation: pulse-violet 2s infinite;
    }
  `;

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER - Setup
  // ─────────────────────────────────────────────────────────────────────────

  if (phase === 'setup') return (
    <>
      <style>{CSS}</style>
      <div className="noise" />
      <div className="setup">
        <div className="fade" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div className="setup-eyebrow">Aria v4 · Professional Interview Intelligence</div>
          <h1 className="setup-title">Elevating technical<br />interview excellence.</h1>
          <p className="setup-sub">Natural, high-depth conversational evaluation with real-time candidate insights.</p>
        </div>

        <div className="grid2 fade">
          <div className="card">
            <div className="card-label">Candidate CV</div>
            {!cvText ? (<>
              <div className="drop" onClick={() => { const i = document.createElement('input'); i.type = 'file'; i.onchange = (e: any) => handleCvFile(e.target.files[0]); i.click(); }}>
                <div className="drop-icon">{isParsing ? <div className="spinner" /> : '📄'}</div>
                <div className="drop-main">{isParsing ? 'Parsing CV...' : 'Upload CV Document'}</div>
              </div>
              <textarea className="textarea" placeholder="Or paste text..." value={cvText} onChange={e => setCvText(e.target.value)} />
            </>) : (<>
              <div className="cv-ok"><div className="cv-ok-name">{cvFileName || 'CV loaded'}</div></div>
              <button className="btn btn-mute" onClick={() => setCvText('')}>Remove</button>
            </>)}
          </div>

          <div className="card">
            <div className="card-label">Evaluation Context (JD)</div>
            
            <div className="tab-row">
              <button className={`tab-btn ${jdTab === 'manual' ? 'on' : ''}`} onClick={() => setJdTab('manual')}>Manual Input</button>
              <button className={`tab-btn ${jdTab === 'templates' ? 'on' : ''}`} onClick={() => setJdTab('templates')}>Role Templates</button>
            </div>

            {jdTab === 'manual' ? (
              <textarea 
                className="textarea fade" 
                placeholder="Paste professional Job Description here..." 
                style={{ minHeight: 220 }} 
                value={jdText} 
                onChange={e => setJdText(e.target.value)} 
              />
            ) : (
              <div className="template-grid fade">
                {Object.entries(JD_TEMPLATES).map(([key, value]) => {
                  const icons: any = { frontend: '⚛️', backend: '⚙️', fullstack: '⚡', ai: '🧠', devops: '☁️', mobile: '📱', qa: '🧪' };
                  const names: any = { 
                    frontend: 'Frontend Expert', backend: 'Backend Architect', fullstack: 'Fullstack Lead',
                    ai: 'AI/ML Specialist', devops: 'DevOps/SRE', mobile: 'Mobile Architect', qa: 'QA Automation'
                  };
                  const isSelected = jdText === value;
                  return (
                    <div 
                      key={key} 
                      className={`template-card ${isSelected ? 'on' : ''}`}
                      onClick={() => { setJdText(value); setJdTab('manual'); }}
                    >
                      <div className="template-name">
                        <span style={{ fontSize: 14 }}>{icons[key] || '📋'}</span>
                        {names[key] || key}
                      </div>
                      <div className="template-role">Focus: {value.split('\n')[1].replace('Focus: ', '')}</div>
                    </div>
                  );
                })}
              </div>
            )}
            <input className="input" placeholder="Candidate Name (Optional)" value={candidateName} onChange={e => setCandidateName(e.target.value)} />

            <div className="card-label" style={{ marginTop: 10 }}>Total Questions</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {[3, 5, 10, 15].map(n => (
                <button
                  key={n} onClick={() => setNumQuestions(n)}
                  style={{
                    flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', transition: '.2s',
                    background: numQuestions === n ? 'var(--blue)' : 'var(--bg3)',
                    border: '1px solid ' + (numQuestions === n ? 'var(--blue)' : 'var(--line)'),
                    color: numQuestions === n ? 'white' : 'var(--text2)',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                  }}
                >
                  {n} Qs
                </button>
              ))}
            </div>

            <div className="card-label" style={{ marginTop: 15 }}>Time Limit (Mins)</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {[2, 5, 10, 15].map(m => (
                <button
                  key={m} onClick={() => setInterviewDuration(m)}
                  style={{
                    flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', transition: '.2s',
                    background: interviewDuration === m ? 'var(--blue)' : 'var(--bg3)',
                    border: '1px solid ' + (interviewDuration === m ? 'var(--blue)' : 'var(--line)'),
                    color: interviewDuration === m ? 'white' : 'var(--text2)',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                  }}
                >
                  {m}m
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="tags-row fade">
          <div className="feature-tag" style={{ color: '#60a5fa' }}>Universal Domain Adaptation</div>
          <div className="feature-tag" style={{ color: '#22c55e' }}>Phase-Strict Punisher Model</div>
          <div className="feature-tag" style={{ color: '#c084fc' }}>Silent Context Injection (No Freezes)</div>
          <div className="feature-tag" style={{ color: '#f59e0b' }}>The Soft "Clutch" Pattern</div>
        </div>

        {setupErr && <div className="err fade">{setupErr}</div>}
        <button className="start-btn fade" disabled={isParsing || (!cvText && !jdText)} onClick={() => { setSetupErr(''); setPhase('connecting'); startCall(); }}>
          Connect to Aria v4
        </button>
      </div>
    </>
  );

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER - Connecting / Report 
  // ─────────────────────────────────────────────────────────────────────────

  if (phase === 'connecting') return (
    <>
      <style>{CSS}</style>
      <div className="noise" />
      <div className="connecting">
        <div className="conn-inner fade">
          <div className="conn-ring">🎙️</div>
          <div className="conn-title">Booting Observer Architecture</div>
          <div className="conn-sub">Pre-processing context...</div>
        </div>
      </div>
    </>
  );

  if (phase === 'report') {
    const voiceCost = computeVoiceCost(usage);
    const intelCost = computeIntelCost(usage);
    const totalCost = computeCost(usage);

    return (
      <>
        <style>{CSS}</style>
        <div className="noise" />
        <div className="report-wrap">
          <div className="report fade">
          <div className="report-hero">
            <div className="report-title">Interview Report</div>
            {avgScore > 0 && <div className="report-avg" style={{ color: scoreColor(avgScore) }}>{avgScore.toFixed(1)}</div>}
          </div>
          <div className="report-stats">
            <div className="rstat"><div className="rstat-val">{scores.length}</div><div className="rstat-lbl">Answers</div></div>
            <div className="rstat"><div className="rstat-val">${computeVoiceCost(usage).toFixed(4)}</div><div className="rstat-lbl">Voice Engine</div></div>
            <div className="rstat"><div className="rstat-val">${computeIntelCost(usage).toFixed(4)}</div><div className="rstat-lbl">Intelligence</div></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--line)', background: 'var(--bg3)' }}>
            <div style={{ fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)' }}>ESTIMATED TOTAL SESSION COST:</div>
            <div style={{ fontSize: 11, color: 'var(--blue)', fontWeight: 700, fontFamily: 'var(--mono)' }}>${totalCost.toFixed(5)}</div>
          </div>
          {scores.length > 0 && (
            <div className="answers-section">
              {scores.map((s, i) => (
                <div className="answer-item" key={i}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text1)' }}>
                    {s.questionSummary || s.question}
                  </div>
                  {s.questionSummary && <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: -2 }}>Full: {s.question}</div>}
                  
                  <div style={{ display: 'flex', gap: 5, marginTop: 4 }}>
                    <ScoreBadge score={s.score} />
                    {s.depth && <DepthBadge level={s.depth} />}
                    {s.technicalAccuracy && (
                      <span className="metric-pill" style={{ background: 'var(--amber)11', color: 'var(--amber)' }}>
                        Accuracy: {s.technicalAccuracy}/10
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: 11, color: 'var(--text2)', borderLeft: '2px solid var(--line)', paddingLeft: 8, margin: '6px 0' }}>
                    {s.answerSummary}
                  </div>

                  {s.logicEvaluation && (
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                      <strong>Logic:</strong> {s.logicEvaluation}
                    </div>
                  )}

                  {s.missedOpportunities && s.missedOpportunities.length > 0 && (
                    <div style={{ marginTop: 6, padding: '6px 10px', background: 'var(--bg3)', borderRadius: 6 }}>
                      <div style={{ fontSize: 8, color: 'var(--amber)', fontWeight: 800, marginBottom: 4, letterSpacing: '.05em' }}>KEY OMISSIONS / TIPS</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                        {s.missedOpportunities.map((opt, idx) => (
                          <div key={idx} style={{ fontSize: 9, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ color: 'var(--amber)' }}>•</span> {opt}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                    {s.confidence && <span className="metric-pill">Conf: {s.confidence}</span>}
                    {s.grammar && <span className="metric-pill">Grammar: {s.grammar}</span>}
                    {s.clarity && <span className="metric-pill">Clarity: {s.clarity}</span>}
                    {s.depthStr && <span className="metric-pill">Depth: {s.depthStr}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ padding: 20, textAlign: 'center' }}>
            <button className="restart-btn" onClick={() => window.location.reload()}>Restart</button>
          </div>
        </div>
      </div>
    </>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER - Live Session
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{CSS}</style>
      <div className="noise" />
      <div className="live">

        {/* LEFT PANEL */}
        <div className="live-left">
          <div className="agent-top" style={{ flexShrink: 0 }}>
            <div className={`avatar${isSpeaking ? ' speaking' : isBridging ? ' bridging' : isThinking ? ' thinking' : ''}`}>🎙️</div>
            <div style={{ textAlign: 'center' }}><div className="agent-name">Aria</div><div style={{ fontSize: 9, color: 'var(--text3)' }}>v4 OBSERVER ARCHITECTURE</div></div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: '100%' }}>
              <div className="status-pill" style={{ background: isSpeaking ? 'rgba(59,123,255,.12)' : 'rgba(255,255,255,.04)', color: isSpeaking ? '#60a5fa' : 'var(--text2)', width: '100%', justifyContent: 'center' }}>
                {isBridging ? 'Bridging...' : isThinking ? 'Strategizing...' : isCvLooking ? 'Searching CV...' : isCvAnalyzing ? 'CV Deep-Dive...' : callStatus}
              </div>

              {silenceTimeLeft !== null && !isSpeaking && (
                <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--text3)', fontFamily: 'var(--mono)', textTransform: 'uppercase' }}>
                    <span>Silence Timer</span>
                    <span>{(silenceTimeLeft! / 1000).toFixed(1)}s</span>
                  </div>
                  <div style={{ height: 2, background: 'var(--line)', borderRadius: 1, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', background: silenceTimeLeft! < 5000 ? 'var(--red)' : 'var(--blue)',
                      width: `${(silenceTimeLeft! / silenceDurationRef.current) * 100}%`,
                      transition: 'width 0.1s linear, background 0.3s'
                    }} />
                  </div>
                </div>
              )}
            </div>

            <div className="wave">
              {waveHeights.map((h, i) => <div key={i} className="wbar" style={{ height: h, background: isSpeaking ? 'var(--blue)' : 'var(--line2)' }} />)}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            <div className="tier-wrap">
              <div className="tier-hd"><span style={{ fontSize: 9, color: 'var(--text3)' }}>ARCHITECTURE</span></div>
              <div className={`tier-row${isSpeaking ? ' on' : ''}`}>
                <div className="tdot" style={{ background: '#22c55e' }} />
                <div style={{ flex: 1 }}><div style={{ fontSize: 11, fontWeight: 600 }}>The Actor (RT)</div><div style={{ fontSize: 9, color: 'var(--text3)' }}>Pure natural voice pipe</div></div>
              </div>
              <div className={`tier-row${isObserverActive ? ' on observer-active-ring' : ''}`} style={{ position: 'relative', overflow: 'hidden' }}>
                {isObserverActive && <div className="scanner-line" />}
                <div className="tdot" style={{ background: '#c084fc', boxShadow: isObserverActive ? '0 0 8px #c084fc' : 'none' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 11, fontWeight: 600 }}>
                      {phaseRef.current === 'interview' ? 'Domain Observer' : phaseRef.current === 'closing' ? 'Closing Observer' : 'Warmup Observer'}
                    </div>
                    {isObserverActive && (
                      <span style={{ fontSize: 8, color: '#c084fc', fontWeight: 800, fontFamily: 'var(--mono)', letterSpacing: '.05em' }}>
                        {observerActivity.toUpperCase()}...
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text3)' }}>Strict phase & rule punisher</div>
                </div>
              </div>
            </div>

            {phase === 'interview' && (
              <div className="depth-wrap fade">
                <div className="depth-label">
                  <span style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 700, letterSpacing: '.05em' }}>DOMAIN COMPLEXITY</span>
                  <span style={{ fontSize: 10, color: 'var(--cyan)', fontWeight: 800, fontFamily: 'var(--mono)' }}>LVL {currentDepth}</span>
                </div>
                <div className="depth-dots">
                  <div className={`depth-dot ${currentDepth >= 1 ? 'on' : ''}`} />
                  <div className={`depth-dot ${currentDepth >= 2 ? 'on' : ''}`} />
                  <div className={`depth-dot ${currentDepth >= 3 ? 'on' : ''}`} />
                </div>
                <div style={{ marginTop: 8, fontSize: 8, color: 'var(--text3)', fontFamily: 'var(--mono)', textTransform: 'uppercase' }}>
                  {currentDepth === 3 ? 'Complex Scenarios & Edge Cases' : currentDepth === 2 ? 'Applied Scenario' : 'Foundational Concept'}
                </div>
              </div>
            )}

            {lastObserverAnalysis && (
              <div className="intel-feed" style={{ borderColor: 'var(--violet)44', background: 'var(--violet)05' }}>
                <div className="intel-hd" style={{ borderBottomColor: 'var(--violet)22' }}>
                  <span style={{ fontSize: 9, color: 'var(--violet)', fontWeight: 700 }}>LIVE OBSERVER ANALYSIS</span>
                </div>
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 9, color: 'var(--text3)' }}>PHASE ADVANCE:</span>
                    <span style={{ fontSize: 9, color: lastObserverAnalysis!.suggested_phase_advance !== 'none' ? 'var(--green)' : 'var(--text3)' }}>
                      {lastObserverAnalysis!.suggested_phase_advance.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 9, color: 'var(--text3)' }}>TOPIC EXHAUSTED:</span>
                    <span style={{ fontSize: 9, color: lastObserverAnalysis!.topic_exhausted ? 'var(--amber)' : 'var(--text3)' }}>
                      {lastObserverAnalysis!.topic_exhausted ? 'YES' : 'NO'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 9, color: 'var(--text3)' }}>SUBSTANTIVE ANSWER:</span>
                    <span style={{ fontSize: 9, color: lastObserverAnalysis!.is_substantive_answer ? 'var(--blue)' : 'var(--text3)' }}>
                      {lastObserverAnalysis!.is_substantive_answer ? 'YES' : 'NO'}
                    </span>
                  </div>
                  {lastObserverAnalysis!.ai_rambling && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 9, color: 'var(--text3)' }}>AI RAMBLING:</span>
                      <span style={{ fontSize: 9, color: 'var(--red)', fontWeight: 800 }}>TRUE</span>
                    </div>
                  )}
                  {lastObserverAnalysis!.answer_summary && (
                    <div style={{ borderTop: '1px solid var(--violet)22', marginTop: 4, paddingTop: 6 }}>
                      <div style={{ fontSize: 8, color: 'var(--text3)', marginBottom: 2 }}>CANDIDATE SUMMARY:</div>
                      <div style={{ fontSize: 10, color: 'var(--text2)', fontStyle: 'italic', lineHeight: 1.4 }}>"{lastObserverAnalysis!.answer_summary}"</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {scores.length > 0 && scores[scores.length - 1].logicEvaluation && (
              <div className="intel-feed" style={{ borderColor: 'var(--amber)44', background: 'var(--amber)05' }}>
                <div className="intel-hd" style={{ borderBottomColor: 'var(--amber)22' }}>
                  <span style={{ fontSize: 9, color: 'var(--amber)', fontWeight: 700 }}>PREMIUM TECHNICAL INSIGHT</span>
                </div>
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 600 }}>
                    Logic: <span style={{ fontWeight: 400, color: 'var(--text3)' }}>{scores[scores.length - 1].logicEvaluation}</span>
                  </div>
                  {scores[scores.length - 1].missedOpportunities && scores[scores.length - 1].missedOpportunities!.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      <div style={{ fontSize: 8, color: 'var(--amber)', fontWeight: 700, marginBottom: 4 }}>MISSED OPPORTUNITIES:</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {scores[scores.length - 1].missedOpportunities!.map((opt, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--amber)' }} />
                            <span style={{ fontSize: 9, color: 'var(--text2)' }}>{opt}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {queuedCvProjects.length > 0 && (
              <div className="intel-feed" style={{ borderColor: 'var(--green)33', background: 'var(--green)04' }}>
                <div className="intel-hd" style={{ borderBottomColor: 'var(--green)22' }}>
                  <span style={{ fontSize: 9, color: 'var(--green)', fontWeight: 700 }}>CV FOLLOW-UPS</span>
                </div>
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {queuedCvProjects.map((p, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--green)' }} />
                      <span style={{ fontSize: 10, color: 'var(--text2)' }}>{p}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {lastInjection && (
              <div className="intel-feed" style={{ borderColor: 'var(--blue)44', background: 'var(--blue)05' }}>
                <div className="intel-hd" style={{ borderBottomColor: 'var(--blue)22' }}>
                  <span style={{ fontSize: 9, color: 'var(--blue)', fontWeight: 700 }}>SILENT DIRECTIVE QUEUED</span>
                </div>
                <div style={{ padding: '8px 12px' }}>
                  <div style={{ fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)', lineHeight: 1.5 }}>
                    {lastInjection}
                  </div>
                </div>
              </div>
            )}

            {intelLog.length > 0 && (
              <div className="intel-feed">
                <div className="intel-hd"><span style={{ fontSize: 9, color: 'var(--text3)' }}>Observer Log</span></div>
                {intelLog.map((log) => (
                  <div key={log.id} className="intel-row">
                    <div className="intel-icon" style={{ color: log.status === 'active' ? '#60a5fa' : '#94a3b8' }}>⚡</div>
                    <div style={{ fontSize: 10, color: log.status === 'error' ? 'var(--red)' : 'var(--text2)' }}>{log.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="controls">
            <button className={`btn btn-mute${isMuted ? ' btn-muted' : ''}`} onClick={toggleMute}>{isMuted ? 'Unmute' : 'Mute'}</button>
            <button className="btn btn-end" onClick={endCall}>End</button>
          </div>
        </div>

        {/* CENTER PANEL */}
        <div className="live-center">
          <div className="phase-strip">
            <div className="phase-flow">
              {(['greeting', 'warmup', 'interview', 'wrapup', 'closing'] as AppPhase[]).map((p, i) => (
                <Fragment key={p}>
                  {i > 0 && <div className="phase-sep" />}
                  <PhaseDot phase={p} current={phase} label={phaseLabel[p]} />
                </Fragment>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {phase === 'warmup' && (
                <div className="q-counter fade">
                  <div style={{ fontSize: 9, color: 'var(--text3)' }}>WARMUP</div>
                  <div className="q-count-val">{warmupCount}</div>
                  <div className="q-count-total">/ {WARMUP_QUESTIONS_REQUIRED}</div>
                </div>
              )}
              {phase === 'interview' && (
                <div className="q-counter fade">
                  <div style={{ fontSize: 9, color: 'var(--text3)' }}>SCORED</div>
                  <div className="q-count-val">{scores.length}</div>
                  <div className="q-count-total">/ {numQuestions}</div>
                </div>
              )}
              {phase === 'interview' && <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: timerColor }}>{fmtTime(interviewTimeLeft)}</div>}
            </div>
          </div>

          <div className="center-head">
            <div className="center-title">Live Interview · {candidateName || 'Candidate'}</div>
            {avgScore > 0 && <div style={{ fontSize: 12, color: '#f59e0b', fontFamily: 'var(--mono)' }}>Avg: {avgScore.toFixed(1)}</div>}
          </div>

          {currentQ && phase === 'interview' && (
            <div className="cur-q">
              <div style={{ fontSize: 9, color: 'var(--blue)', marginBottom: 5 }}>Current Question</div>
              <div style={{ fontSize: 13 }}>{currentQ}</div>
            </div>
          )}

          <div className="center-body" style={{ position: 'relative' }}>
            {isCallEnded && (
              <div className="fade" style={{
                position: 'absolute', inset: 0, zIndex: 10,
                background: 'rgba(7, 11, 18, 0.9)', backdropFilter: 'blur(10px)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24,
                padding: 40, textAlign: 'center'
              }}>
                <div style={{ width: 60, height: 60, borderRadius: '50%', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>✅</div>
                <div>
                  <h2 style={{ fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Interview Concluded</h2>
                  <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.6, maxWidth: 300, margin: '0 auto' }}>
                    Great job! The AI has finished the session. Click below to see your detailed breakdown and score.
                  </p>
                </div>
                <button className="start-btn" style={{ maxWidth: 280 }} onClick={() => { phaseRef.current = 'report'; setPhase('report'); }}>
                  View Performance Report
                </button>
              </div>
            )}
            {activeLogs.length === 0 ? <div style={{ textAlign: 'center', padding: 20, color: 'var(--text3)' }}>Waiting to begin...</div> :
              activeLogs.slice(-15).map((log, i) => (
                <div key={i} className="log-entry">
                  <div className={`log-av ${log.role}`}>{log.role === 'ai' ? 'AI' : 'You'}</div>
                  <div className={`log-text ${log.pending ? 'pending' : ''}`}>{log.text || '...'}</div>
                </div>
              ))
            }
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="live-right">
          <div className="rp-head" style={{ padding: '20px 20px 10px', fontSize: 14, fontWeight: 600 }}>Live Evaluation</div>
          {scores.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>Scores appear after answers...</div> :
            [...scores].reverse().map((s, i) => (
              <div className="score-card" key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div className="sc-q">Q: {s.question.length > 50 ? s.question.slice(0, 50) + '...' : s.question}</div>
                  <ScoreBadge score={s.score} />
                </div>
                <div className="sc-a">↳ {s.answerSummary.slice(0, 80)}...</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                  {s.confidence && <span className="metric-pill">Conf: {s.confidence}</span>}
                  {s.grammar && <span className="metric-pill">Grammar: {s.grammar}</span>}
                  {s.clarity && <span className="metric-pill">Clarity: {s.clarity}</span>}
                  {s.depthStr && <span className="metric-pill">Depth: {s.depthStr}</span>}
                </div>
              </div>
            ))
          }
        </div>

      </div>
    </>
  );
}