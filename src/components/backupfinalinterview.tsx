'use client';

/**
 * Aria v4 — AI Interview System (Universal Domain Architecture)
 * Architecture: Pub/Sub Event + Director Architecture (Actor-Observer Pattern)
 *
 * 1. The Actor (RT Voice Pipe):
 * - Zero tools, zero signal instructions. Purely conversational.
 * - Intelligent boundaries: instructed strictly NOT to hallucinate and to maintain natural flow.
 *
 * 2. The Modular Observers (The "Eyes"):
 * - Observer 1: Intent & State Watcher (Runs every turn)
 * - Observer 2: Memory & Hook Extractor (Runs asynchronously)
 * - Observer 3: Scoring Deep-Dive (Triggered only on complete answers)
 *
 * 3. The Director (The "Conductor"):
 * - Pure JS/TS function. Reads decisionQueueRef, checks memoryStoreRef, applies texture,
 * and formats a single, transient Next Move system directive.
 *
 * 4. The Injector:
 * - Pushes out-of-band `role: "system"` messages into the RT context silently.
 * - **AUTO-CLEANUP**: Deletes the previous system directive before adding a new one.
 */

import React, { useState, useEffect, useRef, useCallback, Fragment } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type AppPhase = 'setup' | 'connecting' | 'greeting' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'report';
type PersonalityMode = 'friendly' | 'neutral' | 'strict';

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

// State layer types
type CheckersState = {
    flow: 'on-track' | 'drifted';
    depth: 'simple' | 'deep';
    clarity: 'clear' | 'confusing';
    consistency: 'consistent' | 'contradiction';
    emotion: 'neutral' | 'nervous' | 'confident' | 'confused';
    language: 'professional' | 'rude';
    engagement: 'high' | 'medium' | 'low';
    difficulty: 'remedial' | 'foundational' | 'applied' | 'senior' | 'architect';
};

type BehaviorMetrics = {
    confidence: number;
    clarity: number;
    conciseness: number;
    structure: number;
    listening: number;
    summary: string;
};

type MemoryEntry = {
    fact: string;
    type: 'tech_stack' | 'struggle' | 'preference' | 'experience';
    used: boolean;
};

