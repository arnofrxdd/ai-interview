'use client';

/**
 * ARIA v8 — Speaker-First Architecture
 * ════════════════════════════════════════════════════════════════
 *
 * PHILOSOPHY:
 * ───────────
 * The voice agent IS the interviewer. It knows everything.
 * It receives a rich, complete context packet every time the user speaks.
 * It decides when to dig deeper, pivot, or advance — like a real human.
 *
 * Background agents do ONE job each:
 *   • Scorer: Score technical answers silently, no interaction
 *   • Behavior Tracker: Detect mood/soft-skills from transcript patterns
 *
 * FLOW PER TURN:
 * ──────────────
 *   [User speaks → final transcript arrives]
 *         ↓
 *   [Build FULL_CONTEXT_PACKET]
 *     - Last 12 conversation turns
 *     - Full topic list with status, turn counts, rubrics
 *     - Phase, time remaining, mood intel
 *     - Explicit interviewer persona + tone
 *         ↓
 *   [Push packet to LiveKit agent via attributes]
 *         ↓
 *   [Voice agent speaks naturally — decides everything]
 *         ↓
 *   [In parallel: Scorer + Behavior agents run silently]
 *         ↓
 *   [Scores + behavior update UI — no impact on voice flow]
 *
 * WARMUP REALITY:
 * ───────────────
 *   - 2 turns of genuine personal conversation
 *   - Aria asks about their day, background, what they're excited about
 *   - Bridges ORGANICALLY into first technical topic (no announcement)
 *
 * NO CONDUCTOR BLOCKING:
 * ──────────────────────
 *   - Voice agent responds immediately with full context
 *   - Scoring is fire-and-forget (non-blocking)
 *   - Zero latency on user → AI response
 */

import {
  useState, useEffect, useRef, useCallback, Fragment
} from 'react';
import {
  Room,
  RoomEvent,
  Participant,
  TranscriptionSegment,
} from 'livekit-client';
import { ARIA_PROMPTS, PERSONA_PROMPTS } from '../lib/prompts';
import {
  LiveKitRoom,
  RoomAudioRenderer,
} from '@livekit/components-react';
import { AriaPremiumUI } from './AriaPremium';

// ─── Constants ──────────────────────────────────────────────────────────────

const SHOW_DEBUG_UI = false; // 🚨 SET TO TRUE TO ENABLE SIDEBARS & METRICS

const WARMUP_TURNS = 2;
const WRAPUP_TURNS = 3;
const MAX_TOPIC_TURNS = 5;
const SILENCE_TIMEOUT_MS = 20000;
const SILENCE_POLL_MS = 200;
const SPEAKING_COOLDOWN_MS = 700;

const PRICE = { miniIn: 0.15, miniOut: 0.60 } as const;

const JD_TEMPLATES: Record<string, string> = {
  frontend: `Role: Senior Frontend Engineer\nStack: React.js, TypeScript, Next.js, CSS Architecture, Web Performance, Accessibility.\nExpectations: Build modular, high-performance UIs. Deep understanding of React hooks, state management, rendering optimizations.`,
  backend: `Role: Senior Backend Engineer\nStack: Node.js, Go, Microservices, PostgreSQL, Redis, System Design.\nExpectations: Design robust APIs and distributed systems. Performance, data integrity, and high throughput.`,
  fullstack: `Role: Senior Fullstack Developer\nStack: Next.js, tRPC, Prisma, PostgreSQL, React, Tailwind CSS.\nExpectations: End-to-end features. Clean architecture, type safety, seamless UI/UX.`,
  ai: `Role: AI/ML Engineer\nStack: Python, PyTorch, LangChain, Transformers, Vector DBs, RAG pipelines.\nExpectations: LLM-based applications. Prompt engineering, fine-tuning, scalable inference pipelines.`,
  devops: `Role: DevOps/SRE Engineer\nStack: AWS, Kubernetes, Terraform, Docker, CI/CD, Observability.\nExpectations: Scalable cloud infrastructure. Automation, reliability, security of distributed systems.`,
  mobile: `Role: Senior Mobile Developer\nStack: React Native, Swift, Kotlin, App Store deployment.\nExpectations: Cross-platform applications with smooth animations and offline-first logic.`,
};

// ─── Types ───────────────────────────────────────────────────────────────────

type AppPhase = 'setup' | 'connecting' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'ended' | 'report';
type TopicStatus = 'pending' | 'active' | 'covered' | 'exhausted';
export type Topic = {
  id: string;
  name: string;
  source: 'cv' | 'jd' | 'profile';
  rubric: string;
  pressurePoints: string[];
  openingDirective: string;
  status: TopicStatus;
  turnCount: number;
  score?: number;
  summaries: string[];
};

export type ScoreEntry = {
  topicId: string;
  topicName: string;
  question: string;
  summary: string;
  score: number;
  feedback: string;
  depth: 'deep' | 'adequate' | 'shallow';
  accuracy: number;
};

export type ConvEntry = {
  id: string;
  role: 'user' | 'ai' | 'system';
  text: string;
  ts: number;
  topicId?: string;
};

export type BehaviorState = {
  candidateMood: string;
  ariaMood: 'warm' | 'neutral' | 'direct';
  softSkills: number;
  communication: number;
  confidence: number;
};

export type Usage = { tokIn: number; tokOut: number };

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const fmtTime = (s: number) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
const scoreColor = (s: number) => s >= 8 ? '#4ade80' : s >= 6 ? '#fbbf24' : s >= 4 ? '#f97316' : '#f87171';
const cost = (u: Usage) => ((u.tokIn * PRICE.miniIn + u.tokOut * PRICE.miniOut) / 1_000_000).toFixed(4);

const safeJson = (raw: string): any => {
  try {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s === -1 || e === -1) return {};
    return JSON.parse(raw.substring(s, e + 1));
  } catch { return {}; }
};