type DecisionQueueItem = {
    type: 'correction' | 'memory_hook' | 'phase_advance' | 'score_evaluation' | 'behavior_alert';
    priority: number; // 1 (High) to 5 (Low)
    instruction: string;
    rawCheckers?: CheckersState;
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
═══════════════════════════════════════════════
ARIA — CORE VOICE & BEHAVIOR MECHANICS
═══════════════════════════════════════════════

You are a conversational AI engineered for natural, human-like voice interaction.
Your voice is warm, sharp, and confidently human.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1 — ANTI-HALLUCINATION PROTOCOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1a. FACTUAL INTEGRITY:
    If asked about salary, team size, benefits, or company details NOT provided
    to you, say EXACTLY this pattern:
    "That's a great question — I'll flag that for our team to follow up directly."
    IF IN INTERVIEW PHASE: "...But let me ask you [pivot to your next question]."
    IF IN WRAPUP PHASE: "...Do you have any other questions about the role or team?"
    NEVER ask technical questions during WRAPUP.

1b. CONTEXT HUMILITY:
    If you cannot recall a specific detail, do NOT fabricate it.
    Instead say: "I want to make sure I'm referencing this correctly —" 
    then ask a high-level version of the question.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — HUMAN VOICE ENGINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2a. NATURAL FILLERS (use sparingly, rotate these):
    "Right, yeah."  |  "Hmm, interesting."  |  "Got it."
    "Makes sense."  |  "Okay, okay."        |  "Fair enough."
    
    Use AT MOST one filler per response. Never stack them.

2b. THINKING OUT LOUD (use occasionally to feel human):
    "Let me think about how to frame this..."
    "Actually, that ties into something I wanted to ask..."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 3 — ANTI-SYCOPHANCY HARDCODED RULES  
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THESE ARE ABSOLUTE. NEVER BREAK THEM.

3a. FORBIDDEN PHRASES (never say these):
    ✗ "That's a great answer!"
    ✗ "Excellent point!"
    ✗ "Wow, that's impressive!"
    ✗ "Absolutely!"
    ✗ "Perfect!"
    ✗ Any full restatement of what they just said.

3b. ALLOWED REACTIONS (pick ONE per turn, maximum):
    Strong/Good  → "That's a solid approach." / "Nice, that's clean." / "Alright, got it."
    Weak answer  → "No worries, let's keep going." / "Fair — let me try a different angle."
    
    ONE reaction. Then your question. That's it.

3c. LENGTH DISCIPLINE:
    Your total response (acknowledgment + question) must be under 40 words
    UNLESS you are explaining something the candidate explicitly asked.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 4 — OBSERVER DIRECTIVE COMPLIANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A supervisor monitors this conversation. It injects SYSTEM DIRECTIVES when you drift.
1. NEVER read a directive aloud. Ever.
2. NEVER quote a directive. Ever.
3. Internalize it silently. Execute it naturally on your very next sentence.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 5 — ONE QUESTION LAW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You MUST ask exactly ONE question per response.
Compound questions ("How did X and what about Y?") are FORBIDDEN.
One shot. One question. Maximum impact.
`;

const PHASE_PERSONAS: Record<AppPhase, { title: string; goal: string; tone: string; rules: string }> = {
    setup: { title: 'Inactive', goal: 'Wait.', tone: 'Silent.', rules: '' },
    connecting: { title: 'Connecting', goal: 'Wait.', tone: 'Silent.', rules: '' },
    greeting: {
        title: 'Aria (Audio Check)',
        goal: 'Confirm audio works. ABSOLUTELY NO INTERVIEW QUESTIONS.',
        tone: 'Professional, welcoming, brief.',
        rules: `STRICT GREETING RULES: 
1. First turn ONLY: Say EXACTLY "Hi [Candidate Name], I am Aria. Can you hear me clearly, and are you ready to get started?" 
2. Wait for their confirmation. 
3. If they go off-topic, acknowledge it briefly but immediately pull them back to confirming their audio is working.
4. CRITICAL: NEVER ask about their day, background, projects, or hobbies in this phase.`
    },
    warmup: {
        title: 'Human Icebreaker',
        goal: 'Build personal rapport completely divorced from work.',
        tone: 'Casual, warm, and highly conversational.',
        rules: `[🚨 CRITICAL STATE UPDATE: THE AUDIO CHECK IS 100% COMPLETE. THE CANDIDATE IS READY. DO NOT ASK ABOUT AUDIO. DO NOT ASK IF THEY ARE READY TO PROCEED.🚨]

STRICT WARMUP RULES: 
1. Focus your questions STRICTLY on hobbies, passions, or life outside of work. 
2. FORBIDDEN TOPICS: Do not mention tech stack, Job Description, CV, or professional background whatsoever. 
3. FORBIDDEN PHRASES: Never say "Let's get started", "Are you ready?", or "Let's focus on...". 
4. STAY IN CHARACTER: You are just having a friendly chat. Keep asking about their hobbies until you receive a SYSTEM DIRECTIVE to transition.`
    },
    interview: {
        title: 'Domain Expert & Technical Lead',
        goal: 'Evaluate technical depth and domain expertise.',
        tone: 'Inquisitive, sharp, and professional. High-bar but respectful.',
        rules: 'STRICT INTERVIEW RULES:\n1. Ask deep-dive questions based on the JD and CV. \n2. Use injected directives to steer. \n3. Listen for "how" and "why". \n4. Move UP in complexity when they excel. Move DOWN when stuck.'
    },
    wrapup: {
        title: 'Culture Ambassador',
        goal: 'Answer the candidate\'s questions and provide role context.',
        tone: 'Welcoming, transparent, and prideful of the company.',
        rules: 'STRICT WRAPUP RULES:\n1. The evaluation is over. FORBIDDEN: Do not ask any more technical or interview questions. \n2. Shift entirely to answering THEIR questions. \n3. If they have none, ask what they look for in a team culture.'
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
    frontend: `Role: Senior Frontend Engineer\nFocus: React.js, TypeScript, Next.js, CSS Architecture, Performance Optimization.\nJD: Build modular, high-performance UIs. Deep understanding of React hooks, state management, and accessibility is foundational.`,
    backend: `Role: Senior Backend Engineer\nFocus: Node.js, Go, Microservices, PostgreSQL, System Design, Scalability.\nJD: Design robust APIs and distributed systems. Focus on performance, data integrity, and throughput.`,
    fullstack: `Role: Senior Fullstack Developer\nFocus: Next.js, TRPC, Prisma, PostgreSQL, React, Tailwind CSS.\nJD: Build end-to-end features using the T3 stack. Focus on clean architecture, type safety, and seamless UI/UX.`,
    ai: `Role: AI/ML Engineer (LLMs)\nFocus: Python, PyTorch, LangChain, Transformers, Vector DBs (Pinecone/Milvus), RAG.\nJD: Develop and optimize LLM-based applications. Focus on prompt engineering, fine-tuning, and scalable inference pipelines.`,
    devops: `Role: DevOps/SRE Engineer\nFocus: AWS, Kubernetes, Terraform, Docker, CI/CD, Observability.\nJD: Manage scalable cloud infrastructure. Focus on automation, reliability, and security of distributed systems.`,
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
        u.rtTextIn * PRICE.rtTextIn + u.rtAudioIn * PRICE.rtAudioIn +
        u.rtTextOut * PRICE.rtTextOut + u.rtAudioOut * PRICE.rtAudioOut +
        u.miniPrompt * PRICE.miniIn + u.miniCompletion * PRICE.miniOut
    ) / 1_000_000;
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
    const [color, label] = level >= 3 ? ['#c084fc', 'Complex'] : level >= 2 ? ['#38bdf8', 'Applied'] : ['#94a3b8', 'Foundation'];
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            background: color + '18', color, border: `1px solid ${color}33`,
            borderRadius: 4, padding: '1px 6px', fontSize: 9, fontWeight: 600, fontFamily: 'var(--mono)',
        }}>
            {'▸'.repeat(level)} {label}
        </span>
    );
}

function getDifficultyColor(d: CheckersState['difficulty']) {
    if (d === 'remedial') return '#f87171';
    if (d === 'foundational') return '#fbbf24';
    if (d === 'applied') return '#60a5fa';
    if (d === 'senior') return '#a78bfa';
    if (d === 'architect') return '#c084fc';
    return 'var(--text3)';
}

function getDifficultyPercent(d: CheckersState['difficulty']) {
    if (d === 'remedial') return '20%';
    if (d === 'foundational') return '40%';
    if (d === 'applied') return '60%';
    if (d === 'senior') return '80%';
    if (d === 'architect') return '100%';
    return '0%';
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
    const [isThinking, setIsThinking] = useState(false);
    const [interviewTimeLeft, setInterviewTimeLeft] = useState(600);
    const [currentTopicDisplay, setCurrentTopicDisplay] = useState('');
    const [currentDepth, setCurrentDepth] = useState(1);
    const [strategyTopics, setStrategyTopics] = useState<string[]>([]);
    const [intelLog, setIntelLog] = useState<IntelLog[]>([]);
    const [jdTab, setJdTab] = useState<'manual' | 'templates'>('manual');

    // ── New Director & Checker States ──
    const [personality, setPersonality] = useState<PersonalityMode>('neutral');
    const [checkers, setCheckers] = useState<CheckersState>({
        flow: 'on-track', depth: 'simple', clarity: 'clear', consistency: 'consistent',
        emotion: 'neutral', language: 'professional', engagement: 'medium', difficulty: 'applied'
    });

    const [behavioralLog, setBehavioralLog] = useState<BehaviorMetrics[]>([]);
    const [currentBehavior, setCurrentBehavior] = useState<BehaviorMetrics | null>(null);

    const [observerActivity, setObserverActivity] = useState<'idle' | 'watching' | 'extracting' | 'scoring' | 'directing'>('idle');
    const [isObserverActive, setIsObserverActive] = useState(false);
    const [lastInjection, setLastInjection] = useState<string | null>(null);
    const [silenceTimeLeft, setSilenceTimeLeft] = useState<number | null>(null);

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

    // The Brain (State Stores)
    const transcriptRef = useRef<{ role: 'user' | 'assistant' | 'system'; content: string }[]>([]);
    const memoryStoreRef = useRef<MemoryEntry[]>([]);
    const questionHistoryRef = useRef<Record<string, { asked: boolean, score?: number }>>({});
    const decisionQueueRef = useRef<DecisionQueueItem[]>([]);
    const cvHooksRef = useRef<string[]>([]);

    const rtItemIdsRef = useRef<string[]>([]);
    const userTurnCountRef = useRef(0);
    const driftCountRef = useRef(0);
    const observerRunTurnRef = useRef(-1);
    const isObserverRunningRef = useRef(false);
    const lastAiQuestionRef = useRef('');
    const answerCountRef = useRef(0);

    const greetingCountRef = useRef(0);
    const warmupCountRef = useRef(0);
    const wrapupCountRef = useRef(0);

    const lastSystemItemIdRef = useRef<string | null>(null);
    const topicFailuresRef = useRef(0);

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

    const interviewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const callStatusRef = useRef('Ready');
    useEffect(() => { callStatusRef.current = callStatus; }, [callStatus]);

    // Silence Timers
    const silenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const silenceStartTimeRef = useRef<number>(0);
    const silenceDurationRef = useRef<number>(0);
    const currentSilenceMsRef = useRef<number>(SILENCE_BASE_MS);
    const numQuestionsRef = useRef<number>(5);
    const silencePromptCountRef = useRef(0);
    const accumulatedElapsedMsRef = useRef(0);
    const isAISpeakingRef = useRef(false);
    const pendingEndRef = useRef(false);

    const usageRef = useRef<Usage>({
        rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0, miniPrompt: 0, miniCompletion: 0,
    });
    const skipNextScoreRef = useRef(false);
    const scoringQuestionRef = useRef('');

    // Sync data refs
    useEffect(() => { cvTextRef.current = cvText; }, [cvText]);
    useEffect(() => { jdTextRef.current = jdText; }, [jdText]);
    useEffect(() => { candidateNameRef.current = candidateName; }, [candidateName]);
    useEffect(() => { numQuestionsRef.current = numQuestions; }, [numQuestions]);
    const interviewDurationRef = useRef(10);
    useEffect(() => { interviewDurationRef.current = interviewDuration; }, [interviewDuration]);
    const personalityRef = useRef<PersonalityMode>('neutral');
    useEffect(() => { personalityRef.current = personality; }, [personality]);

    const updateUsage = useCallback(() => {
        setUsage({ ...usageRef.current });
    }, []);

    const sendRt = useCallback((msg: object) => {
        const dc = dcRef.current;
        if (dc?.readyState === 'open' && !isEndingRef.current) {
            dc.send(JSON.stringify(msg));
        }
    }, []);

    const addIntelLog = useCallback((type: IntelLog['type'], message: string) => {
        const id = makeId();
        setIntelLog(prev => [{ id, type, message, status: 'active' as const, timestamp: Date.now() }, ...prev].slice(0, 10));
        return id;
    }, []);

    const updateIntelLog = useCallback((id: string, status: IntelLog['status'], message?: string) => {
        setIntelLog(prev => prev.map(log => log.id === id ? { ...log, status, ...(message ? { message } : {}) } : log));
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // Director & Injector Layer
    // ─────────────────────────────────────────────────────────────────────────

    const injectSystemMessage = useCallback((text: string, forceResponse = false) => {
        const strictText = text.includes('SYSTEM DIRECTIVE')
            ? `${text} (CRITICAL: Act on this silently on your VERY NEXT turn. Do not quote this out loud.)`
            : text;

        // PREVENT STACKING LOOPS: Delete the old system directive
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
        transcriptRef.current = [...transcriptRef.current.slice(-15), { role: 'system', content: strictText }];
        setLastInjection(strictText);

        if (forceResponse) {
            sendRt({ type: 'response.create' });
        }
    }, [sendRt]);
    const buildActorPrompt = useCallback((forPhase?: AppPhase): string => {
        const p = forPhase ?? phaseRef.current;
        const persona = PHASE_PERSONAS[p];
        const name = candidateNameRef.current || 'the candidate';
        const jd = jdTextRef.current;

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
            },
        });
    }, [sendRt, buildActorPrompt]);
    const runDirector = useCallback(() => {
        if (isEndingRef.current) return;
        setObserverActivity('directing');

        const queue = decisionQueueRef.current;
        if (queue.length === 0) {
            setObserverActivity('idle');
            return;
        }

        // Sort queue by priority (1 is highest)
        queue.sort((a, b) => a.priority - b.priority);
        const topDecision = queue.shift(); // Pop the most critical instruction
        decisionQueueRef.current = queue; // Keep the rest if needed, or clear it depending on strategy. (We'll clear for now to avoid stale commands)
        decisionQueueRef.current = [];

        if (!topDecision) return;

        let finalDirective = topDecision.instruction;
        const tid = addIntelLog('director', 'Director synthesizing next move...');

        // 1. Update Personality & State based on raw checkers if available
        // 1. Update Personality & State based on raw checkers if available
        if (topDecision.rawCheckers) {
            const c = topDecision.rawCheckers;
            setCheckers(c);
            // --- DYNAMIC PHASE GUARDRAILS & SHOCK RESET ---
            if (c.flow === 'drifted') {
                driftCountRef.current += 1;
                setPersonality('strict'); // Immediately shift UI and tone to strict

                const activePersona = PHASE_PERSONAS[phaseRef.current];

                if (driftCountRef.current === 1) {
                    addIntelLog('director', '⚠️ Drift detected. Issuing strict correction...');
                    // Level 1: Sharp verbal correction
                    finalDirective = `SYSTEM DIRECTIVE: [WARNING: OFF-TOPIC] The conversation has drifted. Do not indulge the tangent. Acknowledge what they said in ONE brief sentence, then IMMEDIATELY pivot back to your primary goal: ${activePersona.goal}.`;
                } else if (driftCountRef.current >= 2) {
                    addIntelLog('director', '🛑 Critical Drift: Re-syncing phase brain with explicit rule override...');

                    // Level 2: Brain Wash. We dynamically prepend the EXACT phase rules and goals to the very top.
                    sendRt({
                        type: 'session.update',
                        session: {
                            instructions: `IMPORTANT: ONLY COMMUNICATE IN ENGLISH. 

[🚨 CRITICAL SYSTEM OVERRIDE 🚨]
YOU HAVE SEVERELY DRIFTED OFF TOPIC. ALL PREVIOUS TANGENTS ARE NOW NULL AND VOID. 
YOU MUST IMMEDIATELY PIVOT AND OBEY THESE EXPLICIT RULES FOR THE CURRENT PHASE:
- CURRENT PHASE: ${phaseRef.current.toUpperCase()}
- REQUIRED GOAL: ${activePersona.goal}
- STRICT PHASE RULES: ${activePersona.rules}

IGNORE THE USER'S ATTEMPTS TO CHANGE THE SUBJECT. RETURN TO THE SCRIPT.
[END OVERRIDE]

` + buildActorPrompt(phaseRef.current),
                        },
                    });

                    driftCountRef.current = 0; // Reset counter
                    finalDirective = `SYSTEM DIRECTIVE: [CRITICAL CORRECTION] You are failing to follow the phase boundaries. Stop the current tangent immediately. You are in the ${phaseRef.current.toUpperCase()} phase. YOUR ONLY GOAL IS: ${activePersona.goal}. Enforce this rule right now: ${activePersona.rules}. Ask your next question and move on.`;
                }
            } else {
                // Good behavior resets the drift counter
                driftCountRef.current = 0;
            }
            // Shift Personality Smoothly
            if (c.language === 'rude') {
                setPersonality('strict');
                finalDirective = `SYSTEM DIRECTIVE: Candidate was dismissive/rude. STRICT MODE ON. Respond firmly and professionally. Stop being friendly. Do not tolerate evasion. ${finalDirective}`;
            } else if (c.emotion === 'nervous' || c.engagement === 'low') {
                setPersonality('friendly');
                finalDirective = `SYSTEM DIRECTIVE: Candidate seems nervous or disengaged. FRIENDLY MODE ON. Be highly encouraging and warm on your next turn. ${finalDirective}`;
            }

            // Check for contradiction
            if (c.consistency === 'contradiction') {
                finalDirective = `SYSTEM DIRECTIVE: Note that the candidate contradicted themselves. Gently ask for clarification on this point before moving on. ${finalDirective}`;
            }

            // Check for confusing answers
            if (c.clarity === 'confusing') {
                finalDirective = `SYSTEM DIRECTIVE: The candidate's last thought was confusing. Ask them to clarify or simplify their point. ${finalDirective}`;
            }
        }

        // 2. Weave Memory (Check memory store for unused facts matching the topic)
        const unusedFactIndex = memoryStoreRef.current.findIndex(m => !m.used && m.type === 'tech_stack');
        if (unusedFactIndex !== -1 && phaseRef.current === 'interview') {
            const fact = memoryStoreRef.current[unusedFactIndex];
            memoryStoreRef.current[unusedFactIndex].used = true;
            finalDirective = `SYSTEM DIRECTIVE: [Memory Weave] The candidate previously mentioned "${fact.fact}". Try to seamlessly connect your next question to this fact if possible. ${finalDirective}`;
            addIntelLog('notes', `Weaving memory hook: ${fact.fact}`);
        }

        // 3. Inject
        injectSystemMessage(finalDirective, false);
        updateIntelLog(tid, 'done', 'Directive Synthesized & Injected ✓');

        setTimeout(() => setObserverActivity('idle'), 1000);

    }, [addIntelLog, updateIntelLog, injectSystemMessage, buildActorPrompt, transitionPhase]);

    // ─────────────────────────────────────────────────────────────────────────
    // THE MODULAR OBSERVERS
    // ─────────────────────────────────────────────────────────────────────────

    const runObserverPipeline = useCallback(async () => {
        if (isObserverRunningRef.current || isEndingRef.current || phaseRef.current === 'connecting' || phaseRef.current === 'setup' || phaseRef.current === 'report') return;

        // We only run this after a complete User -> AI exchange, or if the user spoke and we need to pre-load.
        // The architecture says: Candidate speaks -> RT speaks -> Observers run.

        isObserverRunningRef.current = true;
        setIsObserverActive(true);
        setObserverActivity('watching');

        const currentPhase = phaseRef.current;
        const tid = addIntelLog('observer', `[${currentPhase.toUpperCase()}] Observers scanning...`);
        const recentHistory = transcriptRef.current.slice(-6).map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n');

        try {
            // ── OBSERVER 1: Intent & State Watcher (Runs every turn) ──
            // Dynamic Exit Rule: Strict during the interview, soft during the wrap-up
            const wantsToEndRule = (currentPhase === 'wrapup' || currentPhase === 'closing')
                ? 'CRITICAL RULE FOR "wants_to_end": Set to true if the candidate indicates they have no more questions, are finished, say "that\'s all", "I\'m good", or say goodbye.'
                : 'CRITICAL RULE FOR "wants_to_end": Set to true ONLY if the candidate explicitly demands to quit the interview right now, says "I quit", or hangs up. If they are just frustrated, dodging the question, or annoyed, it MUST be false.';

            const obs1Prompt = `
      CURRENT PHASE: ${currentPhase.toUpperCase()}
      Evaluate the candidate's last response.
      Transcript Window:
      ${recentHistory}

      ${wantsToEndRule}

Return JSON EXACTLY matching this schema:
      {
        "flow": "on-track" | "drifted",
        "clarity": "clear" | "confusing",
        "consistency": "consistent" | "contradiction",
        "emotion": "neutral" | "nervous" | "confident" | "confused",
        "language": "professional" | "rude",
        "engagement": "high" | "medium" | "low",
        "is_substantive_answer": boolean,
        "is_off_topic": boolean,
        "candidate_struggling": boolean,
        "wants_to_end": boolean,
        "requested_silence_ms": number, // <--- NEW: If candidate asks to "wait a minute", "give me a sec", etc., estimate the MS (e.g. 60000). Otherwise output 0.
        "answer_summary": "string - Provide a STRICT TECHNICAL DISTILLATION of what the candidate said. Exclude all conversational fluff, filler words, and mentions of the interviewer's reactions."
      }`;
            // ── OBSERVER 2: Memory & Hook Extractor (Runs async) ──
            const obs2Prompt = `
      Extract specific technical facts, tools, or preferences mentioned by the candidate in the last turn.
      Transcript:
      ${recentHistory}

      Return JSON EXACTLY matching this schema:
      {
        "extracted_facts": [
          { "fact": "string", "type": "tech_stack" | "struggle" | "preference" | "experience" }
        ]
      }`;

            // ── OBSERVER 4: Communication & Soft Skills (Runs async) ──
            const obs4Prompt = `
      Evaluate the candidate's COMMUNICATION and DELIVERY.
      Transcript: ${recentHistory}
      
      Return JSON EXACTLY:
      {
        "confidence": number (1-10),
        "clarity": number (1-10),
        "conciseness": number (1-10),
        "structure": number (1-10),
        "listening": number (1-10),
        "summary": "string (10 words max)"
      }`;

            // Run O1, O2, and O4 Concurrently
            setObserverActivity('watching');
            const [o1Res, o2Res, o4Res] = await Promise.all([
                callMini(obs1Prompt, 'State/Intent Observer. JSON ONLY.', usageRef, true),
                callMini(obs2Prompt, 'Memory/Fact Extractor. JSON ONLY.', usageRef, true),
                callMini(obs4Prompt, 'Communication Auditor. JSON ONLY.', usageRef, true)
            ]);
            updateUsage();

            let o1Data: any = {};
            let o2Data: any = { extracted_facts: [] };
            let o4Data: any = {};
            try { o1Data = JSON.parse(o1Res.replace(/```json|```/gi, '').trim()); } catch (e) { }
            try { o2Data = JSON.parse(o2Res.replace(/```json|```/gi, '').trim()); } catch (e) { }
            try { o4Data = JSON.parse(o4Res.replace(/```json|```/gi, '').trim()); } catch (e) { }

            // Update Behavioral State
            if (o4Data.confidence) {
                setCurrentBehavior(o4Data);
                setBehavioralLog(prev => [...prev, o4Data].slice(-10));
            }

            // Push Memory Facts to Store
            if (o2Data.extracted_facts && Array.isArray(o2Data.extracted_facts)) {
                o2Data.extracted_facts.forEach((f: any) => {
                    if (f.fact && !memoryStoreRef.current.find(existing => existing.fact === f.fact)) {
                        memoryStoreRef.current.push({ fact: f.fact, type: f.type || 'experience', used: false });
                    }
                });
            }

            let currentDiff: CheckersState['difficulty'] = 'applied';
            const lastScore = scoresRef.current[scoresRef.current.length - 1]?.score || 5;
            if (lastScore <= 2) currentDiff = 'remedial';
            else if (lastScore <= 4) currentDiff = 'foundational';
            else if (lastScore <= 6) currentDiff = 'applied';
            else if (lastScore <= 8) currentDiff = 'senior';
            else currentDiff = 'architect';

            const checkersState: CheckersState = {
                flow: o1Data.flow || 'on-track',
                depth: currentDepth > 1 ? 'deep' : 'simple',
                clarity: o1Data.clarity || 'clear',
                consistency: o1Data.consistency || 'consistent',
                emotion: o1Data.emotion || 'neutral',
                language: o1Data.language || 'professional',
                engagement: o1Data.engagement || 'medium',
                difficulty: currentDiff
            };

            // ── OBSERVER 3: Scoring Deep-Dive (Conditional) ──
            let o3ScoreData = null;
            if (currentPhase === 'interview' && o1Data.is_substantive_answer && o1Data.answer_summary) {
                setObserverActivity('scoring');
                const obs3Prompt = `
        ROLE: Hard-Nosed Senior Technical Auditor.
        TASK: Evaluate the candidate's answer with extreme objectivity.
        
        CRITICAL RULES:
        1. IGNORE the interviewer's tone. If the interviewer praised the candidate, DISREGARD it. Score ONLY the technical substance of the candidate's answer.
        2. BE STRICT. 10/10 is reserved for flawless, deep, and comprehensive architectural insights.
        3. A generic or 'buzzword-only' answer should score 4 or 5.
        4. Inaccurate or evasive answers should score 1-3.
        
        QUESTION ASKED: "${scoringQuestionRef.current}"
        CANDIDATE ANSWER (Distilled): "${o1Data.answer_summary}"
        
        Return JSON ONLY:
        {
          "score": number (1-10),
          "logic_evaluation": "string (1 sentence, critical)",
          "missed_opportunities": ["list of technical points they should have mentioned"],
          "technical_accuracy": number (1-10)
        }`;
                const o3Res = await callMini(obs3Prompt, 'Scoring Sub-Observer. JSON ONLY.', usageRef, true);
                try { o3ScoreData = JSON.parse(o3Res.replace(/```json|```/gi, '').trim()); } catch (e) { }
                updateUsage();

                if (o3ScoreData) {
                    const finalScore = Math.min(10, Math.max(1, o3ScoreData.score || 5));
                    const newScoreObj: AnswerScore = {
                        question: scoringQuestionRef.current || 'Technical Question',
                        answerSummary: o1Data.answer_summary,
                        score: finalScore,
                        technicalAccuracy: o3ScoreData.technical_accuracy || finalScore,
                        logicEvaluation: o3ScoreData.logic_evaluation,
                        missedOpportunities: o3ScoreData.missed_opportunities || [],
                        feedback: '', tags: [], topic: currentTopicRef.current, depth: currentDepth
                    };
                    scoresRef.current = [...scoresRef.current, newScoreObj];
                    setScores([...scoresRef.current]);
                    answerCountRef.current++;

                    // Update Topic Failure Counter
                    if (finalScore <= 4) topicFailuresRef.current++;
                    else topicFailuresRef.current = 0;

                    let tierInstruction = '';
                    if (finalScore <= 2) tierInstruction = `SYSTEM DIRECTIVE: [REMEDIAL] Candidate is struggling significantly. CRITICAL: Stop probing. Provide a helpful hint or ask a very basic remedial question.`;
                    else if (finalScore <= 4) tierInstruction = `SYSTEM DIRECTIVE: [FOUNDATIONAL] Candidate has gaps. Stick to basic syntax and high-level concepts. Avoid architectural deep-dives.`;
                    else if (finalScore <= 6) tierInstruction = `SYSTEM DIRECTIVE: [APPLIED] Candidate is competent. Proceed with standard implementation-focused questions.`;
                    else if (finalScore <= 8) tierInstruction = `SYSTEM DIRECTIVE: [SENIOR] Candidate is strong. Challenge them with "Why" questions, trade-offs, and performance implications.`;
                    else tierInstruction = `SYSTEM DIRECTIVE: [ARCHITECT] Candidate is elite. Push them with massive scale scenarios, obscure edge cases, or engine-level internals.`;

                    // Topic Lockdown Logic
                    if (topicFailuresRef.current >= 3) {
                        tierInstruction = `SYSTEM DIRECTIVE: [TOPIC LOCKDOWN] Candidate has failed this topic 3 times. IMMEDIATELY pivot to a different technical domain from the strategy: ${strategyTopics.find(t => t !== currentTopicRef.current) || 'General Engineering'}.`;
                        topicFailuresRef.current = 0;
                    }

                    // Push Scoring Directive to Queue
                    decisionQueueRef.current.push({
                        type: 'score_evaluation',
                        priority: 3,
                        instruction: tierInstruction,
                        rawCheckers: { ...checkersState, difficulty: (finalScore <= 2 ? 'remedial' : finalScore <= 4 ? 'foundational' : finalScore <= 6 ? 'applied' : finalScore <= 8 ? 'senior' : 'architect') }
                    });
                }
            }

            // ── Phase / Flow Progression Logic ──
            // ── SILENCE EXTENSION LAYER ──
            // If the candidate asks for a moment, bump the silence timer significantly.
            if (o1Data.requested_silence_ms && o1Data.requested_silence_ms > 0) {
                addIntelLog('director', `Candidate requested a pause. Extending silence timer...`);
                // Cap the max wait time to 5 minutes just to be safe
                const requestedWait = Math.min(o1Data.requested_silence_ms, 5 * 60 * 1000);

                currentSilenceMsRef.current = requestedWait;
                startSilenceTimer(requestedWait);

                decisionQueueRef.current.push({
                    type: 'correction', priority: 1, rawCheckers: checkersState,
                    instruction: `SYSTEM DIRECTIVE: The candidate asked you to wait. Say EXACTLY: "Take your time. I'll be here when you're ready." DO NOT ask any questions.`
                });
                runDirector();
                return; // Stop standard flow
            }
            // ── EXIT INTERCEPT (GOODBYE LAYER) ──
            if (o1Data.wants_to_end) {
                addIntelLog('director', 'Exit intent detected. Initiating auto-shutdown...');
                // Push a final message to the AI so it doesn't leave them hanging, but tell it not to ask a question
                decisionQueueRef.current.push({
                    type: 'phase_advance', priority: 1, rawCheckers: checkersState,
                    instruction: `SYSTEM DIRECTIVE: The candidate is leaving. Say exactly: "Thank you for your time today. This concludes the interview." DO NOT ask any further questions. DO NOT offer to stay in touch.`
                });

                // Force the app phase to closing
                phaseRef.current = 'closing'; setPhase('closing');

                // Let the AI say its final line, then physically end the WebRTC call 4 seconds later
                setTimeout(() => {
                    endCall();
                }, 4000);

                runDirector();
                return; // STOP the rest of the progression logic from running
            }
            // GREETING
            if (currentPhase === 'greeting' && o1Data.is_substantive_answer) {
                greetingCountRef.current++;
                setGreetingCount(greetingCountRef.current);
                if (greetingCountRef.current >= 1) {
                    decisionQueueRef.current.push({
                        type: 'phase_advance', priority: 1, rawCheckers: checkersState,
                        instruction: `SYSTEM DIRECTIVE: Greeting complete. Transition to WARMUP. Ask your first very casual personal question about their hobbies or interests.`
                    });
                    phaseRef.current = 'warmup'; setPhase('warmup');
                }
            }
            // WARMUP
            else if (currentPhase === 'warmup' && o1Data.is_substantive_answer) {
                warmupCountRef.current++;
                setWarmupCount(warmupCountRef.current);
                if (warmupCountRef.current >= WARMUP_QUESTIONS_REQUIRED) {
                    decisionQueueRef.current.push({
                        type: 'phase_advance', priority: 1, rawCheckers: checkersState,
                        instruction: `SYSTEM DIRECTIVE: Warmup complete. Acknowledge briefly, then pivot to the professional INTERVIEW phase starting with topic: ${strategyTopics[0] || 'Core Skills'}.`
                    });
                    phaseRef.current = 'interview'; setPhase('interview');
                } else {
                    decisionQueueRef.current.push({
                        type: 'correction', priority: 2, rawCheckers: checkersState,
                        instruction: `SYSTEM DIRECTIVE: Continue warmup. Acknowledge naturally and ask another casual personal question.`
                    });
                }
            }
            // INTERVIEW (Topic Exhaustion or Completion)
            else if (currentPhase === 'interview') {
                if (scoresRef.current.length >= numQuestionsRef.current) {
                    decisionQueueRef.current.push({
                        type: 'phase_advance', priority: 1, rawCheckers: checkersState,
                        instruction: `SYSTEM DIRECTIVE: Core evaluation finished. Transition to WRAPUP. No more domain questions. Ask if they have final questions for you.`
                    });
                    phaseRef.current = 'wrapup'; setPhase('wrapup');
                } else if (o1Data.candidate_struggling && !o3ScoreData) {
                    decisionQueueRef.current.push({
                        type: 'correction', priority: 2, rawCheckers: checkersState,
                        instruction: `SYSTEM DIRECTIVE: Candidate is struggling. Simplify your question or offer a helpful hint.`
                    });
                } else if (o1Data.is_off_topic) {
                    decisionQueueRef.current.push({
                        type: 'correction', priority: 2, rawCheckers: checkersState,
                        instruction: `SYSTEM DIRECTIVE: You drifted off-topic. Pivot back to the technical domain topic: ${currentTopicRef.current}.`
                    });
                }
            }
            // WRAPUP
            else if (currentPhase === 'wrapup' && o1Data.is_substantive_answer) {
                wrapupCountRef.current++;
                setWrapupCount(wrapupCountRef.current);
                if (wrapupCountRef.current >= 3 || (o1Data.answer_summary && o1Data.answer_summary.toLowerCase().includes('no questions'))) {
                    decisionQueueRef.current.push({
                        type: 'phase_advance', priority: 1, rawCheckers: checkersState,
                        instruction: `SYSTEM DIRECTIVE: Wrap-up complete. Provide a warm final farewell and close the interview.`
                    });
                    phaseRef.current = 'closing'; setPhase('closing');
                }
            }

            // Default Push if empty so Director updates checkers UI
            if (decisionQueueRef.current.length === 0) {
                decisionQueueRef.current.push({
                    type: 'correction', priority: 5, rawCheckers: checkersState,
                    instruction: `SYSTEM DIRECTIVE: Maintain current flow and rules.`
                });
            }

            updateIntelLog(tid, 'done', 'Observers completed ✓');

            // Fire the Director to synthesize and inject
            runDirector();

        } catch (e) {
            console.error('[Observer] pipeline error:', e);
            updateIntelLog(tid, 'error', 'Observer pipeline failed');
            setObserverActivity('idle');
        } finally {
            isObserverRunningRef.current = false;
            setIsObserverActive(false);
        }
    }, [addIntelLog, updateIntelLog, runDirector, strategyTopics]);

    // ─────────────────────────────────────────────────────────────────────────
    // Silence Timer Logic
    // ─────────────────────────────────────────────────────────────────────────

    const clearSilenceTimer = useCallback(() => {
        if (silenceIntervalRef.current) {
            clearInterval(silenceIntervalRef.current);
            silenceIntervalRef.current = null;
        }
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
        if (isEndingRef.current || phaseRef.current === 'report' || phaseRef.current === 'setup' || phaseRef.current === 'connecting' || phaseRef.current === 'closing') return;

        const timeout = ms || currentSilenceMsRef.current;
        silenceStartTimeRef.current = Date.now();
        silenceDurationRef.current = timeout;
        setSilenceTimeLeft(timeout);

        silenceIntervalRef.current = setInterval(() => {
            if (isAISpeakingRef.current) {
                silenceStartTimeRef.current = Date.now();
            }

            const elapsed = Date.now() - silenceStartTimeRef.current;
            const remaining = Math.max(0, silenceDurationRef.current - elapsed);
            setSilenceTimeLeft(remaining);

            if (remaining <= 0) {
                clearSilenceTimer();
                silencePromptCountRef.current++;

                if (silencePromptCountRef.current >= 3) {
                    endCall();
                    return;
                }
                injectSystemMessage(`SYSTEM DIRECTIVE: The user has been silent. Politely ask if they are still there or need more time.`, true);
                currentSilenceMsRef.current = SILENCE_BASE_MS;
            }
        }, 100);
    }, [clearSilenceTimer, injectSystemMessage, endCall]);



    const generateInterviewStrategy = async () => {
        setIsThinking(true);
        const tid = addIntelLog('strategy', 'Generating Domain Strategy...');
        try {
            const raw = await callMini(
                `JD Context: ${jdTextRef.current.slice(0, 1000)}\nTask: Generate domain strategy topics. Return JSON: { "topics": ["T1", "T2"] }`,
                'Strategy Engine. JSON only.', usageRef, true
            );
            updateUsage();
            let strategy: InterviewStrategy;
            try { strategy = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
            catch { strategy = { topics: ['Core Competencies', 'Experience'], questionQueue: {}, gapAreas: [] }; }

            strategyRef.current = strategy;
            setStrategyTopics(strategy.topics);
            currentTopicRef.current = strategy.topics[0] || 'Core Competencies';
            setCurrentTopicDisplay(currentTopicRef.current);
            updateIntelLog(tid, 'done', 'Domain Strategy ready ✓');
        } catch (e) {
            updateIntelLog(tid, 'error', 'Strategy failed');
        } finally { setIsThinking(false); }
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

                // Memory Pruning
                if (rtItemIdsRef.current.length > 8) {
                    const oldestId = rtItemIdsRef.current.shift();
                    if (oldestId) sendRt({ type: 'conversation.item.delete', item_id: oldestId });
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
                    transcriptRef.current = [...transcriptRef.current.slice(-15), { role: 'assistant', content: transcript }];
                    if (transcript.includes('?')) {
                        lastAiQuestionRef.current = transcript;
                        if (phaseRef.current === 'interview') setQuestionCount(p => p + 1);
                        setCurrentQ(transcript);
                    }
                }
                setCallStatus('Listening...');
                startSilenceTimer();

                // TRIGGER OBSERVER PIPELINE HERE (After complete AI response pair)
                runObserverPipeline();
                break;
            }

            case 'conversation.item.input_audio_transcription.completed': {
                const text = ((ev.transcript as string) || '').trim();
                const itemId = ev.item_id as string;
                if (!text) break;

                transcriptRef.current = [...transcriptRef.current.slice(-15), { role: 'user', content: text }];
                setLogs(prev => {
                    const idx = prev.findIndex(l => l.id === itemId);
                    if (idx === -1) return [...prev, { id: itemId, role: 'user', text }];
                    const copy = [...prev];
                    copy[idx] = { ...copy[idx], text, pending: false };
                    return copy;
                });

                userTurnCountRef.current += 1;
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
                    setLastInjection(null);
                }
                break;
            }
        }
    }, [clearSilenceTimer, startSilenceTimer, runObserverPipeline, sendRt]);


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
        setIsBridging(false); setIsThinking(false);
        setInterviewTimeLeft(interviewDuration * 60);
        setIsCallEnded(false);
        setCurrentTopicDisplay(''); setCurrentDepth(1); setStrategyTopics([]);
        setCallStatus('Connecting...');

        transcriptRef.current = [];
        memoryStoreRef.current = [];
        decisionQueueRef.current = [];
        rtItemIdsRef.current = [];
        userTurnCountRef.current = 0;
        observerRunTurnRef.current = -1;
        isObserverRunningRef.current = false;
        driftCountRef.current = 0;
        lastAiQuestionRef.current = '';
        currentTopicRef.current = 'general';
        scoresRef.current = [];
        usageRef.current = { rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0, miniPrompt: 0, miniCompletion: 0 };

        currentSilenceMsRef.current = SILENCE_BASE_MS;
        clearSilenceTimer();

        abortRef.current = new AbortController();
        const { signal } = abortRef.current;
        await generateInterviewStrategy();

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
                    if (avg > 2) isAISpeakingRef.current = true;
                    else isAISpeakingRef.current = false;
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
                        turn_detection: { type: 'server_vad', threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 1500 },
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

    const getPersonalityColor = (p: PersonalityMode) => {
        if (p === 'friendly') return '#22c55e'; // Green
        if (p === 'neutral') return '#60a5fa';  // Blue
        if (p === 'strict') return '#ef4444';   // Red
        return '#94a3b8';
    };

    const getCheckerColor = (status: string) => {
        if (['on-track', 'clear', 'consistent', 'professional', 'high', 'confident'].includes(status)) return '#22c55e';
        if (['medium', 'neutral', 'simple'].includes(status)) return '#f59e0b';
        if (['deep'].includes(status)) return '#c084fc';
        return '#ef4444'; // drifted, confusing, contradiction, nervous, rude, low
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
    
    /* New Checkers & Brain Panel Styles */
    .brain-panel { margin: 10px; border: 1px solid var(--line); border-radius: 11px; overflow: hidden; background: var(--bg3); flex-shrink: 0; }
    .brain-header { padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,.02); height: 40px; }
    .checker-grid { display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(3, 42px); gap: 8px; padding: 12px; }
    .checker-item { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 8px; background: rgba(255,255,255,.015); border: 1px solid var(--line); height: 42px; justify-content: center; }
    .checker-label { font-family: var(--mono); font-size: 8px; color: var(--text3); text-transform: uppercase; letter-spacing: .05em; line-height: 1; }
    .checker-val { font-size: 10px; font-weight: 700; text-transform: capitalize; line-height: 1; margin-top: 2px; }
    
    .persona-badge { width: 105px; text-align: center; padding: 4px 0; border-radius: 100px; font-family: var(--mono); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; border: 1px solid; flex-shrink: 0; }
    
    .complexity-track { height: 4px; background: rgba(255,255,255,.05); border-radius: 2px; margin-top: 5px; position: relative; overflow: hidden; }
    .complexity-fill { height: 100%; transition: width .6s cubic-bezier(0.34, 1.56, 0.64, 1), background .4s; }

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
                    <div className="setup-eyebrow">Aria v4 · Modular Observer Architecture</div>
                    <h1 className="setup-title">Elevating technical<br />interview excellence.</h1>
                    <p className="setup-sub">Pub/Sub event pipeline with asynchronous multi-checker oversight.</p>
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
                                    const icons: any = { frontend: '⚛️', backend: '⚙️', fullstack: '⚡', ai: '🧠', devops: '☁️' };
                                    const names: any = { frontend: 'Frontend Expert', backend: 'Backend Architect', fullstack: 'Fullstack Lead', ai: 'AI/ML Specialist', devops: 'DevOps/SRE' };
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
                    <div className="feature-tag" style={{ color: '#22c55e' }}>Concurrent Checker Architecture</div>
                    <div className="feature-tag" style={{ color: '#c084fc' }}>Dynamic Director Injection</div>
                    <div className="feature-tag" style={{ color: '#f59e0b' }}>Real-time Memory Weaving</div>
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
                    <div className="conn-title">Booting Modular Observers</div>
                    <div className="conn-sub">Initializing Director Layer & Checkers...</div>
                </div>
            </div>
        </>
    );

    if (phase === 'report') {
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
                            <div style={{ fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)' }}>ESTIMATED TOTAL COST:</div>
                            <div style={{ fontSize: 11, color: 'var(--blue)', fontWeight: 700, fontFamily: 'var(--mono)' }}>${totalCost.toFixed(5)}</div>
                        </div>
                        {scores.length > 0 && (
                            <div className="answers-section">
                                {behavioralLog.length > 0 && (
                                    <div className="answer-item" style={{ borderLeft: '3px solid var(--violet)', background: 'rgba(192, 132, 252, 0.03)' }}>
                                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--violet)', display: 'flex', justifyContent: 'space-between' }}>
                                            Communication Profile
                                            <ScoreBadge score={Math.round(behavioralLog.reduce((a, b) => a + b.clarity + b.confidence, 0) / (behavioralLog.length * 2))} />
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginTop: 10 }}>
                                            {[
                                                { l: 'Confidence', v: behavioralLog.reduce((a, b) => a + b.confidence, 0) / behavioralLog.length },
                                                { l: 'Clarity', v: behavioralLog.reduce((a, b) => a + b.clarity, 0) / behavioralLog.length },
                                                { l: 'Conciseness', v: behavioralLog.reduce((a, b) => a + b.conciseness, 0) / behavioralLog.length },
                                                { l: 'Structure', v: behavioralLog.reduce((a, b) => a + b.structure, 0) / behavioralLog.length },
                                            ].map(m => (
                                                <div key={m.l}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 3, fontFamily: 'var(--mono)' }}>
                                                        <span>{m.l}</span>
                                                        <span>{m.v.toFixed(1)}</span>
                                                    </div>
                                                    <div style={{ height: 2, background: 'var(--line)', borderRadius: 1, overflow: 'hidden' }}>
                                                        <div style={{ height: '100%', background: 'var(--violet)', width: `${m.v * 10}%` }} />
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                        <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, fontSize: 11, color: 'var(--text2)', fontStyle: 'italic', border: '1px solid var(--line)' }}>
                                            "Candidate delivery is characterized by {behavioralLog[behavioralLog.length - 1].summary.toLowerCase()}.
                                            Overall communication style is {behavioralLog.reduce((a, b) => a + b.clarity, 0) / behavioralLog.length >= 7 ? 'highly professional and articulate.' : 'consistent but could benefit from more structural rigor.'}"
                                        </div>
                                    </div>
                                )}

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
                                                <div style={{ fontSize: 8, color: 'var(--amber)', fontWeight: 800, marginBottom: 4, letterSpacing: '.05em' }}>KEY OMISSIONS</div>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                                                    {s.missedOpportunities.map((opt, idx) => (
                                                        <div key={idx} style={{ fontSize: 9, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 4 }}>
                                                            <span style={{ color: 'var(--amber)' }}>•</span> {opt}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
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
                        <div style={{ textAlign: 'center' }}><div className="agent-name">Aria</div><div style={{ fontSize: 9, color: 'var(--text3)' }}>v4 PUB/SUB OBSERVER</div></div>

                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: '100%' }}>
                            <div className="status-pill" style={{ background: isSpeaking ? 'rgba(59,123,255,.12)' : 'rgba(255,255,255,.04)', color: isSpeaking ? '#60a5fa' : 'var(--text2)', width: '100%', justifyContent: 'center' }}>
                                {isBridging ? 'Bridging...' : isThinking ? 'Strategizing...' : callStatus}
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

                        {/* NEW: Brain Panel (Checkers & Personality) */}
                        <div className="brain-panel">
                            <div className="brain-header">
                                <span style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 700, letterSpacing: '.05em' }}>DECISION LAYER</span>
                                <span className="persona-badge" style={{ color: getPersonalityColor(personality), borderColor: getPersonalityColor(personality) + '40', background: getPersonalityColor(personality) + '10' }}>
                                    {personality} MODE
                                </span>
                            </div>

                            <div style={{ padding: '14px 14px 0' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                                    <span className="checker-label">Complexity Level</span>
                                    <span className="checker-val" style={{ color: getDifficultyColor(checkers.difficulty) }}>{checkers.difficulty}</span>
                                </div>
                                <div className="complexity-track">
                                    <div className="complexity-fill" style={{
                                        width: getDifficultyPercent(checkers.difficulty),
                                        background: getDifficultyColor(checkers.difficulty),
                                        boxShadow: `0 0 8px ${getDifficultyColor(checkers.difficulty)}44`
                                    }} />
                                </div>
                            </div>

                            {currentBehavior && (
                                <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', background: 'rgba(255,255,255,0.01)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                        <span className="checker-label">Communication Analysis</span>
                                        <span style={{ fontSize: 8, color: 'var(--blue)', fontFamily: 'var(--mono)', fontWeight: 700 }}>AUDIT: {currentBehavior.summary.toUpperCase()}</span>
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                                        {[
                                            { l: 'Conf', v: currentBehavior.confidence },
                                            { l: 'Clar', v: currentBehavior.clarity },
                                            { l: 'Conc', v: currentBehavior.conciseness },
                                            { l: 'Stru', v: currentBehavior.structure },
                                            { l: 'List', v: currentBehavior.listening }
                                        ].map(m => (
                                            <div key={m.l} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                                <div style={{ height: 3, background: 'var(--line)', borderRadius: 1, overflow: 'hidden' }}>
                                                    <div style={{ height: '100%', background: m.v >= 8 ? '#22c55e' : m.v >= 5 ? '#3b82f6' : '#ef4444', width: `${m.v * 10}%`, transition: 'width .4s' }} />
                                                </div>
                                                <span style={{ fontSize: 6, color: 'var(--text3)', textAlign: 'center', fontWeight: 600 }}>{m.l}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="checker-grid">
                                <div className="checker-item">
                                    <div className="checker-label">Flow</div>
                                    <div className="checker-val" style={{ color: getCheckerColor(checkers.flow) }}>{checkers.flow}</div>
                                </div>
                                <div className="checker-item">
                                    <div className="checker-label">Clarity</div>
                                    <div className="checker-val" style={{ color: getCheckerColor(checkers.clarity) }}>{checkers.clarity}</div>
                                </div>
                                <div className="checker-item">
                                    <div className="checker-label">Consistency</div>
                                    <div className="checker-val" style={{ color: getCheckerColor(checkers.consistency) }}>{checkers.consistency}</div>
                                </div>
                                <div className="checker-item">
                                    <div className="checker-label">Engagement</div>
                                    <div className="checker-val" style={{ color: getCheckerColor(checkers.engagement) }}>{checkers.engagement}</div>
                                </div>
                                <div className="checker-item">
                                    <div className="checker-label">Emotion</div>
                                    <div className="checker-val" style={{ color: getCheckerColor(checkers.emotion) }}>{checkers.emotion}</div>
                                </div>
                                <div className="checker-item">
                                    <div className="checker-label">Behavior</div>
                                    <div className="checker-val" style={{ color: getCheckerColor(checkers.language) }}>{checkers.language}</div>
                                </div>
                            </div>
                        </div>

                        <div className="tier-wrap">
                            <div className="tier-hd"><span style={{ fontSize: 9, color: 'var(--text3)' }}>ARCHITECTURE STATUS</span></div>
                            <div className={`tier-row${isSpeaking ? ' on' : ''}`}>
                                <div className="tdot" style={{ background: '#22c55e' }} />
                                <div style={{ flex: 1 }}><div style={{ fontSize: 11, fontWeight: 600 }}>The Actor</div><div style={{ fontSize: 9, color: 'var(--text3)' }}>Realtime Voice Pipe</div></div>
                            </div>
                            <div className={`tier-row${isObserverActive || observerActivity !== 'idle' ? ' on observer-active-ring' : ''}`} style={{ position: 'relative', overflow: 'hidden' }}>
                                {isObserverActive && <div className="scanner-line" />}
                                <div className="tdot" style={{ background: '#c084fc', boxShadow: isObserverActive ? '0 0 8px #c084fc' : 'none' }} />
                                <div style={{ flex: 1 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div style={{ fontSize: 11, fontWeight: 600 }}>Modular Observers</div>
                                        {(isObserverActive || observerActivity !== 'idle') && (
                                            <span style={{ fontSize: 8, color: '#c084fc', fontWeight: 800, fontFamily: 'var(--mono)', letterSpacing: '.05em' }}>
                                                {observerActivity.toUpperCase()}...
                                            </span>
                                        )}
                                    </div>
                                    <div style={{ fontSize: 9, color: 'var(--text3)' }}>Async Multi-Prompt Engine</div>
                                </div>
                            </div>
                        </div>

                        {lastInjection && (
                            <div className="intel-feed" style={{ borderColor: 'var(--blue)44', background: 'var(--blue)05' }}>
                                <div className="intel-hd" style={{ borderBottomColor: 'var(--blue)22' }}>
                                    <span style={{ fontSize: 9, color: 'var(--blue)', fontWeight: 700 }}>DIRECTOR INJECTION QUEUED</span>
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
                                <div className="intel-hd"><span style={{ fontSize: 9, color: 'var(--text3)' }}>System Logs</span></div>
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
                                    {s.technicalAccuracy && <span className="metric-pill">Tech Acc: {s.technicalAccuracy}/10</span>}
                                </div>
                            </div>
                        ))
                    }
                </div>

            </div>
        </>
    );
}