async function extractText(file: File): Promise<string> {
  if (file.type === 'application/pdf') {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/ai-interview/api/extract-pdf', { method: 'POST', body: fd });
    const d = await r.json();
    return (d.text as string || '').slice(0, 50000);
  }
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).slice(0, 50000));
    r.onerror = rej;
    r.readAsText(file);
  });
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function callLLM(
  system: string,
  user: string,
  usageRef: React.MutableRefObject<Usage>,
  json = false
): Promise<string> {
  const body: any = {
    systemInstruction: system,
    query: user,
    complexity: 'moderate',
    temperature: 0.0,
    top_p: 0.1,
  };
  if (json) body.responseFormat = 'json_object';

  const res = await fetch('/ai-interview/api/escalate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await res.json();
  if (d.usage) {
    usageRef.current.tokIn += d.usage.prompt_tokens || 0;
    usageRef.current.tokOut += d.usage.completion_tokens || 0;
  }
  return (d.answer as string) || '';
}

// ─── CONTEXT PACKET BUILDER ───────────────────────────────────────────────────
// This is the heart of v8. The speaker gets EVERYTHING.

// ─── CONTEXT PACKET BUILDER ───────────────────────────────────────────────────
// This is the heart of v8. The speaker gets EVERYTHING.

function buildContextPacket(params: {
  phase: AppPhase;
  candidateName: string;
  cvSummary: string;
  jdText: string;
  topics: any[];
  conv: any[];
  behavior: any;
  warmupTurns: number;
  wrapupTurns: number;
  timeLeftSecs: number;
  totalTimeSecs: number;
  prompts: any;
}): string {
  const {
    phase, candidateName, cvSummary, topics,
    conv, warmupTurns, wrapupTurns, prompts
  } = params;

  const pName = prompts.PERSONA.name;
  const pTitle = prompts.PERSONA.title;

  const name = candidateName || 'the candidate';
  const activeTopic = topics.find(t => t.status === 'active');

  const recentConv = conv.slice(-8).map(c =>
    `${c.role === 'ai' ? pName.toUpperCase() : 'CANDIDATE'}: ${c.text}`
  ).join('\n');

  // Single active topic for AI visibility
  const activeTopicInfo = activeTopic
    ? `TOPIC: "${activeTopic.name}" [ACTIVE]`
    : '(No active topic)';

  const universalRules = prompts.UNIVERSAL_RULES;

  const contextBase = `${prompts.ROLE_HEADER.replace('${personaName}', pName).replace('${personaTitle}', pTitle)}
CANDIDATE: ${name}${phase === 'warmup' ? '' : `\nCV: ${cvSummary}`}

=== ACTIVE TOPIC ===
${['wrapup', 'closing', 'ended'].includes(phase) ? 'TECHNICAL EVALUATION COMPLETE' : (phase === 'warmup' ? '(Hidden until Technical Evaluation begins)' : activeTopicInfo)}

=== RECENT CONVERSATION ===
${recentConv || '(Conversation just started)'}`;

  // ---------------------------------------------------------
  // PHASE: WARMUP
  // ---------------------------------------------------------
  if (phase === 'warmup') {
    const isStart = warmupTurns === 0;
    const task = isStart
      ? prompts.WARMUP_GREETING
        .replace('${candidateName}', name)
        .replace('${personaName}', pName)
      : prompts.WARMUP_FOLLOWUP;

    return `${contextBase}

${universalRules}

${prompts.WARMUP_STATIC.replace('${task}', task)}`;
  }

  // ---------------------------------------------------------
  // PHASE: INTERVIEW
  // ---------------------------------------------------------
  if (phase === 'interview') {
    const isTopicChange = activeTopic?.turnCount === 0;
    const pressurePoints = activeTopic?.pressurePoints?.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n') || '';

    // This explicit block stops the AI from getting stuck on old topics
    const actionBlock = isTopicChange
      ? prompts.INTERVIEW_TOPIC_CHANGE
        .replace('${topicName}', activeTopic?.name || '')
        .replace('${openingDirective}', activeTopic?.openingDirective || '')
      : prompts.INTERVIEW_STRATEGY
        .replace('${topicName}', activeTopic?.name || '')
        .replace('${rubric}', activeTopic?.rubric || '')
        .replace('${pressurePoints}', pressurePoints);

    return `${contextBase}

${universalRules}

${actionBlock}

${prompts.INTERVIEW_STATIC}`;
  }

  // ---------------------------------------------------------
  // PHASE: WRAPUP
  // ---------------------------------------------------------
  if (phase === 'wrapup') {
    const task = wrapupTurns === 0
      ? prompts.WRAPUP_INIT
      : prompts.WRAPUP_FOLLOWUP;

    return `${contextBase}

${universalRules}

${prompts.WRAPUP_STATIC.replace('${task}', task)}`;
  }

  // ---------------------------------------------------------
  // PHASE: CLOSING
  // ---------------------------------------------------------
  if (phase === 'closing') {
    return prompts.CLOSING_DIRECTIVE
      .replace('${name}', pName)
      .replace('${candidateName}', name);
  }

  return '';
}
// ─── TOPIC GENERATOR ─────────────────────────────────────────────────────────

async function generateTopics(
  cvText: string,
  jdText: string,
  numTopics: number,
  usageRef: React.MutableRefObject<Usage>,
  prompts: any
): Promise<Topic[]> {
  const raw = await callLLM(
    prompts.GEN_TOPICS_SYSTEM,
    prompts.GEN_TOPICS_USER
      .replace('${numTopics}', numTopics.toString())
      .replace('${cvText}', cvText)
      .replace('${jdText}', jdText.slice(0, 1500)),
    usageRef,
    true
  );

  const parsed = safeJson(raw);
  const raw_topics = (parsed.topics || []).slice(0, numTopics);

  const entries: Topic[] = raw_topics.map((t: any, i: number) => ({
    id: uid(),
    name: t.name || `Topic ${i + 1}`,
    source: ['cv', 'jd', 'profile'].includes(t.source) ? t.source : 'jd',
    rubric: t.rubric || 'Assess technical knowledge',
    pressurePoints: t.pressurePoints || [],
    openingDirective: t.openingDirective || `Attack their claims regarding ${t.name}.`,
    status: i === 0 ? 'active' : 'pending',
    turnCount: 0,
    summaries: [],
  }));

  if (entries.length === 0) {
    return [
      { id: uid(), name: 'Academic Validation', source: 'profile', rubric: 'Core profile assessment', pressurePoints: ['mediocre fundamentals', 'justifying timeline gaps'], openingDirective: 'Interrogate the discrepancy between their claimed seniority and their academic history.', status: 'active', turnCount: 0, summaries: [] },
      { id: uid(), name: 'Recent Project', source: 'cv', rubric: 'Real-world engineering judgment', pressurePoints: ['architecture decisions', 'scaling limitations'], openingDirective: 'Attack the complexity of their most recent project. Demand they explain the hardest technical trade-off they made.', status: 'pending', turnCount: 0, summaries: [] },
    ];
  }

  return entries;
}
// ─── BACKGROUND SCORER (fire-and-forget) ────────────────────────────────────

async function scoreAnswer(params: {
  topic: Topic;
  question: string;
  answer: string;
  usageRef: React.MutableRefObject<Usage>;
  prompts: any;
}): Promise<ScoreEntry | null> {
  const { topic, question, answer, usageRef, prompts } = params;
  if (answer.trim().length < 10) return null;

  try {
    const raw = await callLLM(
      prompts.SCORE_ANSWER_SYSTEM,
      prompts.SCORE_ANSWER_USER
        .replace('${topicName}', topic.name)
        .replace('${rubric}', topic.rubric)
        .replace('${answer}', answer),
      usageRef,
      true
    );
    const d = safeJson(raw);
    if (!d.score && d.score !== 0) return null;

    return {
      topicId: topic.id,
      topicName: topic.name,
      question,
      summary: d.summary || answer.slice(0, 80),
      score: d.score,
      feedback: d.feedback || '',
      depth: d.depth || 'adequate',
      accuracy: d.accuracy || d.score,
    };
  } catch { return null; }
}

// ─── BACKGROUND BEHAVIOR TRACKER (fire-and-forget) ──────────────────────────

async function trackBehavior(
  recentConv: string,
  current: BehaviorState,
  usageRef: React.MutableRefObject<Usage>,
  prompts: any
): Promise<Partial<BehaviorState>> {
  try {
    const raw = await callLLM(
      prompts.TRACK_BEHAVIOR_SYSTEM,
      prompts.TRACK_BEHAVIOR_USER.replace('${recentConv}', recentConv),
      usageRef,
      true
    );
    return safeJson(raw);
  } catch { return {}; }
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function AriaV8() {

  // Setup state
  const [phase, setPhase] = useState<AppPhase>('setup');
  const [cvText, setCvText] = useState('');
  const [cvFileName, setCvFileName] = useState('');
  const [jdText, setJdText] = useState('');
  const [candidateName, setCandidateName] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [setupErr, setSetupErr] = useState('');
  const [numTopics, setNumTopics] = useState(5);
  const [duration, setDuration] = useState(10); // minutes
  const [jdTab, setJdTab] = useState<'manual' | 'templates'>('manual');
  const [selectedTmpl, setSelectedTmpl] = useState('');
  const [voice, setVoice] = useState('asteria');

  // Live state
  const [isCallActive, setIsCallActive] = useState(false);
  const [isCallEnded, setIsCallEnded] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [timeLeft, setTimeLeft] = useState(600);
  const [warmupTurns, setWarmupTurns] = useState(0);
  const [wrapupTurns, setWrapupTurns] = useState(0);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [conv, setConv] = useState<ConvEntry[]>([]);
  const [behavior, setBehavior] = useState<BehaviorState>({ candidateMood: 'neutral', ariaMood: 'neutral', softSkills: 5, communication: 5, confidence: 5 });
  const [hasAriaGreeted, setHasAriaGreeted] = useState(false);
  const [isAriaSpeaking, setIsAriaSpeaking] = useState(false);
  const [isAriaThinking, setIsAriaThinking] = useState(false);
  const [isScoringBg, setIsScoringBg] = useState(false);
  const [callStatus, setCallStatus] = useState('Ready');
  const [usage, setUsage] = useState<Usage>({ tokIn: 0, tokOut: 0 });
  const [silenceLeft, setSilenceLeft] = useState<number | null>(null);
  const [statusLogs, setStatusLogs] = useState<{ id: string; msg: string; ok?: boolean }[]>([]);
  const [liveContext, setLiveContext] = useState('');
  const [liveTranscript, setLiveTranscript] = useState<{ role: 'ai' | 'user', text: string } | null>(null);

  // LiveKit
  const [lkToken, setLkToken] = useState<string | null>(null);
  const [lkRoom, setLkRoom] = useState<Room | null>(null);

  // ── Refs ──
  const phaseRef = useRef<AppPhase>('setup');
  const topicsRef = useRef<Topic[]>([]);
  const scoresRef = useRef<ScoreEntry[]>([]);
  const convRef = useRef<ConvEntry[]>([]);
  const behaviorRef = useRef<BehaviorState>({ candidateMood: 'neutral', ariaMood: 'neutral', softSkills: 5, communication: 5, confidence: 5 });
  const usageRef = useRef<Usage>({ tokIn: 0, tokOut: 0 });
  const lkRoomRef = useRef<Room | null>(null);
  const candidateNameRef = useRef('');
  const cvSummaryRef = useRef('');
  const jdTextRef = useRef('');
  const numTopicsRef = useRef(5);
  const totalTimeSecsRef = useRef(600);
  const elapsedMsRef = useRef(0);
  const warmupTurnsRef = useRef(0);
  const wrapupTurnsRef = useRef(0);
  const lastAiTextRef = useRef('');
  const lastUserTextRef = useRef('');
  const isAriaSpeakingRef = useRef(false);
  const speakingCooldownRef = useRef(false);
  const speakingCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceStartRef = useRef(0);
  const silenceCountRef = useRef(0);
  const isEndingRef = useRef(false);
  const isStartingRef = useRef(false);
  const interviewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const userTurnDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedSegmentsRef = useRef(new Set<string>());
  const scoringInFlightRef = useRef(false);
  const isFirstTurnRef = useRef(true);
  // 🚨 ADD THIS: Lock to prevent double-counting turns
  const turnCountedRef = useRef(false);
  const activeUserMsgIdRef = useRef<string | null>(null);
  const lastUserMsgTsRef = useRef<number>(0);
  const lastRoleRef = useRef<'user' | 'ai'>('ai');
  const hasAriaGreetedRef = useRef(false);
  const voiceRef = useRef(voice);

  // ── Sync refs ──
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { topicsRef.current = topics; }, [topics]);
  useEffect(() => { scoresRef.current = scores; }, [scores]);
  useEffect(() => { convRef.current = conv; }, [conv]);
  useEffect(() => { behaviorRef.current = behavior; }, [behavior]);
  useEffect(() => { voiceRef.current = voice; }, [voice]);
  useEffect(() => { lkRoomRef.current = lkRoom; }, [lkRoom]);
  useEffect(() => { jdTextRef.current = jdText; }, [jdText]);
  useEffect(() => { candidateNameRef.current = candidateName; }, [candidateName]);
  useEffect(() => { numTopicsRef.current = numTopics; }, [numTopics]);

  const slog = useCallback((msg: string, ok?: boolean) => {
    const id = uid();
    setStatusLogs(prev => [{ id, msg, ok }, ...prev].slice(0, 10));
  }, []);

  // ── Push instructions to LiveKit agent ──
  const pushContext = useCallback((ctx: string, isStart: boolean = false) => {
    const room = lkRoomRef.current;
    if (!room || room.state !== 'connected') return;
    setLiveContext(ctx);
    room.localParticipant.setAttributes({
      instructions: ctx,
      sync_id: `${Date.now()}`,
      is_start: isStart ? "true" : "false",
      voice: (voiceRef as any).current || voice,
    });
  }, []);

  // ── Build and push full context for current state ──
  const pushFullContext = useCallback(() => {
    const activePrompts = PERSONA_PROMPTS[voiceRef.current] || ARIA_PROMPTS;
    const ctx = buildContextPacket({
      phase: phaseRef.current,
      candidateName: candidateNameRef.current,
      cvSummary: cvSummaryRef.current,
      jdText: jdTextRef.current,
      topics: topicsRef.current,
      conv: convRef.current,
      behavior: behaviorRef.current,
      warmupTurns: warmupTurnsRef.current,
      wrapupTurns: wrapupTurnsRef.current,
      timeLeftSecs: totalTimeSecsRef.current - Math.floor(elapsedMsRef.current / 1000),
      totalTimeSecs: totalTimeSecsRef.current,
      prompts: activePrompts,
    });
    const isStart = phaseRef.current === 'warmup' && warmupTurnsRef.current === 0;
    pushContext(ctx, isStart);
  }, [pushContext]);

  useEffect(() => {
    if (isCallActive) {
      slog(`Voice changed to ${voice} — Syncing...`, true);
      pushFullContext();
    }
  }, [voice, isCallActive, pushFullContext, slog]);

  // ── Silence timer ──
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) { clearInterval(silenceTimerRef.current); silenceTimerRef.current = null; }
    setSilenceLeft(null);
  }, []);

  const endCall = useCallback(() => {
    if (isEndingRef.current) return;
    isEndingRef.current = true;
    clearSilenceTimer();
    if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);
    if (speakingCooldownTimerRef.current) clearTimeout(speakingCooldownTimerRef.current);
    lkRoomRef.current?.disconnect();
    setLkRoom(null);
    setLkToken(null);
    setIsCallActive(false);
    setIsCallEnded(true);
    setCallStatus('Ended');
    phaseRef.current = 'report';
    setPhase('report');
  }, [clearSilenceTimer]);

  const triggerHardReset = useCallback(() => {
    const room = lkRoomRef.current;
    if (!room || room.state !== 'connected') return;

    room.localParticipant.setAttributes({
      reset_chat: 'true',
      sync_id: `${Date.now()}_reset`,
    });

    slog('Hard Reset signal sent to agent', true);

    // Clear and re-push full context after a brief delay to ensure purge is processed
    setTimeout(() => {
      pushFullContext();
      // Unset the reset flag immediately so future updates aren't treated as resets
      room.localParticipant.setAttributes({ reset_chat: 'false' });
    }, 500);
  }, [pushFullContext, slog]);

  const startSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    if (isEndingRef.current) return;
    if (['setup', 'connecting', 'closing', 'ended', 'report'].includes(phaseRef.current)) return;

    silenceStartRef.current = Date.now();
    setSilenceLeft(SILENCE_TIMEOUT_MS);

    silenceTimerRef.current = setInterval(() => {
      if (isAriaSpeakingRef.current || speakingCooldownRef.current) {
        silenceStartRef.current = Date.now();
        return;
      }
      const elapsed = Date.now() - silenceStartRef.current;
      const remaining = Math.max(0, SILENCE_TIMEOUT_MS - elapsed);
      setSilenceLeft(remaining);

      if (remaining <= 0) {
        clearSilenceTimer();
        silenceCountRef.current++;
        if (silenceCountRef.current >= 3) { endCall(); return; }
        // Nudge via context
        const activePrompts = PERSONA_PROMPTS[voiceRef.current] || ARIA_PROMPTS;
        const nudge = activePrompts.SILENCE_NUDGE.replace('${name}', activePrompts.PERSONA.name);
        pushContext(nudge);
      }
    }, SILENCE_POLL_MS);
  }, [clearSilenceTimer, endCall, pushContext]);

  // ── Advance topic in state ──
  const advanceTopic = useCallback(() => {
    const updated = topicsRef.current.map(t => ({ ...t }));
    const activeIdx = updated.findIndex(t => t.status === 'active');
    if (activeIdx !== -1) {
      updated[activeIdx].status = 'covered';
      const nextIdx = updated.findIndex(t => t.status === 'pending');
      if (nextIdx !== -1) updated[nextIdx].status = 'active';
    }
    topicsRef.current = updated;
    setTopics([...updated]);
    return updated;
  }, []);

  // ── Background scoring (truly non-blocking) ──
  const triggerBackgroundScoring = useCallback((targetTopicId?: string) => {
    if (scoringInFlightRef.current) return;
    const activePrompts = PERSONA_PROMPTS[voiceRef.current] || ARIA_PROMPTS;
    const pName = activePrompts.PERSONA.name;
    const activeTopic = topicsRef.current.find(t =>
      targetTopicId ? t.id === targetTopicId : t.status === 'active'
    );
    if (!activeTopic) return;

    // Filter conversation to ONLY messages belonging to this topic
    const topicConv = convRef.current
      .filter(c => c.topicId === activeTopic.id)
      .map(c => `${c.role === 'ai' ? pName.toUpperCase() : 'CANDIDATE'}: ${c.text}`)
      .join('\n');

    if (!topicConv || topicConv.length < 20) return;

    scoringInFlightRef.current = true;
    setIsScoringBg(true);

    Promise.all([
      phaseRef.current === 'interview'
        ? scoreAnswer({
          topic: activeTopic,
          question: '(Derived from history)',
          answer: topicConv,
          usageRef,
          prompts: activePrompts,
        })
        : Promise.resolve(null),
      trackBehavior(
        convRef.current.slice(-8).map(c => `${c.role === 'ai' ? pName.toUpperCase() : 'CANDIDATE'}: ${c.text}`).join('\n'),
        behaviorRef.current,
        usageRef,
        activePrompts
      )
    ]).then(([score, beh]) => {
      if (score) {
        const updated = topicsRef.current.map(t =>
          t.id === score.topicId
            ? { ...t, summaries: [...t.summaries, score.summary], score: score.score }
            : t
        );
        topicsRef.current = updated;
        setTopics([...updated]);

        const existingIdx = scoresRef.current.findIndex(s => s.topicId === score.topicId);
        if (existingIdx !== -1) {
          const merged = {
            ...score,
            score: Math.round((scoresRef.current[existingIdx].score + score.score) / 2),
          };
          scoresRef.current = scoresRef.current.map((s, i) => i === existingIdx ? merged : s);
        } else {
          scoresRef.current = [...scoresRef.current, score];
        }
        setScores([...scoresRef.current]);
        slog(`Scored "${score.topicName}": ${score.score}/10`, true);

        // 🚨 MERCY KILL CHECK: If candidate fails 2+ topics completely, end technical part early
        const zeroCount = scoresRef.current.filter(s => s.score === 0).length;
        if (zeroCount >= 2 && phaseRef.current === 'interview') {
          phaseRef.current = 'wrapup';
          setPhase('wrapup');
          wrapupTurnsRef.current = 0;
          slog('MERCY KILL: Candidate failed multiple topics. Ending interview.', false);
          pushFullContext();
        }
      }

      if (beh && Object.keys(beh).length > 0) {
        const next = { ...behaviorRef.current, ...beh };
        behaviorRef.current = next;
        setBehavior({ ...next });
      }

      setUsage({ ...usageRef.current });
    }).catch(() => {
      slog('Background scoring failed', false);
    }).finally(() => {
      scoringInFlightRef.current = false;
      setIsScoringBg(false);
    });
  }, [slog]);

  // ── Process User Turn Logic ──
  const processUserTurn = useCallback(() => {
    const currentPhase = phaseRef.current;
    lastRoleRef.current = 'user';
    setIsAriaThinking(true);

    // 1. State & Transitions
    if (currentPhase === 'warmup') {
      // 🚨 ONLY INCREMENT ONCE PER TURN
      if (!turnCountedRef.current) {
        warmupTurnsRef.current += 1;
        setWarmupTurns(warmupTurnsRef.current);
        turnCountedRef.current = true;
      }

      if (warmupTurnsRef.current >= WARMUP_TURNS) {
        phaseRef.current = 'interview';
        setPhase('interview');
        slog('Warmup complete → Starting Technical Interview', true);
      }
      pushFullContext();

      // Fire scoring in background after small delay to let UI/attributes sync first
      setTimeout(() => triggerBackgroundScoring(), 100);
      return;
    }

    if (currentPhase === 'interview') {
      const updated = topicsRef.current.map(t => ({ ...t }));
      const activeIdx = updated.findIndex(t => t.status === 'active');

      if (activeIdx !== -1) {
        // 🚨 ONLY INCREMENT ONCE PER TURN
        if (!turnCountedRef.current) {
          updated[activeIdx].turnCount += 1;
          turnCountedRef.current = true;
        }

        // Check if we need to advance topic
        if (updated[activeIdx].turnCount >= MAX_TOPIC_TURNS) {
          updated[activeIdx].status = 'covered';
          const nextIdx = updated.findIndex(t => t.status === 'pending');
          if (nextIdx !== -1) {
            updated[nextIdx].status = 'active';
            slog(`Topic "${updated[activeIdx].name}" covered → Moving onto "${updated[nextIdx].name}"`, true);
          }
        }
      }

      topicsRef.current = updated;
      setTopics([...updated]);

      // Check if all technical topics done
      const allDone = updated.every(t => ['covered', 'exhausted'].includes(t.status));
      if (allDone) {
        phaseRef.current = 'wrapup';
        setPhase('wrapup');
        wrapupTurnsRef.current = 0;
        slog('Technical topics covered → Q&A Phase', true);
      }

      pushFullContext();

      // Fire scoring in background after small delay to let UI/attributes sync first
      setTimeout(() => triggerBackgroundScoring(), 100);
      return;
    }

    if (currentPhase === 'wrapup') {
      // 🚨 ONLY INCREMENT ONCE PER TURN
      if (!turnCountedRef.current) {
        wrapupTurnsRef.current += 1;
        setWrapupTurns(wrapupTurnsRef.current);
        turnCountedRef.current = true;
      }

      if (wrapupTurnsRef.current >= WRAPUP_TURNS) {
        phaseRef.current = 'closing';
        setPhase('closing');
        slog('Interview finished', true);
      }
      pushFullContext();

      // Fire scoring in background after small delay
      setTimeout(() => triggerBackgroundScoring(), 100);
      return;
    }
  }, [pushFullContext, triggerBackgroundScoring, slog]);

  // ── Handle transcript ──
  const handleTranscript = useCallback((
    text: string,
    isAgent: boolean,
    segId: string,
    segments: TranscriptionSegment[]
  ) => {
    if (!text.trim()) return;

    // Only process FINAL segments
    const isFinal = segments.every(s => s.final);
    if (!isFinal) return;

    // Dedup: skip if identical to last committed text
    if (!isAgent && text.trim() === lastUserTextRef.current.trim()) return;
    if (isAgent && text.trim() === lastAiTextRef.current.trim()) return;

    // Clear any pending debounce
    if (userTurnDebounceRef.current) {
      clearTimeout(userTurnDebounceRef.current);
      userTurnDebounceRef.current = null;
    }

    const now = Date.now();
    const activeTopic = topicsRef.current.find(t => t.status === 'active');
    const topicId = activeTopic?.id;

    if (isAgent) {
      activeUserMsgIdRef.current = null;
      lastAiTextRef.current = text;
      isAriaSpeakingRef.current = false;
      lastRoleRef.current = 'ai';

      // 🚨 RESET TURN LOCK: AI is speaking, so the next time user speaks it's a new turn
      turnCountedRef.current = false;

      // Cooldown to prevent echo triggering
      speakingCooldownRef.current = true;
      if (speakingCooldownTimerRef.current) clearTimeout(speakingCooldownTimerRef.current);
      speakingCooldownTimerRef.current = setTimeout(() => {
        speakingCooldownRef.current = false;
      }, SPEAKING_COOLDOWN_MS);

      // 🚨 SMART APPEND: If AI sends split messages, group them
      const lastMsg = convRef.current[convRef.current.length - 1];
      if (lastMsg && lastMsg.role === 'ai') {
        lastMsg.text += ' ' + text;
        setConv([...convRef.current]);
      } else {
        const id = uid();
        const entry: ConvEntry = { id, role: 'ai', text, ts: now, topicId };
        convRef.current = [...convRef.current, entry];
        setConv([...convRef.current]);
      }

      startSilenceTimer();

      // 🚨 FIRST GREETING TRIGGER: Unlock user input and orb vibrancy
      if (!hasAriaGreetedRef.current) {
        hasAriaGreetedRef.current = true;
        setHasAriaGreeted(true);
        // 🎙️ AUTO-ENABLE MIC: Only once Aria has finished her first greeting
        setTimeout(() => {
          if (lkRoomRef.current && phaseRef.current !== 'setup') {
            lkRoomRef.current.localParticipant.setMicrophoneEnabled(true);
            setIsMuted(false);
            slog("Microphone activated — You can now speak", true);
          }
        }, 1000); // Small buffer after she starts speaking
      }
      return;
    }

    // --- USER TURN ---
    // 🚨 FIRST GREETING GUARD: Silence the user until Aria says hello
    if (!hasAriaGreetedRef.current || phaseRef.current === 'connecting') {
      console.log("[Guard] Ignoring user turn - agent hasn't greeted or still connecting");
      return;
    }

    // Hard gate: ignore if AI is speaking or in cooldown
    if (isAriaSpeakingRef.current || speakingCooldownRef.current) return;

    lastUserTextRef.current = text;
    lastUserMsgTsRef.current = now;
    lastRoleRef.current = 'user';

    // 🚨 SMART APPEND: If user speaks again before AI replies, combine into one bubble
    const lastMsg = convRef.current[convRef.current.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      lastMsg.text += ' ' + text;
      lastMsg.ts = now;
      setConv([...convRef.current]);
    } else {
      const id = uid();
      const entry: ConvEntry = { id, role: 'user', text, ts: now, topicId };
      convRef.current = [...convRef.current, entry];
      setConv([...convRef.current]);
      activeUserMsgIdRef.current = id;
    }

    // Single debounced context push synced with VAD
    userTurnDebounceRef.current = setTimeout(() => {
      userTurnDebounceRef.current = null;
      if (phaseRef.current === 'ended' || isEndingRef.current) return;
      processUserTurn();
    }, 2500);

  }, [startSilenceTimer, pushFullContext, slog, processUserTurn]);

  // ── Handle CV file ──
  const handleCvFile = async (file: File) => {
    setIsParsing(true);
    setSetupErr('');
    setCvFileName(file.name);
    try {
      const text = await extractText(file);
      if (!text || text.trim().length < 50) {
        setSetupErr('Could not extract enough text. Please paste CV text directly.');
        setCvFileName('');
        setIsParsing(false);
        return;
      }
      setCvText(text);
      // Auto-detect name
      try {
        const activePrompts = PERSONA_PROMPTS[voiceRef.current] || ARIA_PROMPTS;
        const nameRaw = await callLLM(
          activePrompts.EXTRACT_NAME_SYSTEM,
          activePrompts.EXTRACT_NAME_USER.replace('${cvText}', text.slice(0, 1500)),
          usageRef
        );
        const cleaned = nameRaw.replace(/["']/g, '').trim();
        if (cleaned && cleaned.length > 1 && cleaned.length < 60) setCandidateName(cleaned);
      } catch { /* non-fatal */ }
    } catch { setSetupErr('Failed to read file.'); setCvFileName(''); }
    setIsParsing(false);
  };

  // ── Start call ──
  const startCall = useCallback(async () => {
    if (isStartingRef.current || isCallActive) return;
    if (!cvText && !jdText) { setSetupErr('Please provide a CV or Job Description.'); return; }

    isStartingRef.current = true;
    isEndingRef.current = false;

    // Reset everything
    setConv([]); setScores([]); setTopics([]);
    setWarmupTurns(0); setWrapupTurns(0); setCallDuration(0);
    setIsCallEnded(false); setIsAriaSpeaking(false); setIsScoringBg(false);
    setStatusLogs([]); setLiveContext('');
    setBehavior({ candidateMood: 'neutral', ariaMood: 'neutral', softSkills: 5, communication: 5, confidence: 5 });

    topicsRef.current = [];
    scoresRef.current = [];
    convRef.current = [];
    warmupTurnsRef.current = 0;
    wrapupTurnsRef.current = 0;
    elapsedMsRef.current = 0;
    lastAiTextRef.current = '';
    lastUserTextRef.current = '';
    usageRef.current = { tokIn: 0, tokOut: 0 };
    silenceCountRef.current = 0;
    isAriaSpeakingRef.current = false;
    speakingCooldownRef.current = false;
    processedSegmentsRef.current.clear();
    isFirstTurnRef.current = true;
    turnCountedRef.current = false;
    cvSummaryRef.current = '';
    candidateNameRef.current = candidateName;
    hasAriaGreetedRef.current = false;
    setHasAriaGreeted(false);
    setIsMuted(true); // Start muted

    totalTimeSecsRef.current = duration * 60;
    setTimeLeft(duration * 60);

    setPhase('connecting');
    setCallStatus('Connecting...');

    const activePrompts = PERSONA_PROMPTS[voiceRef.current] || ARIA_PROMPTS;

    // Process CV in background
    if (cvText) {
      slog('Processing CV...');
      callLLM(
        activePrompts.CV_DOSSIER_SYSTEM,
        activePrompts.CV_DOSSIER_USER.replace('${cvText}', cvText),
        usageRef
      ).then(summary => {
        cvSummaryRef.current = summary;
        slog('CV Cheat Sheet generated ✓', true);
      }).catch(() => {
        // Fallback: use a much larger chunk of the raw text if LLM fails
        cvSummaryRef.current = cvText.slice(0, 10000);
        slog('CV processing failed — using raw', false);
      });
    } else {
      cvSummaryRef.current = '';
    }

    try {
      // Get LiveKit token
      const roomName = `aria_${uid()}`;
      const tokenRes = await fetch(`/ai-interview/api/livekit-token?room=${roomName}`);
      if (!tokenRes.ok) throw new Error('Token fetch failed');
      const { token } = await tokenRes.json();
      setLkToken(token);

      // Generate topics
      slog(`Generating ${numTopics} interview topics...`);
      const generatedTopics = await generateTopics(cvText || '', jdText, numTopics, usageRef, activePrompts);
      topicsRef.current = generatedTopics;
      setTopics(generatedTopics);
      setUsage({ ...usageRef.current });
      slog(`${generatedTopics.length} topics ready ✓`, true);

      // Create room
      const roomObj = new Room({ adaptiveStream: true, dynacast: true });

      // ── Room Events ──
      roomObj.on(RoomEvent.TranscriptionReceived, (
        segments: TranscriptionSegment[],
        participant?: Participant
      ) => {
        if (!segments.length || !participant) return;
        const fullText = segments.map(s => s.text).join(' ').trim();
        if (!fullText) return;

        const isAgent = !participant.isLocal;
        const isFinal = segments.every(s => s.final);
        const segId = segments[0].id || uid();

        // 🚨 1. STREAMING FIX: Update UI instantly, regardless of final status
        setLiveTranscript(isFinal ? null : { role: isAgent ? 'ai' : 'user', text: fullText });

        // 🚨 2. ONLY commit to permanent history when the turn is actually finished
        if (isFinal) {
          handleTranscript(fullText, isAgent, segId, segments);
        }

        if (isAgent) {
          isAriaSpeakingRef.current = true;
          setIsAriaSpeaking(true);
          setIsAriaThinking(false);
          setCallStatus('Speaking...');
          clearSilenceTimer();
        }
      });

      roomObj.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        const agentSpeaking = speakers.some(p => !p.isLocal);
        const userSpeaking = speakers.some(p => p.isLocal);

        if (agentSpeaking) {
          isAriaSpeakingRef.current = true;
          setIsAriaSpeaking(true);
          setIsAriaThinking(false);
          setCallStatus('Speaking...');
          clearSilenceTimer();
        } else if (!agentSpeaking && isAriaSpeakingRef.current) {
          isAriaSpeakingRef.current = false;
          setIsAriaSpeaking(false);
          speakingCooldownRef.current = true;
          setCallStatus('Listening...');

          if (speakingCooldownTimerRef.current) clearTimeout(speakingCooldownTimerRef.current);
          speakingCooldownTimerRef.current = setTimeout(() => {
            speakingCooldownRef.current = false;
            if (phaseRef.current === 'closing') {
              const lastAi = lastAiTextRef.current.toLowerCase();
              if (['goodbye', 'bye', 'take care', 'best of luck', 'good luck'].some(w => lastAi.includes(w))) {
                setTimeout(() => endCall(), 2000);
                return;
              }
            }
            startSilenceTimer();
          }, SPEAKING_COOLDOWN_MS);
        }

        if (userSpeaking) {
          setCallStatus('Listening...');
          silenceCountRef.current = 0;
          clearSilenceTimer();
        }
      });

      roomObj.on(RoomEvent.ParticipantConnected, (participant) => {
        if (!participant.isLocal) {
          slog(`Agent "${participant.identity}" joined room`, true);
        }
      });

      roomObj.on(RoomEvent.Disconnected, () => {
        if (!isEndingRef.current) endCall();
      });

      const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || 'ws://127.0.0.1:7880';
      await roomObj.connect(wsUrl, token);
      // 🎙️ RE-ENABLE MIC AT START: Session health is better with tracks published.
      // The backend guard will still ignore audio until greeting.
      await roomObj.localParticipant.setMicrophoneEnabled(true);
      setIsMuted(false);

      setLkRoom(roomObj);
      lkRoomRef.current = roomObj;
      setIsCallActive(true);
      isStartingRef.current = false;

      phaseRef.current = 'warmup';
      setPhase('warmup');
      setCallStatus('Connected');

      // Start interview timer
      const totalMs = duration * 60 * 1000;
      if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);
      interviewTimerRef.current = setInterval(() => {
        if (isEndingRef.current) { clearInterval(interviewTimerRef.current!); return; }
        if (phaseRef.current === 'interview' && !isAriaSpeakingRef.current) {
          elapsedMsRef.current += 1000;
        }
        const remaining = Math.max(0, totalMs - elapsedMsRef.current);
        setTimeLeft(Math.floor(remaining / 1000));
        if (remaining <= 0 && phaseRef.current === 'interview') {
          clearInterval(interviewTimerRef.current!);
          phaseRef.current = 'wrapup';
          setPhase('wrapup');
          wrapupTurnsRef.current = 0;
          slog('Time up → Wrapup', true);
          pushFullContext();
        }
      }, 1000);

      const initCtx = buildContextPacket({
        phase: 'warmup',
        candidateName: candidateNameRef.current,
        cvSummary: cvSummaryRef.current,
        jdText: jdTextRef.current,
        topics: generatedTopics,
        conv: [],
        behavior: behaviorRef.current,
        warmupTurns: 0,
        wrapupTurns: 0,
        timeLeftSecs: totalTimeSecsRef.current,
        totalTimeSecs: totalTimeSecsRef.current,
        prompts: activePrompts,
      });

      // 🚨 DELAYED START: Give the agent a moment to join before pushing instructions
      setTimeout(() => {
        const room = lkRoomRef.current;
        if (!room || room.state !== 'connected') return;

        room.localParticipant.setAttributes({
          instructions: initCtx,
          sync_id: `init_${Date.now()}`,
          is_start: "true",
          voice: voiceRef.current,
        });
        slog('Initial context packet pushed to agent', true);
      }, 2000);

    } catch (err: any) {
      console.error('[StartCall]', err);
      setSetupErr(`Failed to connect: ${err.message}`);
      setPhase('setup');
      setIsCallActive(false);
      isStartingRef.current = false;
    }
  }, [
    isCallActive, cvText, jdText, candidateName, duration, numTopics,
    slog, handleTranscript, clearSilenceTimer, startSilenceTimer, endCall, pushFullContext
  ]);

  // ── Timers ──
  useEffect(() => {
    if (!isCallActive) return;
    const iv = setInterval(() => setCallDuration(d => d + 1), 1000);
    return () => clearInterval(iv);
  }, [isCallActive]);

  useEffect(() => () => {
    isEndingRef.current = true;
    lkRoomRef.current?.disconnect();
    if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);
    if (speakingCooldownTimerRef.current) clearTimeout(speakingCooldownTimerRef.current);
  }, []);

  // ── Computed ──
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b.score, 0) / scores.length : 0;
  const coveredTopics = topics.filter(t => ['covered', 'exhausted'].includes(t.status));
  const activeTopicName = topics.find(t => t.status === 'active')?.name || '';
  const timePct = timeLeft / (duration * 60) * 100;
  const timerColor = timePct > 50 ? '#4ade80' : timePct > 25 ? '#fbbf24' : '#f87171';

  // ────────────────────────────────────────────────────────────────────────────
  // STYLES
  // ────────────────────────────────────────────────────────────────────────────

  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,600;1,9..144,300;1,9..144,400&family=Geist+Mono:wght@300;400;500&family=Geist:wght@300;400;500;600&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --ink: #0a0b0f;
      --paper: #f7f6f3;
      --card: #ffffff;
      --border: #e2e0da;
      --border2: #ccc9c0;
      --muted: #8b8678;
      --faint: #f0efe9;
      --blue: #1a56db;
      --blue-pale: #e8effe;
      --green: #0f7844;
      --green-pale: #e4f5ec;
      --amber: #92400e;
      --amber-pale: #fef3c7;
      --red: #b91c1c;
      --red-pale: #fee2e2;
      --violet: #5b21b6;
      --violet-pale: #ede9fe;
      --display: 'Fraunces', serif;
      --mono: 'Geist Mono', monospace;
      --sans: 'Geist', sans-serif;
      --shadow-sm: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
      --shadow: 0 4px 12px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.04);
      --shadow-lg: 0 12px 32px rgba(0,0,0,.10), 0 4px 8px rgba(0,0,0,.06);
    }

    html, body {
      background: var(--paper);
      color: var(--ink);
      font-family: var(--sans);
      height: 100vh;
      overflow: hidden;
    }
    ::-webkit-scrollbar { width: 3px; }
    ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

    /* ── SETUP ── */
    .setup {
      min-height: 100vh; overflow-y: auto;
      background: var(--paper);
      display: flex; flex-direction: column; align-items: center;
      padding: 52px 24px 72px; gap: 32px;
    }

    .logo-mark {
      width: 52px; height: 52px; border-radius: 14px;
      background: var(--ink);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; box-shadow: var(--shadow);
    }

    .setup-title {
      font-family: var(--display);
      font-size: clamp(38px, 5vw, 60px);
      font-weight: 300; line-height: 1.1;
      letter-spacing: -.02em;
      color: var(--ink);
    }
    .setup-title em { font-style: italic; color: var(--blue); }

    .setup-sub {
      font-family: var(--mono);
      font-size: 10px; color: var(--muted);
      letter-spacing: .1em; margin-top: 4px;
    }

    .setup-grid {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 16px; width: 100%; max-width: 880px;
    }
    @media(max-width: 680px) { .setup-grid { grid-template-columns: 1fr; } }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px; padding: 20px;
      box-shadow: var(--shadow-sm);
      display: flex; flex-direction: column; gap: 14px;
    }

    .card-label {
      font-family: var(--mono);
      font-size: 9px; letter-spacing: .14em;
      text-transform: uppercase; color: var(--muted);
    }

    .drop-zone {
      border: 2px dashed var(--border2);
      border-radius: 10px; padding: 28px 16px;
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      cursor: pointer; transition: all .2s;
      background: var(--faint);
    }
    .drop-zone:hover { border-color: var(--blue); background: var(--blue-pale); }

    .cv-loaded {
      display: flex; align-items: center; gap: 10px;
      background: var(--green-pale);
      border: 1px solid rgba(15,120,68,.2);
      border-radius: 10px; padding: 11px 14px;
    }

    .textarea, .input {
      width: 100%;
      background: var(--faint);
      border: 1px solid var(--border);
      border-radius: 8px; padding: 11px 13px;
      color: var(--ink); font-family: var(--sans); font-size: 13px;
      outline: none; transition: border-color .2s;
    }
    .textarea { resize: vertical; min-height: 150px; line-height: 1.7; }
    .textarea:focus, .input:focus { border-color: var(--blue); background: white; }
    .textarea::placeholder, .input::placeholder { color: var(--muted); }

    .tab-row {
      display: flex; gap: 2px;
      background: var(--faint);
      border: 1px solid var(--border);
      border-radius: 9px; padding: 3px;
    }
    .tab-btn {
      flex: 1; border: none; padding: 6px;
      border-radius: 6px;
      font-family: var(--mono); font-size: 10px; font-weight: 500;
      cursor: pointer; transition: all .2s; letter-spacing: .04em;
    }
    .tab-btn.on { background: var(--ink); color: white; }
    .tab-btn:not(.on) { background: transparent; color: var(--muted); }

    .tmpl-grid {
      display: grid; grid-template-columns: repeat(2, 1fr);
      gap: 6px; max-height: 200px; overflow-y: auto;
    }
    .tmpl {
      padding: 10px 11px;
      background: var(--faint);
      border: 1px solid var(--border); border-radius: 8px;
      cursor: pointer; transition: all .2s;
    }
    .tmpl:hover, .tmpl.on { border-color: var(--blue); background: var(--blue-pale); }

    .seg-row { display: flex; gap: 4px; }
    .seg {
      flex: 1; padding: 7px 0; border-radius: 8px;
      cursor: pointer; transition: all .2s;
      font-family: var(--mono); font-size: 11px; font-weight: 500;
      border: 1px solid var(--border); text-align: center;
      background: var(--faint); color: var(--muted);
    }
    .seg.on { background: var(--ink); border-color: var(--ink); color: white; }

    .err {
      display: flex; align-items: center; gap: 8px;
      background: var(--red-pale); border: 1px solid rgba(185,28,28,.2);
      border-radius: 10px; padding: 11px 14px;
      font-size: 13px; color: var(--red);
      max-width: 880px; width: 100%;
    }

    .start-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; max-width: 880px;
      padding: 16px; border-radius: 12px;
      background: var(--ink);
      border: none; cursor: pointer; color: white;
      font-family: var(--sans); font-size: 15px; font-weight: 600;
      transition: all .25s; letter-spacing: -.01em;
    }
    .start-btn:disabled { opacity: .3; cursor: not-allowed; }
    .start-btn:not(:disabled):hover { transform: translateY(-1px); box-shadow: var(--shadow-lg); }

    .features-row {
      display: flex; flex-wrap: wrap; gap: 6px;
      justify-content: center; max-width: 880px;
    }
    .ftag {
      font-family: var(--mono); font-size: 9px;
      padding: 3px 10px; border-radius: 100px;
      border: 1px solid var(--border);
      background: white; color: var(--muted);
      letter-spacing: .04em;
    }

    /* ── CONNECTING ── */
    .connecting {
      height: 100vh; background: var(--paper);
      display: flex; align-items: center; justify-content: center;
    }
    .conn-pulse {
      width: 68px; height: 68px; border-radius: 20px;
      background: var(--ink);
      display: flex; align-items: center; justify-content: center; font-size: 26px;
      animation: connPulse 2s ease-in-out infinite;
      box-shadow: var(--shadow-lg);
    }
    @keyframes connPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(10,11,15,.3); }
      50% { box-shadow: 0 0 0 20px rgba(10,11,15,0); }
    }

    /* ── LIVE ── */
    .live {
      display: grid;
      grid-template-columns: 260px 1fr 280px;
      height: 100vh; overflow: hidden;
      background: var(--paper);
    }
    @media(max-width: 1100px) {
      .live { grid-template-columns: 240px 1fr; }
      .right-col { display: none; }
    }

    /* Left column */
    .left-col {
      border-right: 1px solid var(--border);
      background: var(--card);
      display: flex; flex-direction: column;
      height: 100vh; overflow: hidden;
    }

    .agent-hero {
      padding: 20px 16px 14px;
      border-bottom: 1px solid var(--border);
      display: flex; flex-direction: column; align-items: center; gap: 12px;
    }

    .agent-orb {
      position: relative;
      width: 60px; height: 60px; border-radius: 18px;
      background: var(--ink);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; transition: all .4s;
      box-shadow: var(--shadow);
    }
    .agent-orb.speaking { box-shadow: 0 0 0 3px rgba(26,86,219,.25), var(--shadow); }
    .agent-orb.scoring { box-shadow: 0 0 0 3px rgba(91,33,182,.15), var(--shadow); }

    .status-pill {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 12px; border-radius: 100px;
      font-family: var(--mono); font-size: 10px; font-weight: 500;
      letter-spacing: .04em;
    }

    .waveform {
      display: flex; align-items: center; gap: 2px;
      height: 28px; width: 100%; justify-content: center;
    }
    .wbar {
      width: 2.5px; border-radius: 3px;
      transition: height .1s ease;
    }

    .silence-wrap { width: 100%; padding: 0 2px; }
    .silence-rail { height: 2px; background: var(--border); border-radius: 2px; overflow: hidden; }
    .silence-fill { height: 100%; border-radius: 2px; transition: width .2s linear, background .3s; }

    .left-scroll {
      flex: 1; overflow-y: auto;
      display: flex; flex-direction: column;
    }

    .sec { border-bottom: 1px solid var(--border); }
    .sec-hd {
      padding: 8px 14px;
      display: flex; align-items: center; justify-content: space-between;
      background: var(--faint);
    }
    .sec-title {
      font-family: var(--mono); font-size: 8px;
      letter-spacing: .14em; text-transform: uppercase; color: var(--muted);
    }

    .slog-row {
      padding: 6px 14px;
      display: flex; align-items: center; gap: 8px;
      border-bottom: 1px solid rgba(0,0,0,.03);
    }
    .slog-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }

    .topic-row {
      padding: 9px 14px;
      display: flex; align-items: flex-start; gap: 10px;
      border-bottom: 1px solid rgba(0,0,0,.03);
      transition: background .2s;
    }
    .topic-row.active { background: var(--blue-pale); }
    .topic-icon {
      width: 20px; height: 20px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; flex-shrink: 0; margin-top: 1px;
      font-family: var(--mono); font-weight: 600;
    }

    .controls {
      padding: 12px;
      border-top: 1px solid var(--border);
      display: flex; gap: 8px; flex-shrink: 0;
      background: var(--card);
    }
    .btn {
      flex: 1; padding: 10px; border-radius: 9px;
      border: 1px solid var(--border); cursor: pointer;
      font-family: var(--sans); font-size: 12px; font-weight: 600;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      transition: all .2s; background: var(--faint); color: var(--ink);
    }
    .btn:hover { background: var(--border); }
    .btn-end { background: var(--red-pale); color: var(--red); border-color: rgba(185,28,28,.2); flex: 2; }
    .btn-end:hover { background: rgba(185,28,28,.15); }

    /* Center */
    .center-col { display: flex; flex-direction: column; overflow: hidden; }
    .center-top {
      padding: 10px 20px;
      border-bottom: 1px solid var(--border);
      background: var(--card);
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
    }

    .phase-track { display: flex; align-items: center; gap: 8px; }
    .phase-node { display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .phase-dot { width: 7px; height: 7px; border-radius: 50%; transition: all .3s; }
    .phase-label { font-family: var(--mono); font-size: 7px; letter-spacing: .05em; transition: color .3s; }
    .phase-sep { width: 16px; height: 1px; background: var(--border); }

    .center-body {
      flex: 1; overflow-y: auto;
      padding: 20px 22px;
      display: flex; flex-direction: column; gap: 14px;
      position: relative;
    }

    .msg { display: flex; gap: 10px; align-items: flex-start; animation: fadeUp .2s ease; }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
    .msg-av {
      width: 28px; height: 28px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-family: var(--mono); font-size: 8px; font-weight: 600;
      flex-shrink: 0; letter-spacing: .04em;
    }
    .msg-av.ai { background: var(--ink); color: white; }
    .msg-av.user { background: var(--faint); color: var(--muted); border: 1px solid var(--border); }
    .msg-text { font-size: 14px; line-height: 1.7; flex: 1; }
    .msg-text.ai { color: var(--ink); font-weight: 400; }
    .msg-text.user { color: #444; }

    .end-overlay {
      position: absolute; inset: 0; z-index: 10;
      background: rgba(247,246,243,.96); backdrop-filter: blur(12px);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 24px; padding: 40px; text-align: center;
      animation: fadeUp .4s ease;
    }

    /* Right panel */
    .right-col {
      border-left: 1px solid var(--border);
      background: var(--card); overflow-y: auto;
      display: flex; flex-direction: column;
    }

    .score-item {
      padding: 13px 16px; border-bottom: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 6px;
    }
    .score-badge {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 8px; border-radius: 6px;
      font-family: var(--mono); font-size: 10px; font-weight: 700;
    }
    .metric-chip {
      font-family: var(--mono); font-size: 8px;
      padding: 2px 6px; border-radius: 4px;
      background: var(--faint); border: 1px solid var(--border); color: var(--muted);
    }

    /* ── REPORT ── */
    .report-wrap {
      height: 100vh; background: var(--paper);
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .report {
      width: 100%; max-width: 820px; max-height: 93vh;
      background: var(--card); border: 1px solid var(--border);
      border-radius: 20px; overflow: hidden;
      display: flex; flex-direction: column;
      box-shadow: var(--shadow-lg);
      animation: fadeUp .4s ease;
    }
    .report-hero {
      padding: 36px; text-align: center;
      background: var(--ink); color: white;
    }
    .report-score {
      font-family: var(--display); font-size: 80px;
      font-weight: 300; line-height: 1;
    }
    .report-stats {
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 0; border-bottom: 1px solid var(--border);
    }
    .rstat { padding: 16px; border-right: 1px solid var(--border); }
    .rstat:last-child { border-right: none; }
    .rstat-val { font-family: var(--display); font-size: 24px; font-weight: 400; }
    .rstat-lbl { font-family: var(--mono); font-size: 8px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-top: 3px; }
    .report-body { overflow-y: auto; flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .answer-card {
      border: 1px solid var(--border); border-radius: 12px;
      padding: 15px; display: flex; flex-direction: column; gap: 7px;
    }
    .restart-btn {
      background: var(--ink); color: white;
      padding: 12px 36px; border-radius: 10px;
      font-family: var(--sans); font-size: 14px; font-weight: 600;
      border: none; cursor: pointer; transition: all .25s;
      letter-spacing: -.01em;
    }
    .restart-btn:hover { transform: translateY(-1px); box-shadow: var(--shadow-lg); }

    .spin {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(10,11,15,.15); border-top-color: var(--ink);
      animation: spin .7s linear infinite;
    }
    .spin-white {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.2); border-top-color: white;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .pulse { animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity:.4 } 50% { opacity:1 } }
    .fade-in { animation: fadeUp .35s ease forwards; }
  `;


  // ─────────────────────────────────────────────────────────────────────────
  // VIEW LOGIC
  // ─────────────────────────────────────────────────────────────────────────

  const livePhases: { p: AppPhase; label: string }[] = [
    { p: 'warmup', label: 'Warmup' },
    { p: 'interview', label: 'Interview' },
    { p: 'wrapup', label: 'Wrap-up' },
    { p: 'closing', label: 'Closing' },
  ];
  const phaseOrder = livePhases.map(x => x.p);
  const curPhaseIdx = phaseOrder.indexOf(phase as any);

  const BARS = 24;
  const waveHeights = Array.from({ length: BARS }, (_, i) => {
    if (!isAriaSpeaking) return 3;
    const t = Date.now() / 200;
    return Math.max(3, Math.round((Math.sin(i / BARS * Math.PI * 3 + t) * 0.5 + 0.6) * 22));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER SELECTION
  // ─────────────────────────────────────────────────────────────────────────

  if (!SHOW_DEBUG_UI && (['setup', 'connecting', 'warmup', 'interview', 'wrapup', 'closing', 'ended', 'report'] as string[]).includes(phase as string)) {
    return (
      <LiveKitRoom
        room={lkRoom || undefined}
        token={lkToken || undefined}
        serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL || 'ws://127.0.0.1:7880'}
        connect={!!lkToken}
        audio={true}
        video={false}
      >
        <RoomAudioRenderer />
        <AriaPremiumUI
          phase={phase}
          candidateName={candidateName}
          setCandidateName={setCandidateName}
          cvFileName={cvFileName}
          handleCvFile={handleCvFile}
          jdText={jdText}
          setJdText={setJdText}
          isParsing={isParsing}
          setupErr={setupErr}
          startCall={startCall}
          isCallActive={isCallActive}
          isAriaSpeaking={isAriaSpeaking}
          hasGreeted={hasAriaGreeted}
          onEndCall={endCall}
          onToggleMute={() => {
            const room = lkRoomRef.current;
            if (room) {
              const en = room.localParticipant.isMicrophoneEnabled;
              room.localParticipant.setMicrophoneEnabled(!en);
              setIsMuted(en);
            }
          }}
          isMuted={isMuted}
          participant={lkRoom?.localParticipant}
          numTopics={numTopics}
          setNumTopics={setNumTopics}
          duration={duration}
          setDuration={setDuration}
          voice={voice}
          setVoice={setVoice}
          isThinking={isAriaThinking}
          scores={scores}
          conv={conv}
          behavior={behavior}
          avgScore={avgScore}
        />
      </LiveKitRoom>
    );
  }


  const activePrompts = PERSONA_PROMPTS[voice] || ARIA_PROMPTS;

  // Fallback to existing Debug UI (setup, connecting, report, or if toggled)
  if ((phase as any) === 'setup') return (
    <>
      <style>{CSS}</style>
      <div className="setup">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div className="logo-mark">🎙</div>
          <h1 className="setup-title">Evaluate with <em>{activePrompts.PERSONA.name}</em></h1>
          <div className="setup-sub">NEXT-GEN TECHNICAL INTERVIEWER v8</div>
        </div>

        <div className="setup-grid fade-in">
          {/* CV card */}
          <div className="card">
            <div className="card-label">Candidate Dossier</div>
            {cvFileName ? (
              <div className="cv-loaded fade-in">
                <div style={{ fontSize: 24 }}>📄</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{cvFileName}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{cvText.length} characters parsed</div>
                </div>
                <button className="btn" style={{ padding: '4px 8px', fontSize: 9 }} onClick={() => { setCvFileName(''); setCvText(''); }}>REMOVE</button>
              </div>
            ) : (
              <>
                <div className="drop-zone" onClick={() => {
                  const i = document.createElement('input');
                  i.type = 'file';
                  i.onchange = (e: any) => handleCvFile(e.target.files[0]);
                  i.click();
                }}>
                  <span style={{ fontSize: 28 }}>{isParsing ? '⏳' : '📄'}</span>
                  <div style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>{isParsing ? 'Parsing file...' : 'Upload PDF or text file'}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>or paste below</div>
                </div>
                <textarea className="textarea" placeholder="Paste CV / resume text here..." style={{ minHeight: 120 }} value={cvText} onChange={e => setCvText(e.target.value)} />
              </>
            )}
          </div>

          {/* JD card */}
          <div className="card">
            <div className="card-label">Job Description</div>
            <div className="tab-row">
              <button className={`tab-btn ${jdTab === 'manual' ? 'on' : ''}`} onClick={() => setJdTab('manual')}>MANUAL</button>
              <button className={`tab-btn ${jdTab === 'templates' ? 'on' : ''}`} onClick={() => setJdTab('templates')}>TEMPLATES</button>
            </div>
            {jdTab === 'manual' ? (
              <textarea className="textarea fade-in" placeholder="Paste job description..." style={{ minHeight: 150 }} value={jdText} onChange={e => setJdText(e.target.value)} />
            ) : (
              <div className="tmpl-grid fade-in">
                {Object.entries(JD_TEMPLATES).map(([key, val]) => {
                  const icons: any = { frontend: '⚛️', backend: '⚙️', fullstack: '⚡', ai: '🧠', devops: '☁️', mobile: '📱' };
                  const names: any = { frontend: 'Frontend', backend: 'Backend', fullstack: 'Fullstack', ai: 'AI/ML', devops: 'DevOps', mobile: 'Mobile' };
                  return (
                    <div key={key} className={`tmpl ${selectedTmpl === key ? 'on' : ''}`} onClick={() => { setJdText(val); setSelectedTmpl(key); setJdTab('manual'); }}>
                      <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}><span>{icons[key]}</span>{names[key]}</div>
                      <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 3 }}>{val.split('\n')[0]?.replace('Role: ', '')}</div>
                    </div>
                  );
                })}
              </div>
            )}
            <input className="input" placeholder="Candidate name (auto-detected)" value={candidateName} onChange={e => setCandidateName(e.target.value)} />
            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ flex: 1 }}>
                <div className="card-label" style={{ marginBottom: 8 }}>Topics</div>
                <div className="seg-row">
                  {[3, 5, 8, 10].map(n => (
                    <button key={n} className={`seg ${numTopics === n ? 'on' : ''}`} onClick={() => setNumTopics(n)}>{n}</button>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div className="card-label" style={{ marginBottom: 8 }}>Duration</div>
                <div className="seg-row">
                  {[5, 10, 15, 20].map(m => (
                    <button key={m} className={`seg ${duration === m ? 'on' : ''}`} onClick={() => setDuration(m)}>{m}m</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="features-row fade-in">
          {[
            'Speaker-First Architecture',
            'Full context per turn',
            'Non-blocking background scoring',
            'Natural warmup → interview bridge',
            'GPT-4o-mini brain',
            'LiveKit voice delivery',
          ].map(f => <div key={f} className="ftag">{f}</div>)}
        </div>

        {setupErr && <div className="err fade-in">⚠ {setupErr}</div>}

        <button
          className="start-btn fade-in"
          disabled={isParsing || (!cvText && !jdText)}
          onClick={() => { setSetupErr(''); startCall(); }}
        >
          {isParsing
            ? <><div className="spin" /> Processing CV...</>
            : `→  Begin Interview with ${activePrompts.PERSONA.name}`}
        </button>
      </div>
    </>
  );

  if ((phase as any) === 'connecting') return (
    <>
      <style>{CSS}</style>
      <div className="connecting">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, textAlign: 'center' }} className="fade-in">
          <div className="conn-pulse">🎙</div>
          <div>
            <div style={{ fontFamily: 'var(--display)', fontSize: 24, fontWeight: 300, letterSpacing: '-.01em', marginBottom: 6 }}>Initializing {activePrompts.PERSONA.name}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
              {statusLogs[0]?.msg || 'Generating strategy · Connecting...'}
            </div>
          </div>
          {statusLogs.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
              {statusLogs.slice(0, 5).map(l => (
                <div key={l.id} style={{
                  fontFamily: 'var(--mono)', fontSize: 9,
                  color: l.ok === true ? 'var(--green)' : l.ok === false ? 'var(--red)' : 'var(--muted)',
                  padding: '2px 10px', border: '1px solid var(--border)', borderRadius: 6,
                  background: 'white',
                }}>
                  {l.ok === true ? '✓ ' : l.ok === false ? '✗ ' : '· '}{l.msg}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );

  if ((phase as any) === 'report') return (
    <>
      <style>{CSS}</style>
      <div className="report-wrap">
        <div className="report">
          <div className="report-hero">
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'rgba(255,255,255,.5)', letterSpacing: '.12em', marginBottom: 10 }}>ARIA v8 · INTERVIEW COMPLETE</div>
            <div className="report-score" style={{ color: avgScore > 0 ? scoreColor(avgScore) : 'rgba(255,255,255,.4)' }}>
              {avgScore > 0 ? avgScore.toFixed(1) : '—'}
            </div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,.6)', marginTop: 8 }}>
              {scores.length} topics evaluated · {fmtTime(callDuration)}
            </div>
          </div>

          <div className="report-stats">
            {[
              { val: scores.length, lbl: 'Topics Scored' },
              { val: `${behavior.softSkills}/10`, lbl: 'Soft Skills' },
              { val: behavior.candidateMood, lbl: 'Candidate Style', sm: true },
              { val: `$${cost(usage)}`, lbl: 'AI Cost', sm: true },
            ].map(({ val, lbl, sm }) => (
              <div className="rstat" key={lbl}>
                <div className="rstat-val" style={sm ? { fontSize: 16, marginTop: 4, textTransform: 'capitalize' } : {}}>{val}</div>
                <div className="rstat-lbl">{lbl}</div>
              </div>
            ))}
          </div>

          <div style={{ padding: '14px 18px', background: 'var(--faint)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--blue)', fontWeight: 600, letterSpacing: '.1em', marginBottom: 6 }}>BEHAVIORAL SUMMARY</div>
            <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.7 }}>
              {candidateName || 'The candidate'} demonstrated a <strong>{behavior.candidateMood}</strong> communication style.
              Soft skills <strong>{behavior.softSkills}/10</strong> · Communication <strong>{behavior.communication}/10</strong> · Confidence <strong>{behavior.confidence}/10</strong>.
              Aria adapted to <strong>{behavior.ariaMood}</strong> mode throughout.
            </div>
            <div className="aria-identity">
              <div style={{ fontFamily: 'var(--display)', fontSize: 20, fontWeight: 300, letterSpacing: '-.01em' }}>{activePrompts.PERSONA.name}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)', letterSpacing: '.08em', marginTop: 1 }}>{activePrompts.PERSONA.title}</div>
            </div>
          </div>

          <div className="report-body">
            {scores.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 32, fontFamily: 'var(--mono)', fontSize: 12 }}>No scored answers recorded.</div>
            ) : scores.map((s, i) => (
              <div className="answer-card" key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{s.topicName}</div>
                  <div className="score-badge" style={{
                    background: scoreColor(s.score) + '18',
                    color: scoreColor(s.score),
                    border: `1px solid ${scoreColor(s.score)}30`,
                  }}>{s.score}/10</div>
                </div>
                {s.question && (
                  <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted)', borderLeft: '2px solid var(--border2)', paddingLeft: 9 }}>
                    Q: {s.question.slice(0, 130)}
                  </div>
                )}
                {s.summary && <div style={{ fontSize: 12, color: '#555', lineHeight: 1.65 }}>{s.summary}</div>}
                {s.feedback && <div style={{ fontSize: 12, color: '#555', lineHeight: 1.65 }}>{s.feedback}</div>}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <span className="metric-chip">Depth: {s.depth}</span>
                  <span className="metric-chip">Accuracy: {s.accuracy}/10</span>
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



  return (
    <LiveKitRoom
      room={lkRoom || undefined}
      token={lkToken || undefined}
      serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL || 'ws://127.0.0.1:7880'}
      connect={!!lkToken}
      audio={true}
      video={false}
    >
      <RoomAudioRenderer />
      <style>{CSS}</style>
      <div className="live">

        {/* ── LEFT ── */}
        <div className="left-col">
          <div className="agent-hero">
            <div className={`agent-orb ${isAriaSpeaking ? 'speaking' : isScoringBg ? 'scoring' : ''}`}>🎙</div>

            <div style={{ fontFamily: 'var(--display)', fontSize: 20, fontWeight: 300, letterSpacing: '-.01em' }}>{ARIA_PROMPTS.PERSONA.name}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)', letterSpacing: '.08em', marginTop: 1 }}>{ARIA_PROMPTS.PERSONA.title}</div>

            <div className="status-pill" style={{
              background: isAriaSpeaking ? 'var(--blue-pale)' : isScoringBg ? 'var(--violet-pale)' : 'var(--faint)',
              color: isAriaSpeaking ? 'var(--blue)' : isScoringBg ? 'var(--violet)' : 'var(--muted)',
            }}>
              <div style={{
                width: 5, height: 5, borderRadius: '50%',
                background: isAriaSpeaking ? 'var(--blue)' : isScoringBg ? 'var(--violet)' : 'var(--border2)',
                animation: (isAriaSpeaking || isScoringBg) ? 'pulse 1s infinite' : 'none',
              }} />
              {isAriaSpeaking ? 'Speaking...' : isScoringBg ? 'Scoring...' : callStatus}
            </div>

            {silenceLeft !== null && !isAriaSpeaking && (
              <div className="silence-wrap">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 3 }}>
                  <span>Silence</span><span>{(silenceLeft / 1000).toFixed(0)}s</span>
                </div>
                <div className="silence-rail">
                  <div className="silence-fill" style={{
                    width: `${(silenceLeft / SILENCE_TIMEOUT_MS) * 100}%`,
                    background: silenceLeft < 5000 ? 'var(--red)' : silenceLeft < 10000 ? 'var(--amber)' : 'var(--blue)',
                  }} />
                </div>
              </div>
            )}

            <div className="waveform">
              {waveHeights.map((h, i) => (
                <div key={i} className="wbar" style={{
                  height: h,
                  background: isAriaSpeaking
                    ? `rgba(26,86,219,${0.25 + (h / 24) * 0.65})`
                    : 'var(--border)',
                }} />
              ))}
            </div>
          </div>

          <div className="left-scroll">
            {/* Status logs */}
            {statusLogs.length > 0 && (
              <div className="sec">
                <div className="sec-hd">
                  <span className="sec-title">Activity</span>
                  {isScoringBg && <span style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--violet)' }}>● scoring</span>}
                </div>
                {statusLogs.slice(0, 6).map(l => (
                  <div key={l.id} className="slog-row">
                    <div className="slog-dot" style={{ background: l.ok === true ? 'var(--green)' : l.ok === false ? 'var(--red)' : 'var(--amber)' }} />
                    <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: l.ok === false ? 'var(--red)' : 'var(--muted)', flex: 1 }}>{l.msg}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Behavioral Intel - ONLY visible after warmup */}
            {phase !== 'warmup' && (
              <div className="sec">
                <div className="sec-hd">
                  <span className="sec-title">Behavioral Intel</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: behavior.ariaMood === 'warm' ? 'var(--green)' : behavior.ariaMood === 'direct' ? 'var(--red)' : 'var(--muted)', fontWeight: 600, textTransform: 'uppercase' }}>
                    aria: {behavior.ariaMood}
                  </span>
                </div>
                <div style={{ padding: '10px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {[
                    { label: 'CANDIDATE', val: behavior.candidateMood, color: 'var(--blue)' },
                    { label: 'SOFT SKILLS', val: `${behavior.softSkills}/10`, color: 'var(--amber)' },
                    { label: 'COMM', val: `${behavior.communication}/10`, color: 'var(--green)' },
                    { label: 'COST', val: `$${cost(usage)}`, color: 'var(--muted)' },
                  ].map(({ label, val, color }) => (
                    <div key={label} style={{ background: 'var(--faint)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px' }}>
                      <div style={{ fontSize: 7, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 2, letterSpacing: '.08em' }}>{label}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color, textTransform: 'capitalize' }}>{val}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Topics - ONLY visible after warmup */}
            {phase !== 'warmup' && topics.length > 0 && (
              <div className="sec">
                <div className="sec-hd">
                  <span className="sec-title">Topic Roadmap</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--amber)', fontWeight: 600 }}>
                    {coveredTopics.length}/{topics.length}
                  </span>
                </div>
                {topics.map((t, i) => {
                  const isActive = t.status === 'active' && phase === 'interview';
                  const isDone = ['covered', 'exhausted'].includes(t.status);
                  return (
                    <div key={t.id} className={`topic-row ${isActive ? 'active' : ''}`}>
                      <div className="topic-icon" style={{
                        background: isDone ? 'var(--green-pale)' : isActive ? 'var(--ink)' : 'var(--faint)',
                        color: isDone ? 'var(--green)' : isActive ? 'white' : 'var(--muted)',
                      }}>
                        {isDone ? '✓' : isActive ? '→' : `${i + 1}`}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 11, fontWeight: isActive ? 600 : 400,
                          color: isDone ? 'var(--muted)' : isActive ? 'var(--ink)' : '#555',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {t.name}
                        </div>
                        <div style={{ display: 'flex', gap: 5, marginTop: 2, alignItems: 'center' }}>
                          <span style={{
                            fontSize: 7, fontFamily: 'var(--mono)',
                            color: t.source === 'profile' ? 'var(--amber)' : t.source === 'cv' ? 'var(--blue)' : 'var(--violet)',
                            fontWeight: 700, textTransform: 'uppercase',
                          }}>{t.source}</span>
                          {isActive && <span style={{ fontSize: 7, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{t.turnCount}/{MAX_TOPIC_TURNS}</span>}
                          {t.score !== undefined && <span style={{ fontSize: 8, fontFamily: 'var(--mono)', color: scoreColor(t.score), fontWeight: 700 }}>{t.score}/10</span>}
                        </div>
                        {isActive && t.pressurePoints.length > 0 && (
                          <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {t.pressurePoints.slice(0, 3).map((p, j) => (
                              <div key={j} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                <div style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--border2)', marginTop: 4, flexShrink: 0 }} />
                                <div style={{ fontSize: 8, color: 'var(--muted)', lineHeight: 1.5 }}>{p}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="controls">
            <button className="btn" onClick={() => {
              const room = lkRoomRef.current;
              if (room) {
                const en = room.localParticipant.isMicrophoneEnabled;
                room.localParticipant.setMicrophoneEnabled(!en);
                setIsMuted(en);
              }
            }}>
              {isMuted ? '🔇' : '🎤'} {isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button className="btn" style={{ background: 'var(--amber-pale)', color: 'var(--amber)', borderColor: 'rgba(217,119,6,.2)' }} onClick={triggerHardReset}>
              🔄 Reset Agent
            </button>
            <button className="btn btn-end" onClick={endCall}>End Interview</button>
          </div>
        </div>

        {/* ── CENTER ── */}
        <div className="center-col">
          <div className="center-top">
            <div className="phase-track">
              {livePhases.map(({ p, label }, i) => {
                const idx = phaseOrder.indexOf(p);
                const done = curPhaseIdx > idx;
                const active = curPhaseIdx === idx;
                return (
                  <Fragment key={p}>
                    {i > 0 && <div className="phase-sep" />}
                    <div className="phase-node">
                      <div className="phase-dot" style={{
                        background: active ? 'var(--blue)' : done ? 'var(--green)' : 'var(--border2)',
                        boxShadow: active ? '0 0 0 3px rgba(26,86,219,.18)' : 'none',
                      }} />
                      <div className="phase-label" style={{ color: active ? 'var(--blue)' : done ? 'var(--green)' : 'var(--muted)' }}>{label}</div>
                    </div>
                  </Fragment>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {phase === 'warmup' && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', background: 'var(--amber-pale)', border: '1px solid rgba(146,64,14,.15)', padding: '3px 10px', borderRadius: 6 }}>
                  Warmup {warmupTurns}/{WARMUP_TURNS}
                </div>
              )}
              {phase === 'interview' && (
                <>
                  {activeTopicName && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      → {activeTopicName}
                    </div>
                  )}
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: timerColor }}>
                    {fmtTime(timeLeft)}
                  </div>
                </>
              )}
              {phase === 'wrapup' && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--blue)', background: 'var(--blue-pale)', border: '1px solid rgba(26,86,219,.15)', padding: '3px 10px', borderRadius: 6 }}>
                  Q&A {wrapupTurns}/{WRAPUP_TURNS}
                </div>
              )}
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>{fmtTime(callDuration)}</div>
            </div>
          </div>

          <div className="center-body">
            {isCallEnded && (
              <div className="end-overlay">
                <div style={{ width: 52, height: 52, borderRadius: 16, background: 'var(--green-pale)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>✓</div>
                <div>
                  <div style={{ fontFamily: 'var(--display)', fontSize: 28, fontWeight: 300, marginBottom: 8, letterSpacing: '-.01em' }}>Interview Complete</div>
                  <div style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.7 }}>
                    {scores.length} topics evaluated · avg {avgScore > 0 ? avgScore.toFixed(1) : '—'}
                  </div>
                </div>
                <button className="restart-btn" onClick={() => { phaseRef.current = 'report'; setPhase('report'); }}>
                  View Full Report →
                </button>
              </div>
            )}

            {conv.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 36, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                {isAriaSpeaking ? '● Aria is speaking...' : 'Waiting to begin...'}
              </div>
            ) : conv.slice(-24).map((entry, i) => (
              <div key={entry.id || i} className="msg">
                <div className={`msg-av ${entry.role}`}>
                  {entry.role === 'ai' ? 'AR' : 'YOU'}
                </div>
                <div className={`msg-text ${entry.role}`}>{entry.text}</div>
              </div>
            ))}

            {/* 🚨 THE NEW LIVE STREAMING BUBBLE 🚨 */}
            {liveTranscript && (
              <div className="msg pulse" style={{ opacity: 0.6 }}>
                <div className={`msg-av ${liveTranscript.role}`}>
                  {liveTranscript.role === 'ai' ? 'AR' : 'YOU'}
                </div>
                <div className={`msg-text ${liveTranscript.role}`}>{liveTranscript.text}</div>
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT ── */}
        <div className="right-col">
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Live Scores</div>
            {scores.length > 0 && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: scoreColor(avgScore), fontWeight: 700 }}>avg {avgScore.toFixed(1)}</div>
            )}
          </div>

          {isScoringBg && (
            <div style={{ padding: '9px 16px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border)', background: 'var(--violet-pale)' }}>
              <div className="spin" style={{ borderTopColor: 'var(--violet)' }} />
              <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--violet)' }}>Scoring in background...</div>
            </div>
          )}

          {scores.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12, fontFamily: 'var(--mono)' }}>
              Scores appear after answers...
            </div>
          ) : [...scores].reverse().map((s, i) => (
            <div key={i} className="score-item fade-in">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{s.topicName}</div>
                <div className="score-badge" style={{
                  background: scoreColor(s.score) + '18',
                  color: scoreColor(s.score),
                  border: `1px solid ${scoreColor(s.score)}30`,
                }}>{s.score}/10</div>
              </div>
              {s.summary && (
                <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.5 }}>{s.summary.slice(0, 100)}...</div>
              )}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <span className="metric-chip">{s.depth}</span>
                <span className="metric-chip">acc: {s.accuracy}/10</span>
              </div>
            </div>
          ))}

          {/* Context debug panel */}
          {liveContext && (
            <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border)', padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--muted)', fontFamily: 'var(--mono)', letterSpacing: '.1em' }}>LIVE CONTEXT</span>
                <button onClick={() => navigator.clipboard.writeText(liveContext)} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 8, cursor: 'pointer', fontFamily: 'var(--mono)' }}>COPY</button>
              </div>
              <pre style={{ fontSize: 7, fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', color: 'var(--muted)', maxHeight: 320, overflowY: 'auto', margin: 0, lineHeight: 1.5 }}>
                {liveContext.slice(0, 1200)}...
              </pre>
            </div>
          )}
        </div>

      </div>
    </LiveKitRoom>
  );
}