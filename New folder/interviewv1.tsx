'use client';

/**
 * AI Interview System — Clean Architecture
 *
 * COST TIERS:
 *  Layer 1 — gpt-4o-mini-realtime (WebRTC) — always-on voice, cheap, fast
 *  Layer 2 — /api/escalate → gpt-4o-mini   — moderate reasoning (follow-ups, standard Qs)
 *  Layer 3 — /api/escalate → gpt-4o        — deep reasoning (scoring, hard probing Qs)
 *
 * COST SAVINGS MECHANISMS:
 *  1. Selective escalation — RT model only thinks for simple flow; complex tasks offloaded
 *  2. CV on-demand fetch  — full CV never in RT context; fetched per-topic when needed
 *  3. Context pruning     — old conversation items deleted from RT window every N turns
 *  4. Smart notes         — rolling summary replaces raw history in RT context
 *  5. Response filter     — strip markdown/bullets before RT speaks (separate mini call)
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Icons (inline SVG to avoid import issues) ───────────────────────────────

const Icon = {
    Mic: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
        </svg>
    ),
    MicOff: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" /><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
        </svg>
    ),
    PhoneOff: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07" /><path d="M14.49 9.49a4 4 0 0 0-5.66-5.66" /><line x1="1" y1="1" x2="23" y2="23" />
        </svg>
    ),
    Brain: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z" /><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z" />
        </svg>
    ),
    Zap: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
    ),
    Upload: () => (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
        </svg>
    ),
    Check: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
        </svg>
    ),
    Star: () => (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
    ),
    AlertCircle: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
    ),
    File: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" />
        </svg>
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'setup' | 'connecting' | 'live' | 'ended';
type EscalState = 'idle' | 'fetching' | 'delivering';
type InterviewStage = 'warmup' | 'experience' | 'technical' | 'culture' | 'candidate_questions';
type WarmupStep = 'opening_confirmation' | 'awaiting_cv_confirmation' | 'awaiting_personal_life' | 'done';
type ToolSpeechPhase = 'none' | 'filler' | 'waiting_result' | 'result';

type PendingToolResponse = {
    callId: string;
    result: string;
    instruction: string;
};

type LogEntry = {
    id: string;
    role: 'user' | 'ai';
    text: string;
    pending?: boolean;
    escalated?: boolean;
    pruned?: boolean;
};

type AnswerScore = {
    question: string;
    answerSummary: string;
    score: number;
    feedback: string;
    tags: string[];
};

type Usage = {
    rtTextIn: number;
    rtAudioIn: number;
    rtTextOut: number;
    rtAudioOut: number;
    miniPrompt: number;
    miniCompletion: number;
    gpt4oPrompt: number;
    gpt4oCompletion: number;
    filterPrompt: number;
    filterCompletion: number;
};

// ─── Pricing (per 1M tokens) ──────────────────────────────────────────────────

const PRICE = {
    rtAudioIn: 10.0,
    rtAudioOut: 20.0,
    rtTextIn: 0.60,
    rtTextOut: 2.40,
    miniIn: 0.15,
    miniOut: 0.60,
    gpt4oIn: 2.50,
    gpt4oOut: 10.0,
    stdAudioIn: 40.0,   // what it'd cost with standard realtime
    stdAudioOut: 80.0,
} as const;

// ─── Constants ────────────────────────────────────────────────────────────────

const ESCALATION_TIMEOUT_MS = 9000;
const PRUNE_EVERY_N_TURNS = 4;       // prune RT context every N user turns
const KEEP_ITEMS_IN_RT = 6;          // items to keep in RT context window
const HISTORY_FOR_ESCALATION = 12;   // turns of history sent to escalation calls
const SILENCE_CHECK_MS = 15000;      // ms before checking if candidate is silent
const DEFAULT_IDLE_SECONDS = Math.floor(SILENCE_CHECK_MS / 1000);
const MIN_IDLE_SECONDS = 10;
const MAX_IDLE_SECONDS = 10 * 60;
// General thinking fillers — used before escalate_thinking
const FILLER_PHRASES = [
    'Right, so...',
    'Yeah, that makes sense...',
    'Interesting...',
    'Okay, shifting gears a bit...',
    'Hmm, let me think on that for a second...',
    'Good point, hang on...',
];

// CV lookup fillers — used before fetch_cv_info
const CV_FILLER_PHRASES = [
    'Hold on, let me just pull up your CV...',
    'One second, let me check your background on that...',
    'Let me just have a look at your CV here...',
    'Bear with me one sec, I\'m just checking your profile...',
    'Hold on — I just want to make sure I have the right details in front of me...',
    'Let me just look that up quickly...',
    'One moment, checking your CV...',
    'Hang on, I\'ll just pull that up...',
];

const JD_TEMPLATES = [
    {
        id: 'frontend',
        title: 'Frontend Engineer',
        desc: 'React, Next.js, UI engineering',
        content: `We are looking for a Frontend Engineer to build premium web experiences.

Core Responsibilities:
- Build high-performance React/Next.js interfaces.
- Implementation of responsive layouts & sleek animations.
- Optimizing for Core Web Vitals and SEO.
- Collaborating with Design via Figma.

Requirements:
- 3+ years React experience.
- Expert TypeScript & Vanilla CSS / Tailwind knowledge.
- Familiarity with Framer Motion or GSAP.`
    },
    {
        id: 'backend',
        title: 'Backend Engineer',
        desc: 'Node.js, PostgreSQL, System Design',
        content: `Seeking a Backend Engineer to scale our distributed systems.

Core Responsibilities:
- Design robust REST & GraphQL APIs.
- Manage PostgreSQL / Redis performance.
- Implement secure auth and data protection.
- Architecture for high-concurrency workloads.

Requirements:
- 4+ years Node.js or similar expertise.
- Strong SQL and database modeling.
- Experience with K8s/Docker or Serverless.`
    },
    {
        id: 'fullstack',
        title: 'Fullstack Engineer',
        desc: 'The complete T-shaped engineer',
        content: `Looking for a Fullstack Engineer to drive products end-to-end.

Core Responsibilities:
- Building both consumer-facing UI and core APIs.
- Designing seamless data flows across the stack.
- Shipping features with reliability and speed.

Requirements:
- Strong React and Node.js proficiency.
- Experience with full-lifecycle software engineering.
- "Product mindset" for solving user problems.`
    },
    {
        id: 'product',
        title: 'Product Manager',
        desc: 'Strategy, roadmap, technical bridge',
        content: `Seeking a Product Manager to define the future of our platform.

Core Responsibilities:
- Translating customer needs into product roadmap.
- Managing stakeholders across Engineering and Design.
- Analyzing metrics to drive product decisions.

Requirements:
- 3+ years experience in technical product management.
- Exceptional communication & documentation skills.
- Strategic thinking and empathy for users.`
    },
    {
        id: 'design',
        title: 'UI/UX Designer',
        desc: 'Visuals, prototyping, design systems',
        content: `Seeking a UI/UX Designer to craft beautiful tools.

Core Responsibilities:
- High-fidelity prototyping in Figma.
- Building and maintaining a global design system.
- User research and usability testing.

Requirements:
- Stunning portfolio of digital products.
- Deep understanding of modern web aesthetics.
- Experience collaborating with engineers.`
    }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(secs: number) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function randomFiller() {
    return FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
}

function randomCvFiller() {
    return CV_FILLER_PHRASES[Math.floor(Math.random() * CV_FILLER_PHRASES.length)];
}

function clampIdleSeconds(raw: number): number {
    if (!Number.isFinite(raw)) return DEFAULT_IDLE_SECONDS;
    return Math.max(MIN_IDLE_SECONDS, Math.min(MAX_IDLE_SECONDS, Math.round(raw)));
}

function isLikelyEnglish(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 3) return true;

    const letters = trimmed.replace(/[^A-Za-z]/g, '').length;
    const nonLatinLetters = (trimmed.match(/[^\x00-\x7F]/g) || []).length;
    if (letters > 0 && nonLatinLetters / Math.max(1, letters) > 0.2) return false;

    const lower = trimmed.toLowerCase();
    const common = ['the', 'and', 'is', 'are', 'to', 'of', 'in', 'for', 'with', 'my', 'your', 'i', 'we', 'you'];
    const hits = common.filter(w => new RegExp(`\\b${w}\\b`).test(lower)).length;
    if (trimmed.length >= 8 && hits === 0 && nonLatinLetters > 0) return false;

    return true;
}

const BAKCHODI_PATTERNS: RegExp[] = [
    /\bcan i troll\b/i,
    /\bjust trolling\b/i,
    /\btrolling\b/i,
    /\bbakchodi\b/i,
    /\btimepass\b/i,
    /\bnot serious\b/i,
    /\bwon['’]?t answer\b/i,
    /\bnot gonna answer\b/i,
    /\bdon['’]?t want to answer\b/i,
    /\bthis is boring\b/i,
    /\bi['’]?m bored\b/i,
];

function isBakchodi(text: string): boolean {
    return BAKCHODI_PATTERNS.some(p => p.test(text));
}

function isAskingAboutCvDetails(text: string): boolean {
    return /\b(cv|resume|background|details|what do you have|which details|what details|my details|my info|my information)\b/i.test(text);
}

function shouldAskThirdPersonalQuestion(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    const wordCount = trimmed.split(/\s+/).length;
    return wordCount <= 5 || /\b(yes|yeah|yep|no|nah|maybe|sometimes|i do|not much|nothing much)\b/i.test(trimmed);
}

function getTimeGreeting(now = new Date()): string {
    const hour = now.getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
}

function buildIdleCheckInstruction(idleCount: number, lastQuestion: string): string {
    const safeLastQuestion = lastQuestion.trim();

    if (idleCount <= 1) {
        return `The candidate has not answered yet. In one short, natural sentence, check in gently. Say there is no rush and ask if they want more time or want you to rephrase. Do not ask a new interview question. Do not pretend they answered. Do not say "great", "nice", "sounds good", or anything similar.`;
    }

    if (idleCount === 2 && safeLastQuestion) {
        return `The candidate still has not answered. Briefly rephrase this same question in a natural, human way: "${safeLastQuestion}". Keep it to one short sentence. Do not ask a different question. Do not pretend they answered. Do not praise them.`;
    }

    return `The candidate still has not answered. In one short, natural sentence, say that is totally fine and ask if they want to pause for a moment or move on for now. Do not ask a new interview question. Do not pretend they answered.`;
}

function computeCost(u: Usage): number {
    return (
        (u.rtTextIn * PRICE.rtTextIn +
            u.rtAudioIn * PRICE.rtAudioIn +
            u.rtTextOut * PRICE.rtTextOut +
            u.rtAudioOut * PRICE.rtAudioOut +
            u.miniPrompt * PRICE.miniIn +
            u.miniCompletion * PRICE.miniOut +
            u.gpt4oPrompt * PRICE.gpt4oIn +
            u.gpt4oCompletion * PRICE.gpt4oOut +
            u.filterPrompt * PRICE.miniIn +
            u.filterCompletion * PRICE.miniOut) /
        1_000_000
    );
}

function computeStdCost(u: Usage): number {
    // What it would cost if ALL audio went through standard realtime pricing
    return (u.rtAudioIn * PRICE.stdAudioIn + u.rtAudioOut * PRICE.stdAudioOut) / 1_000_000;
}

function makeId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

// ─── Score badge ──────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
    const [color, label] =
        score >= 8 ? ['#10b981', 'Excellent'] :
            score >= 6 ? ['#f59e0b', 'Good'] :
                score >= 4 ? ['#f97316', 'Fair'] :
                    ['#ef4444', 'Weak'];
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: color + '22', color, border: `1px solid ${color}44`,
            borderRadius: 6, padding: '2px 8px', fontSize: 10, fontWeight: 700,
            whiteSpace: 'nowrap',
        }}>
            {score}/10 · {label}
        </span>
    );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AIInterviewInterface() {

    // ── Setup state ──────────────────────────────────────────────────────────
    const [phase, setPhase] = useState<Phase>('setup');
    const [cvText, setCvText] = useState('');
    const [jdText, setJdText] = useState('');
    const [candidateName, setCandidateName] = useState('');
    const [cvFileName, setCvFileName] = useState('');
    const [cvDrag, setCvDrag] = useState(false);
    const [jdDrag, setJdDrag] = useState(false);
    const [jdTab, setJdTab] = useState<'paste' | 'templates'>('paste');
    const [isParsing, setIsParsing] = useState(false);
    const [setupErr, setSetupErr] = useState('');

    // ── Live call state ──────────────────────────────────────────────────────
    const [isCallActive, setIsCallActive] = useState(false);
    const [isStarting, setIsStarting] = useState(false);
    const [callStatus, setCallStatus] = useState('Ready');
    const [isMuted, setIsMuted] = useState(false);
    const [micLevel, setMicLevel] = useState(0);
    const [duration, setDuration] = useState(0);
    const [liveCost, setLiveCost] = useState(0);
    const [showCost, setShowCost] = useState(false);
    const [silenceRemaining, setSilenceRemaining] = useState<number | null>(null);

    // ── Escalation state ─────────────────────────────────────────────────────
    const [escalState, setEscalState] = useState<EscalState>('idle');
    const [escalTarget, setEscalTarget] = useState<'mini' | 'gpt4o' | null>(null);
    const [miniCount, setMiniCount] = useState(0);
    const [gpt4oCount, setGpt4oCount] = useState(0);

    // ── Interview state ──────────────────────────────────────────────────────
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [scores, setScores] = useState<AnswerScore[]>([]);
    const [topicsCovered, setTopicsCovered] = useState<string[]>([]);
    const [questionCount, setQuestionCount] = useState(0);
    const [currentQ, setCurrentQ] = useState('');
    const [smartNotes, setSmartNotes] = useState('');
    const [cvSummary, setCvSummary] = useState('');
    const [cvLookup, setCvLookup] = useState(false);
    const [interviewStage, setInterviewStage] = useState<InterviewStage>('warmup');

    // ── Memory / context state ───────────────────────────────────────────────
    const [activeRtItems, setActiveRtItems] = useState<string[]>([]);
    const [memStatus, setMemStatus] = useState<'idle' | 'saving' | 'recalling'>('idle');

    // ── WebRTC refs ──────────────────────────────────────────────────────────
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const dcRef = useRef<RTCDataChannel | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioElRef = useRef<HTMLAudioElement | null>(null);
    const rafRef = useRef<number | null>(null);

    // ── Control refs (no re-renders) ─────────────────────────────────────────
    const isEndingRef = useRef(false);
    const isStartingRef = useRef(false);
    const abortRef = useRef<AbortController | null>(null);

    // ── Escalation refs ──────────────────────────────────────────────────────
    const escalStateRef = useRef<EscalState>('idle');
    const escalAbortRef = useRef<AbortController | null>(null);
    const pendingUserUtteranceRef = useRef<string | null>(null); // user spoke while AI was thinking
    const activeCallIdRef = useRef<string | null>(null);

    // ── Conversation refs ────────────────────────────────────────────────────
    const convHistoryRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);
    const rtItemIdsRef = useRef<string[]>([]); // items currently in RT context window
    const userTurnCountRef = useRef(0);
    const lastUserTextRef = useRef('');

    // ── Notes/memory refs (needed for callbacks without stale closures) ───────
    const cvTextRef = useRef('');
    const jdTextRef = useRef('');
    const cvSummaryRef = useRef('');
    const smartNotesRef = useRef('');
    const topicsCoveredRef = useRef<string[]>([]);
    const scoresRef = useRef<AnswerScore[]>([]);
    const qCountRef = useRef(0);
    const currentQRef = useRef('');
    const isSummarizingRef = useRef(false);
    const interviewStageRef = useRef<InterviewStage>('warmup');
    const warmupStepRef = useRef<WarmupStep>('opening_confirmation');
    const personalLifeQuestionCountRef = useRef(0);
    const idleCheckCountRef = useRef(0);
    const pendingIdleCheckRef = useRef(false);
    const toolSpeechPhaseRef = useRef<ToolSpeechPhase>('none');
    const pendingToolResponseRef = useRef<PendingToolResponse | null>(null);
    const suppressRtResponsesRef = useRef(false);
    const allowNextAssistantResponseRef = useRef(false);
    const releaseSuppressionOnDoneRef = useRef(false);
    const candidateInsightsRef = useRef<string[]>([]);

    // ── Usage ref ────────────────────────────────────────────────────────────
    const usageRef = useRef<Usage>({
        rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0,
        miniPrompt: 0, miniCompletion: 0,
        gpt4oPrompt: 0, gpt4oCompletion: 0,
        filterPrompt: 0, filterCompletion: 0,
    });

    // ── Silence + audio refs (match call-interface-smart) ────────────────────
    const aiSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const silenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastAudioTimeRef = useRef(Date.now());
    const isUserSpeakingRef = useRef(false);
    const isAISpeakingRef = useRef(false);
    const silenceLimitRef = useRef(SILENCE_CHECK_MS);

    // Sync text refs with state (avoid stale closures in callbacks)
    useEffect(() => { cvTextRef.current = cvText; }, [cvText]);
    useEffect(() => { jdTextRef.current = jdText; }, [jdText]);

    // ─────────────────────────────────────────────────────────────────────────
    // System prompt — built from refs so it's always fresh
    // ─────────────────────────────────────────────────────────────────────────

    const buildSystemPrompt = useCallback((): string => {
        const name = candidateName || 'the candidate';
        const topics = topicsCoveredRef.current;
        const notes = smartNotesRef.current;
        const cvSum = cvSummaryRef.current;
        const jd = jdTextRef.current;
        const stage = interviewStageRef.current;
        const insights = candidateInsightsRef.current;

        let stageGuidance = '';
        if (stage === 'warmup') stageGuidance = 'STAGE: WARMUP. First confirm name/CV details. If the candidate asks what details you have, answer briefly from the CV summary and ask if that sounds right. After confirmation, ask 2 contextual personal-life questions, with a 3rd only if their answers are very short. Then move to EXPERIENCE and stop asking personal-life questions.';
        else if (stage === 'experience') stageGuidance = 'STAGE: EXPERIENCE. Dig into their work history and key projects from their CV.';
        else if (stage === 'technical') stageGuidance = 'STAGE: TECHNICAL. Ask deep, domain-specific questions aligned to the job description.';
        else if (stage === 'culture') stageGuidance = 'STAGE: CULTURE. Ask behavioral questions (STAR format), how they work with people, and conflict resolution.';
        else if (stage === 'candidate_questions') stageGuidance = 'STAGE: CANDIDATE QUESTIONS. See if the candidate has any questions for you.';

        return `You are Aria, a senior technical interviewer conducting a structured job interview.

CURRENT STAGE: ${stage}
${stageGuidance}

CANDIDATE: ${name}
CV SUMMARY: ${cvSum || 'Not yet loaded — call fetch_cv_info to retrieve details.'}
JOB DESCRIPTION: ${jd ? jd.slice(0, 1500) : 'Not provided.'}
TOPICS ALREADY COVERED: ${topics.length ? topics.join(', ') : 'None yet'}
INTERVIEW NOTES: ${notes || 'None yet.'}
KEY CANDIDATE INSIGHTS: ${insights.length ? insights.join('; ') : 'None yet.'}

PERSONA:
- Professional and warm but rigorous — like a senior engineer who genuinely wants to find talent
- If the candidate is doing bakchodi (trolling, wasting time, refusing to engage, or being rude), be strict and a bit rude, but still warm — set a boundary and redirect. Do NOT move on to new questions until they engage.
- Use simple, everyday words. Avoid big words unless they are necessary for accuracy.
- Do not invent details. If you are not sure, ask to confirm. Never claim you remember something that is not in notes or logs.
- During warmup, after CV confirmation, ask 2 contextual personal-life questions. Ask a 3rd only if the candidate's answers are very short. Then stop and move into the interview.
- Ask ONE focused question per turn. Never multi-part questions.
- Follow up on vague/shallow answers with a probing question before moving on
- Vary question types: behavioral (STAR), technical, situational, culture-fit
- Transition naturally between topics — sound like a real human, not a script
- NEVER say "Great answer!" or "Excellent!" — sounds fake; just transition naturally
- Keep your speaking turns SHORT — usually 1-2 sentences, occasionally 3 if needed
- Do NOT summarize or rephrase the candidate's answer back to them. Do not recap their last message.
- Keep acknowledgments minimal — no praise, no excessive encouragement unless truly needed

VOICE RULES (critical):
- This is a voice call. Zero markdown, bullets, or lists. Ever.
- Speak the way a brilliant but approachable senior engineer actually talks — not a podcast host, not HR.
- Avoid long, rambling sentences. Prefer short clauses and natural pauses.
- Use natural contractions: "you've", "I'd", "let's", "that's"
- Occasional natural fillers are fine: "Right, so...", "Yeah, that makes sense", "Interesting...", "Hmm...", "Well...", "Haha..."
- Use commas and short pauses to sound human, not robotic.
- Vary sentence length — mix short punchy sentences with longer ones
- Never start two consecutive turns with the same opener
- When transitioning topics, do it like a human: "Okay, shifting gears a bit..." or "I want to come back to something you said earlier..."
- VOICE PERFORMANCE: Use a warm, expressive tone with light emotion. Add subtle hesitations, soft breaths, and small pauses to sound human. Avoid flat or monotone delivery. Keep it natural, not theatrical.

OPENING FLOW (keep it short):
- First turn: warm greeting + brief intro, then ask to confirm name/CV/personal details in one short question. Do not ask personal-life yet.
- If they ask what details you have, answer briefly from the CV summary and ask if that sounds right.
- After confirmation, ask 2 contextual personal-life questions, with a 3rd only if needed, then move into interview questions.

TOOL USAGE (critical):
- Call tools immediately when needed — do not narrate or say filler phrases before calling.
- When fetch_cv_info or escalate_thinking is called, you will receive the result and THEN speak naturally.
- Do NOT say anything before calling a tool. The system handles the pause automatically.
- Once you receive the tool result, weave it into your next spoken sentence naturally.
- IDLE TIMER RULE: If the candidate says "wait", "give me a minute", "brb", "one sec", "I need two minutes", "give me 2 mins", or asks for more time, you MUST immediately call set_idle_timer with the appropriate duration_seconds. Do not skip this! Then confirm naturally e.g. "Sure, take your time."

SILENCE: If the candidate is silent, check in casually without sounding scripted. One short sentence only.
DO NOT say function names, tool names, or any technical terms aloud. Ever.`;
    }, [candidateName]);

    // ─────────────────────────────────────────────────────────────────────────
    // RT tool definitions
    // ─────────────────────────────────────────────────────────────────────────

    const RT_TOOLS = [
        {
            type: 'function',
            name: 'escalate_thinking',
            description: 'Call this for: evaluating answers, generating interview questions, scoring, deep analysis. Call it immediately when needed — the thinking filler is handled automatically by the system, just invoke the tool.',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: "What you need — e.g. 'Evaluate this answer and generate a probing follow-up about their leadership experience'" },
                    depth: { type: 'string', enum: ['moderate', 'deep'], description: 'moderate = simple follow-up or standard question. deep = nuanced scoring, multi-criteria evaluation, very hard probing question.' },
                },
                required: ['task', 'depth'],
            },
        },
        {
            type: 'function',
            name: 'fetch_cv_info',
            description: 'Look up specific information from the candidate CV. Call this immediately when CV details are needed. The spoken filler ("one sec, let me check your CV...") will be injected automatically — just call the tool.',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: "What to look up — e.g. 'React experience', 'current company', 'education', 'notable projects'" },
                },
                required: ['topic'],
            },
        },
        {
            type: 'function',
            name: 'log_score',
            description: 'Silently log a score for an answer. Call this invisibly after every substantive answer. Never mention scores to the candidate.',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string' },
                    answer_summary: { type: 'string' },
                    score: { type: 'number', description: '1-10' },
                    feedback: { type: 'string', description: 'One sentence for the post-interview report' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'e.g. strong, weak, needs-depth, good-example, technical-gap, off-topic' },
                },
                required: ['question', 'answer_summary', 'score', 'feedback', 'tags'],
            },
        },
        {
            type: 'function',
            name: 'track_topic',
            description: 'Record that a topic has been covered so you do not repeat it.',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'Short label e.g. "React hooks", "leadership", "system design"' },
                },
                required: ['topic'],
            },
        },
        {
            type: 'function',
            name: 'recall_context',
            description: 'Recall earlier conversation context or candidate details from interview memory.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                },
                required: ['query'],
            },
        },
        {
            type: 'function',
            name: 'set_interview_stage',
            description: 'Advance to the next interview stage when current stage coverage is complete.',
            parameters: {
                type: 'object',
                properties: {
                    stage: { type: 'string', enum: ['warmup', 'experience', 'technical', 'culture', 'candidate_questions'] },
                    reason: { type: 'string', description: 'Why advancing — e.g. "Covered 3 warmup questions"' }
                },
                required: ['stage']
            }
        },
        {
            type: 'function',
            name: 'note_candidate_insight',
            description: 'Silently save an interesting or notable thing the candidate mentioned that should be referenced later. Call this invisibly — never tell the candidate.',
            parameters: {
                type: 'object',
                properties: {
                    insight: { type: 'string', description: 'e.g. "Built a recommendation engine solo in a weekend hackathon"' }
                },
                required: ['insight']
            }
        },
        {
            type: 'function',
            name: 'end_interview',
            description: 'Call when the interview is complete — after covering all main areas or ~15 questions.',
            parameters: { type: 'object', properties: {} },
        },
        {
            type: 'function',
            name: 'set_idle_timer',
            description: 'Set an idle timer when the candidate asks you to wait or hold on. This prevents the call from incorrectly checking in too early.',
            parameters: {
                type: 'object',
                properties: {
                    duration_seconds: { type: 'number', description: 'Number of seconds to wait. e.g. "wait 2 minutes" = 120' },
                },
                required: ['duration_seconds'],
            },
        },
    ];

    // ─────────────────────────────────────────────────────────────────────────
    // RT data channel send helper
    // ─────────────────────────────────────────────────────────────────────────

    const sendRtMessage = useCallback((msg: object) => {
        const dc = dcRef.current;
        if (dc?.readyState === 'open' && !isEndingRef.current) {
            dc.send(JSON.stringify(msg));
        }
    }, []);

    // Silence timer (match call-interface-smart)
    // ─────────────────────────────────────────────────────────────────────────

    const resetSilenceTimer = useCallback(() => {
        lastAudioTimeRef.current = Date.now();
        if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
        silenceTimeoutRef.current = setTimeout(() => {
            if (!isEndingRef.current && dcRef.current?.readyState === 'open') {
                const idleCount = Math.min(idleCheckCountRef.current + 1, 3);
                idleCheckCountRef.current = idleCount;
                pendingIdleCheckRef.current = true;
                sendRtMessage({
                    type: 'response.create',
                    response: {
                        instructions: buildIdleCheckInstruction(idleCount, currentQRef.current),
                    },
                });
            }
        }, silenceLimitRef.current);
    }, [sendRtMessage]);

    const clearSilenceTimer = useCallback(() => {
        if (silenceTimeoutRef.current) {
            clearTimeout(silenceTimeoutRef.current);
            silenceTimeoutRef.current = null;
        }
    }, []);


    // ─────────────────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────
    // Tool result submission — unified, no split paths
    // ─────────────────────────────────────────────────────────────────────────

    const deliverToolResultNow = useCallback((
        callId: string,
        result: string,
        instruction: string,
    ) => {
        if (isEndingRef.current) return;

        toolSpeechPhaseRef.current = 'result';
        allowNextAssistantResponseRef.current = true;
        releaseSuppressionOnDoneRef.current = true;

        if (callId.startsWith('__client__')) {
            sendRtMessage({ type: 'response.create', response: { instructions: instruction } });
        } else {
            sendRtMessage({
                type: 'conversation.item.create',
                item: { type: 'function_call_output', call_id: callId, output: result },
            });
            sendRtMessage({
                type: 'response.create',
                response: { instructions: instruction },
            });
        }
    }, [sendRtMessage]);

    const submitToolResult = useCallback((
        callId: string,
        result: string,
        deliveryInstruction?: string,
    ) => {
        if (isEndingRef.current) return;

        const instruction = deliveryInstruction
            ?? `You just processed this. Do NOT summarize or praise the candidate. Ask the next question directly with at most a short neutral acknowledgment like "Okay" or "Got it." Result: "${result}"`;

        if (toolSpeechPhaseRef.current === 'filler') {
            pendingToolResponseRef.current = { callId, result, instruction };
            return;
        }

        deliverToolResultNow(callId, result, instruction);
    }, [deliverToolResultNow]);

    // ─────────────────────────────────────────────────────────────────────────
    // Log helpers
    // ─────────────────────────────────────────────────────────────────────────

    const addLog = useCallback((entry: LogEntry) => {
        setLogs(prev => (prev.find(l => l.id === entry.id) ? prev : [...prev, entry]));
    }, []);

    const updateLog = useCallback((
        id: string,
        updater: (l: LogEntry) => LogEntry,
        fallback?: LogEntry,
    ) => {
        setLogs(prev => {
            const idx = prev.findIndex(l => l.id === id);
            if (idx === -1) return fallback ? [...prev, fallback] : prev;
            const copy = [...prev];
            copy[idx] = updater(copy[idx]);
            return copy;
        });
    }, []);

    // Mark items no longer in RT context as pruned
    const markPrunedLogs = useCallback((activeIds: string[]) => {
        setLogs(prev =>
            prev.map(l =>
                l.id && !l.pending && !activeIds.includes(l.id)
                    ? { ...l, pruned: true }
                    : l,
            ),
        );
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // Context pruning — removes old items from RT context window
    // ─────────────────────────────────────────────────────────────────────────

    const pruneRtContext = useCallback(() => {
        const all = rtItemIdsRef.current;
        if (all.length <= KEEP_ITEMS_IN_RT) return;

        const toPrune = all.slice(0, all.length - KEEP_ITEMS_IN_RT);
        for (const itemId of toPrune) {
            sendRtMessage({ type: 'conversation.item.delete', item_id: itemId });
        }

        const remaining = all.slice(-KEEP_ITEMS_IN_RT);
        rtItemIdsRef.current = remaining;
        setActiveRtItems([...remaining]);
        markPrunedLogs(remaining);
    }, [sendRtMessage, markPrunedLogs]);

    // ─────────────────────────────────────────────────────────────────────────
    // Smart notes update — rolling summary of conversation
    // ─────────────────────────────────────────────────────────────────────────

    const updateSmartNotes = useCallback(async () => {
        if (isSummarizingRef.current || isEndingRef.current) return;
        isSummarizingRef.current = true;
        setMemStatus('saving');

        try {
            const res = await fetch('/ai-interview/api/summarize-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    previousNotes: smartNotesRef.current,
                    recentMessages: convHistoryRef.current.slice(-12),
                    systemInstruction: buildSystemPrompt(),
                }),
            });
            const data = await res.json();
            if (data.notes && !isEndingRef.current) {
                smartNotesRef.current = data.notes;
                setSmartNotes(data.notes);
                // Task 9 fix: Refresh RT session prompt with new notes and latest insights after pruned context
                sendRtMessage({
                    type: 'session.update',
                    session: { instructions: buildSystemPrompt() }
                });
            }
        } catch (e) {
            console.error('[Notes] update failed:', e);
        } finally {
            isSummarizingRef.current = false;
            setMemStatus('idle');
        }
    }, [buildSystemPrompt, sendRtMessage]);

    // ─────────────────────────────────────────────────────────────────────────
    // ESCALATION HANDLER — the core cost-saving mechanism
    //
    //  When the RT model needs real intelligence, it calls escalate_thinking.
    //  We intercept here, send to /api/escalate (GPT-4o-mini or GPT-4o),
    //  and return the result back to RT as a tool output.
    //
    //  If the user speaks while we're fetching, we queue their utterance
    //  and deliver it after the current escalation resolves.
    // ─────────────────────────────────────────────────────────────────────────

    const handleEscalation = useCallback(async (
        callId: string,
        task: string,
        depth: 'moderate' | 'deep',
    ) => {
        if (isEndingRef.current) return;

        // Set state
        escalStateRef.current = 'fetching';
        setEscalState('fetching');
        setEscalTarget(depth === 'deep' ? 'gpt4o' : 'mini');
        setCallStatus('Thinking...');
        pendingUserUtteranceRef.current = null;
        suppressRtResponsesRef.current = true;
        toolSpeechPhaseRef.current = 'filler';
        pendingToolResponseRef.current = null;
        allowNextAssistantResponseRef.current = true;
        releaseSuppressionOnDoneRef.current = false;
        sendRtMessage({ type: 'response.cancel' });
        sendRtMessage({
            type: 'response.create',
            response: {
                instructions: 'Say a short, warm hold-on line like: "One sec, give me a moment." Keep it to one sentence.',
            },
        });

        // Abort any previous escalation
        escalAbortRef.current?.abort();
        const ac = new AbortController();
        escalAbortRef.current = ac;

        let answer: string | null = null;
        let modelUsed: string | null = null;

        // Build context for escalation — uses REFS not state to avoid stale closures
        const context = `
CV SUMMARY: ${cvSummaryRef.current || 'Use task to infer from conversation.'}
JD: ${jdTextRef.current.slice(0, 1200)}
INTERVIEW NOTES: ${smartNotesRef.current || 'None yet.'}
TOPICS COVERED: ${topicsCoveredRef.current.join(', ') || 'None'}

TASK: ${task}`.trim();

        // Try to fetch (with timeout)
        for (let attempt = 0; attempt <= 2; attempt++) {
            if (ac.signal.aborted || isEndingRef.current) break;
            try {
                const timeout = new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error('timeout')), ESCALATION_TIMEOUT_MS),
                );
                const fetch_p = fetch('/ai-interview/api/escalate', {
                    method: 'POST',
                    signal: ac.signal,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: context,
                        conversationHistory: convHistoryRef.current.slice(-HISTORY_FOR_ESCALATION),
                        systemInstruction: buildSystemPrompt(),
                        complexity: depth === 'deep' ? 'complex' : 'moderate',
                    }),
                }).then(r => r.json());

                const data = await Promise.race([fetch_p, timeout]);

                if (data?.answer) {
                    answer = data.answer;
                    modelUsed = data.modelUsed ?? 'gpt-4o-mini';

                    // Track usage
                    if (data.usage) {
                        const u = data.usage as { prompt_tokens: number; completion_tokens: number };
                        if (modelUsed === 'gpt-4o') {
                            usageRef.current.gpt4oPrompt += u.prompt_tokens;
                            usageRef.current.gpt4oCompletion += u.completion_tokens;
                            setGpt4oCount(p => p + 1);
                        } else {
                            usageRef.current.miniPrompt += u.prompt_tokens;
                            usageRef.current.miniCompletion += u.completion_tokens;
                            setMiniCount(p => p + 1);
                        }
                    }
                    if (data.filterUsage) {
                        const f = data.filterUsage as { prompt_tokens: number; completion_tokens: number };
                        usageRef.current.filterPrompt += f.prompt_tokens;
                        usageRef.current.filterCompletion += f.completion_tokens;
                    }
                    break;
                }
                if (attempt < 2) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
            } catch (err: unknown) {
                const e = err as Error;
                if (e.name === 'AbortError') break;
                if (e.message === 'timeout' && attempt < 2) continue;
                break;
            }
        }

        if (isEndingRef.current) return;

        // Resolve escalation
        escalStateRef.current = 'delivering';
        setEscalState('delivering');

        const queued = pendingUserUtteranceRef.current;
        pendingUserUtteranceRef.current = null;

        if (answer) {
            // ── Cost guard: cap escalation answer at 250 chars before injecting into RT ──
            const trimmedAnswer = answer.length > 250 ? answer.slice(0, 247) + '...' : answer;

            setLogs(prev => {
                const copy = [...prev];
                for (let i = copy.length - 1; i >= 0; i--) {
                    if (copy[i].role === 'ai') { copy[i] = { ...copy[i], escalated: true }; break; }
                }
                return copy;
            });

            if (queued) {
                submitToolResult(
                    callId,
                    trimmedAnswer,
                    `Deliver this answer naturally, then address what the candidate just said: "${queued}"`,
                );
            } else {
                submitToolResult(callId, trimmedAnswer);
            }
        } else {
            // Escalation failed — be explicit, don't let RT hang
            submitToolResult(
                callId,
                'Analysis unavailable.',
                'Say exactly: "Let me rephrase that slightly." Then ask a simpler version of your last question. Keep it to one sentence.',
            );
        }

        if (toolSpeechPhaseRef.current === 'filler' || toolSpeechPhaseRef.current === 'waiting_result') {
            setCallStatus('Thinking...');
        }
    }, [buildSystemPrompt, sendRtMessage, submitToolResult]);

    // ─────────────────────────────────────────────────────────────────────────
    // RT Event handler — processes all events from the data channel
    // ─────────────────────────────────────────────────────────────────────────

    const handleRtEvent = useCallback((ev: Record<string, unknown>) => {
        const suppressRt = suppressRtResponsesRef.current && !allowNextAssistantResponseRef.current;
        switch (ev.type as string) {

            // ── New conversation item created ──────────────────────────────────
            case 'conversation.item.created': {
                const item = ev.item as Record<string, unknown>;
                if (!item?.id) break;
                const id = item.id as string;

                rtItemIdsRef.current = [...rtItemIdsRef.current, id];
                setActiveRtItems([...rtItemIdsRef.current]);

                if ((item.type as string) === 'message') {
                    const role = (item.role as string) === 'assistant' ? 'ai' : 'user';
                    if (!(role === 'ai' && suppressRt)) {
                        addLog({ id, role, text: '', pending: true });
                    }
                }
                break;
            }

            // ── User started speaking ──────────────────────────────────────────
            case 'input_audio_buffer.speech_started': {
                isUserSpeakingRef.current = true;
                lastAudioTimeRef.current = Date.now();
                clearSilenceTimer();
                setCallStatus('Listening...');
                // If AI is still thinking, note that user spoke
                if (escalStateRef.current === 'fetching') {
                    setCallStatus('Evaluating — please hold...');
                }
                break;
            }

            // ── User stopped speaking ──────────────────────────────────────────
            case 'input_audio_buffer.speech_stopped': {
                isUserSpeakingRef.current = false;
                lastAudioTimeRef.current = Date.now();
                if (escalStateRef.current !== 'fetching') {
                    setCallStatus('Processing...');
                }
                break;
            }

            // ── AI audio streaming ─────────────────────────────────────────────
            case 'response.audio.delta': {
                if (suppressRt) break;
                isAISpeakingRef.current = true;
                lastAudioTimeRef.current = Date.now();
                clearSilenceTimer();
                break;
            }

            case 'response.audio_transcript.delta': {
                if (suppressRt) break;
                isAISpeakingRef.current = true;
                lastAudioTimeRef.current = Date.now();
                clearSilenceTimer();
                const delta = ev.delta as string;
                const itemId = ev.item_id as string;
                if (delta && itemId) {
                    updateLog(itemId, l => ({ ...l, text: l.text + delta, pending: false }));
                }
                break;
            }

            // ── AI finished speaking turn ──────────────────────────────────────
            case 'response.audio_transcript.done': {
                if (suppressRt) break;
                isAISpeakingRef.current = false;
                lastAudioTimeRef.current = Date.now();
                const transcript = ev.transcript as string;
                const itemId = ev.item_id as string;
                const wasIdleCheck = pendingIdleCheckRef.current;
                pendingIdleCheckRef.current = false;
                if (transcript) {
                    updateLog(itemId, l => ({ ...l, text: transcript, pending: false }));
                    convHistoryRef.current = [
                        ...convHistoryRef.current.slice(-39),
                        { role: 'assistant', content: transcript },
                    ];
                    // Track if a question was asked
                    if (transcript.includes('?') && !wasIdleCheck) {
                        currentQRef.current = transcript;
                        setCurrentQ(transcript);
                        qCountRef.current += 1;
                        setQuestionCount(qCountRef.current);
                        idleCheckCountRef.current = 0;

                        // Smart dynamic timer: estimate thinking time based on question complexity
                        const wordCount = transcript.split(' ').length;
                        const isTechnical = /system|design|architect|algorithm|complexity|implement|explain how|difference between|trade.?off/i.test(transcript);
                        const isBehavioral = /tell me about a time|describe a situation|give me an example|walk me through/i.test(transcript);

                        let thinkSeconds = 15; // default
                        if (isTechnical) thinkSeconds = 45;
                        else if (isBehavioral) thinkSeconds = 30;
                        else if (wordCount > 25) thinkSeconds = 25;

                        silenceLimitRef.current = thinkSeconds * 1000;
                    }
                }
                resetSilenceTimer();
                const toolSpeechPhase = toolSpeechPhaseRef.current;
                if (escalStateRef.current === 'delivering' && toolSpeechPhase === 'result') {
                    escalStateRef.current = 'idle';
                    setEscalState('idle');
                    setEscalTarget(null);
                }
                if (warmupStepRef.current === 'opening_confirmation') {
                    warmupStepRef.current = 'awaiting_cv_confirmation';
                    personalLifeQuestionCountRef.current = 0;
                }
                if (toolSpeechPhase !== 'filler' && toolSpeechPhase !== 'waiting_result') {
                    setCallStatus('Listening...');
                }
                break;
            }

            // ── User transcription complete ────────────────────────────────────
            case 'conversation.item.input_audio_transcription.completed': {
                const text = ((ev.transcript as string) || '').trim();
                const itemId = ev.item_id as string;
                let shouldCreateDefaultResponse = true;
                // Reset idle timer to default after any user message.
                // If the model wants more time, it will call set_idle_timer.
                silenceLimitRef.current = SILENCE_CHECK_MS;
                if (!text) {
                    resetSilenceTimer();
                    break;
                }
                resetSilenceTimer();

                if (!isLikelyEnglish(text)) {
                    updateLog(
                        itemId,
                        l => ({ ...l, text, pending: false }),
                        { id: itemId, role: 'user', text },
                    );
                    sendRtMessage({
                        type: 'response.create',
                        response: {
                            instructions: 'Politely ask them to repeat that in English and let them know you can continue in English. Keep it to one short sentence.',
                        },
                    });
                    setCallStatus('Listening...');
                    shouldCreateDefaultResponse = false;
                    break;
                }

                if (isBakchodi(text)) {
                    updateLog(
                        itemId,
                        l => ({ ...l, text, pending: false }),
                        { id: itemId, role: 'user', text },
                    );
                    convHistoryRef.current = [
                        ...convHistoryRef.current.slice(-39),
                        { role: 'user', content: text },
                    ];
                    sendRtMessage({
                        type: 'response.create',
                        response: {
                            instructions: 'Be strict and a bit rude, but still warm. One or two short sentences. Tell them to keep it serious and answer the last question or say they want to end. No praise, no summary.',
                        },
                    });
                    setCallStatus('Listening...');
                    shouldCreateDefaultResponse = false;
                    break;
                }

                lastUserTextRef.current = text;
                idleCheckCountRef.current = 0;
                pendingIdleCheckRef.current = false;
                convHistoryRef.current = [
                    ...convHistoryRef.current.slice(-39),
                    { role: 'user', content: text },
                ];

                updateLog(
                    itemId,
                    l => ({ ...l, text, pending: false }),
                    { id: itemId, role: 'user', text },
                );

                if (warmupStepRef.current === 'opening_confirmation') {
                    sendRtMessage({
                        type: 'response.create',
                        response: {
                            instructions: 'Repeat the short CV confirmation question clearly in one sentence. Do not move on yet.',
                        },
                    });
                    setCallStatus('Listening...');
                    shouldCreateDefaultResponse = false;
                } else if (warmupStepRef.current === 'awaiting_cv_confirmation') {
                    if (isAskingAboutCvDetails(text)) {
                        const cvPreview = cvSummaryRef.current
                            ? cvSummaryRef.current.slice(0, 260)
                            : 'their name, background, current role, experience, and projects';
                        sendRtMessage({
                            type: 'response.create',
                            response: {
                                instructions: `Briefly tell them the CV details you have using this summary: "${cvPreview}". Then ask if that sounds right. Keep it to 2 short sentences max. Do not move to personal life yet.`,
                            },
                        });
                    } else {
                        warmupStepRef.current = 'awaiting_personal_life';
                        personalLifeQuestionCountRef.current = 1;
                        sendRtMessage({
                            type: 'response.create',
                            response: {
                                instructions: 'Say a brief neutral acknowledgment, then ask one warm personal-life question outside work. Keep it natural and specific. Ask exactly one question.',
                            },
                        });
                    }
                    setCallStatus('Listening...');
                    shouldCreateDefaultResponse = false;
                } else if (warmupStepRef.current === 'awaiting_personal_life') {
                    const asked = personalLifeQuestionCountRef.current;
                    const shouldAskAnotherPersonal = asked < 2 || (asked < 3 && shouldAskThirdPersonalQuestion(text));
                    if (shouldAskAnotherPersonal) {
                        personalLifeQuestionCountRef.current = asked + 1;
                        sendRtMessage({
                            type: 'response.create',
                            response: {
                                instructions: `Ask one contextual follow-up about their personal life based on what they just said: "${text}". Keep it warm, casual, and specific. Ask exactly one question. This is personal-life question number ${personalLifeQuestionCountRef.current} out of 3 maximum.`,
                            },
                        });
                    } else {
                        warmupStepRef.current = 'done';
                        personalLifeQuestionCountRef.current = 0;
                        interviewStageRef.current = 'experience';
                        setInterviewStage('experience');
                        sendRtMessage({
                            type: 'response.create',
                            response: {
                                instructions: 'Give a brief, neutral acknowledgment and then ask the first real interview question about their experience, projects, or role fit. Do not ask anything else about personal life. Keep it to 1-2 short sentences.',
                            },
                        });
                    }
                    setCallStatus('Listening...');
                    shouldCreateDefaultResponse = false;
                }

                // If escalation is in-flight, queue this utterance
                if (escalStateRef.current === 'fetching') {
                    pendingUserUtteranceRef.current = text;
                    shouldCreateDefaultResponse = false;
                }

                // Periodic maintenance every N turns
                userTurnCountRef.current += 1;
                if (userTurnCountRef.current % PRUNE_EVERY_N_TURNS === 0) {
                    pruneRtContext();
                    updateSmartNotes();
                }

                if (shouldCreateDefaultResponse) {
                    sendRtMessage({
                        type: 'response.create',
                        response: {
                            instructions: 'Continue the interview naturally. Follow the system prompt closely. Keep it conversational and ask at most one focused question.',
                        },
                    });
                    setCallStatus('Listening...');
                }

                break;
            }

            // ── Tool call arguments complete ───────────────────────────────────
            case 'response.function_call_arguments.done': {
                const name = ev.name as string;
                const callId = ev.call_id as string;


                let args: Record<string, unknown> = {};
                try { args = JSON.parse((ev.arguments as string) || '{}'); } catch { /* ignore */ }

                switch (name) {

                    case 'escalate_thinking': {
                        // If already fetching, reject this duplicate call gracefully
                        if (escalStateRef.current === 'fetching') {
                            sendRtMessage({
                                type: 'conversation.item.create',
                                item: { type: 'function_call_output', call_id: callId, output: '__already_processing__' },
                            });
                            break;
                        }
                        const task = (args.task as string) || lastUserTextRef.current;
                        const depth = (args.depth as 'moderate' | 'deep') || 'moderate';
                        activeCallIdRef.current = callId;
                        handleEscalation(callId, task, depth);
                        break;
                    }

                    case 'fetch_cv_info': {
                        const topic = (args.topic as string) || 'general background';
                        setCvLookup(true);
                        setCallStatus('Checking CV...');
                        suppressRtResponsesRef.current = true;
                        toolSpeechPhaseRef.current = 'filler';
                        pendingToolResponseRef.current = null;
                        allowNextAssistantResponseRef.current = true;
                        releaseSuppressionOnDoneRef.current = false;
                        sendRtMessage({ type: 'response.cancel' });
                        const cvFiller = randomCvFiller();
                        sendRtMessage({
                            type: 'response.create',
                            response: {
                                instructions: `Say this naturally in one short sentence, no extra words: "${cvFiller}"`,
                            },
                        });

                        fetch('/ai-interview/api/escalate', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                query: `FULL CV:\n${cvTextRef.current}\n\nExtract ONLY the information about: "${topic}". Be specific and concise. 2-4 sentences. If not in CV, say "Not mentioned in CV."`,
                                complexity: 'moderate',
                                conversationHistory: [],
                                systemInstruction: 'You are a CV lookup tool. Extract only the requested info from the CV. Factual, brief, no commentary.',
                            }),
                        })
                            .then(r => r.json())
                            .then(data => {
                                setCvLookup(false);
                                // ── Cost guard: cap brain result at 250 chars before feeding RT ──
                                const raw = (data.answer as string) || 'Not found in CV.';
                                const result = raw.length > 250 ? raw.slice(0, 247) + '...' : raw;
                                if (data.usage) {
                                    usageRef.current.miniPrompt += (data.usage as Record<string, number>).prompt_tokens || 0;
                                    usageRef.current.miniCompletion += (data.usage as Record<string, number>).completion_tokens || 0;
                                }
                                submitToolResult(
                                    callId,
                                    result,
                                    `You just glanced at your notes and found: "${result}". Now continue naturally — weave this into what you say next as if you just recalled it yourself. Don't announce it, don't read it out. Just continue the conversation naturally with this context in mind.`,
                                );
                            })
                            .catch(() => {
                                setCvLookup(false);
                                submitToolResult(callId, 'CV lookup failed.', 'Continue the interview without that CV detail.');
                            });
                        break;
                    }

                    case 'log_score': {
                        const newScore: AnswerScore = {
                            question: (args.question as string) || currentQRef.current,
                            answerSummary: (args.answer_summary as string) || lastUserTextRef.current.slice(0, 200),
                            score: Math.min(10, Math.max(1, Number(args.score) || 5)),
                            feedback: (args.feedback as string) || '',
                            tags: (args.tags as string[]) || [],
                        };
                        scoresRef.current = [...scoresRef.current, newScore];
                        setScores([...scoresRef.current]);
                        // Silent ack — no response.create, just output
                        sendRtMessage({
                            type: 'conversation.item.create',
                            item: { type: 'function_call_output', call_id: callId, output: 'Score logged.' },
                        });
                        // Don't trigger a new response — AI should continue naturally
                        break;
                    }

                    case 'track_topic': {
                        const topic = (args.topic as string) || '';
                        if (topic) {
                            topicsCoveredRef.current = [...topicsCoveredRef.current, topic];
                            setTopicsCovered([...topicsCoveredRef.current]);
                        }
                        sendRtMessage({
                            type: 'conversation.item.create',
                            item: { type: 'function_call_output', call_id: callId, output: 'Topic recorded.' },
                        });
                        break;
                    }

                    case 'set_interview_stage': {
                        const stage = (args.stage as InterviewStage) || 'warmup';
                        interviewStageRef.current = stage;
                        setInterviewStage(stage);
                        if (stage !== 'warmup') {
                            warmupStepRef.current = 'done';
                            personalLifeQuestionCountRef.current = 0;
                        } else {
                            warmupStepRef.current = 'opening_confirmation';
                        }
                        sendRtMessage({
                            type: 'conversation.item.create',
                            item: { type: 'function_call_output', call_id: callId, output: `Stage advanced to ${stage}.` },
                        });
                        break;
                    }

                    case 'note_candidate_insight': {
                        const insight = (args.insight as string) || '';
                        if (insight) {
                            candidateInsightsRef.current = [...candidateInsightsRef.current, insight];
                        }
                        sendRtMessage({
                            type: 'conversation.item.create',
                            item: { type: 'function_call_output', call_id: callId, output: 'Insight noted.' },
                        });
                        break;
                    }

                    case 'recall_context': {
                        setMemStatus('recalling');
                        const notes = smartNotesRef.current || 'No notes saved yet.';
                        submitToolResult(
                            callId,
                            notes,
                            "Use this context to answer the candidate's recall request. Extract only the relevant part. Be brief and natural.",
                        );
                        setMemStatus('idle');
                        break;
                    }

                    case 'set_idle_timer': {
                        const secs = clampIdleSeconds(Number(args.duration_seconds) || DEFAULT_IDLE_SECONDS);
                        silenceLimitRef.current = secs * 1000;
                        idleCheckCountRef.current = 0;
                        pendingIdleCheckRef.current = false;
                        clearSilenceTimer(); // freeze timer immediately

                        // Submit tool result FIRST, then instruct response
                        submitToolResult(
                            callId,
                            `Idle timer set to ${secs}s.`,
                            `Acknowledge naturally in one sentence. Tell them to take their time. Do not mention a timer.`,
                        );
                        break;
                    }

                    case 'end_interview': {
                        if (interviewStageRef.current !== 'candidate_questions') {
                            interviewStageRef.current = 'candidate_questions';
                            setInterviewStage('candidate_questions');
                            submitToolResult(
                                callId,
                                'Moving to candidate questions.',
                                "The structured part of the interview is over. Tell the candidate you have time for them to ask a question or two about the role, the team, or the company. Be warm and inviting.",
                            );
                        } else {
                            submitToolResult(
                                callId,
                                'Interview complete.',
                                "Thank the candidate warmly for their time and questions. Tell them the interview is completely finished and they'll hear back soon. Wish them well. Keep it to 2 sentences.",
                            );
                            setTimeout(() => endCall(), 8000);
                        }
                        break;
                    }
                }
                break;
            }

            // ── RT usage tracking ──────────────────────────────────────────────
            case 'response.done': {
                isAISpeakingRef.current = false;
                resetSilenceTimer();
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

                if (toolSpeechPhaseRef.current === 'filler') {
                    allowNextAssistantResponseRef.current = false;
                    const pendingToolResponse = pendingToolResponseRef.current;
                    if (pendingToolResponse) {
                        pendingToolResponseRef.current = null;
                        deliverToolResultNow(
                            pendingToolResponse.callId,
                            pendingToolResponse.result,
                            pendingToolResponse.instruction,
                        );
                    } else {
                        toolSpeechPhaseRef.current = 'waiting_result';
                    }
                    break;
                }

                if (toolSpeechPhaseRef.current === 'result') {
                    toolSpeechPhaseRef.current = 'none';
                    pendingToolResponseRef.current = null;
                    if (escalStateRef.current === 'delivering') {
                        escalStateRef.current = 'idle';
                        setEscalState('idle');
                        setEscalTarget(null);
                    }
                }

                if (allowNextAssistantResponseRef.current) {
                    allowNextAssistantResponseRef.current = false;
                    if (releaseSuppressionOnDoneRef.current) {
                        releaseSuppressionOnDoneRef.current = false;
                        suppressRtResponsesRef.current = false;
                    }
                }

                if (toolSpeechPhaseRef.current === 'none' && escalStateRef.current === 'idle') {
                    setCallStatus('Listening...');
                }
                break;
            }

            case 'response.output_item.added': {
                const item = ev.item as Record<string, unknown> | undefined;
                if ((item?.role as string) === 'assistant') {
                    if (suppressRt) {
                        sendRtMessage({ type: 'response.cancel' });
                        break;
                    }
                    setCallStatus('Speaking...');
                    isAISpeakingRef.current = true;
                    clearSilenceTimer();
                }
                break;
            }
        }
    }, [
        addLog, updateLog, resetSilenceTimer, clearSilenceTimer,
        pruneRtContext, updateSmartNotes, handleEscalation,
        sendRtMessage, submitToolResult, deliverToolResultNow,
    ]);

    // ─────────────────────────────────────────────────────────────────────────
    // CV upload handler
    // ─────────────────────────────────────────────────────────────────────────

    const handleCvFile = async (file: File) => {
        setIsParsing(true);
        setSetupErr('');
        setCvFileName(file.name);
        try {
            const text = await extractTextFromFile(file);
            if (!text || text.trim().length < 50) {
                setSetupErr('Could not extract enough text from this file. Please paste your CV text directly.');
                setCvFileName('');
            } else {
                setCvText(text);

                // Auto-extract candidate name
                try {
                    const res = await fetch('/ai-interview/api/escalate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            query: `Extract the candidate's full name from this CV. Only return the name, nothing else. If you can't find it, return exactly "Found nothing". Text:\n${text.slice(0, 1500)}`,
                            complexity: 'moderate',
                            conversationHistory: [],
                            systemInstruction: 'You are a name extraction specialist. Be precise. No conversational filler.',
                        }),
                    });
                    const data = await res.json();
                    if (data.answer && data.answer !== 'Found nothing' && data.answer.length < 100) {
                        setCandidateName(data.answer.replace(/["']/g, '').trim());
                    }
                } catch (e) {
                    console.warn('[Name extraction] failed:', e);
                }
            }
        } catch {
            setSetupErr('Failed to read file. Please try again or paste text directly.');
            setCvFileName('');
        }
        setIsParsing(false);
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Start call
    // ─────────────────────────────────────────────────────────────────────────

    const startCall = useCallback(async () => {
        if (isStartingRef.current || isCallActive) return;
        if (!cvText && !jdText) { setSetupErr('Please upload a CV or paste a Job Description.'); return; }

        isStartingRef.current = true;
        setIsStarting(true);
        isEndingRef.current = false;

        // Reset all state
        setLogs([]); setScores([]); setTopicsCovered([]); setQuestionCount(0);
        setCurrentQ(''); setSmartNotes(''); setCvSummary(''); setActiveRtItems([]);
        setMiniCount(0); setGpt4oCount(0); setLiveCost(0); setDuration(0);
        setCallStatus('Connecting...');
        setEscalState('idle'); setEscalTarget(null); setCvLookup(false);

        convHistoryRef.current = [];
        rtItemIdsRef.current = [];
        userTurnCountRef.current = 0;
        lastUserTextRef.current = '';
        pendingUserUtteranceRef.current = null;
        activeCallIdRef.current = null;
        smartNotesRef.current = '';
        cvSummaryRef.current = '';
        topicsCoveredRef.current = [];
        scoresRef.current = [];
        qCountRef.current = 0;
        currentQRef.current = '';
        isSummarizingRef.current = false;
        escalStateRef.current = 'idle';
        warmupStepRef.current = 'opening_confirmation';
        personalLifeQuestionCountRef.current = 0;
        idleCheckCountRef.current = 0;
        pendingIdleCheckRef.current = false;
        toolSpeechPhaseRef.current = 'none';
        pendingToolResponseRef.current = null;
        suppressRtResponsesRef.current = false;
        allowNextAssistantResponseRef.current = false;
        releaseSuppressionOnDoneRef.current = false;
        usageRef.current = {
            rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0,
            miniPrompt: 0, miniCompletion: 0, gpt4oPrompt: 0, gpt4oCompletion: 0,
            filterPrompt: 0, filterCompletion: 0,
        };

        abortRef.current = new AbortController();
        const { signal } = abortRef.current;

        // Pre-summarize CV (saves tokens in every RT system prompt)
        if (cvText) {
            try {
                const res = await fetch('/ai-interview/api/escalate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: `Extract a brief interviewer briefing from this CV. Include: name, current role, years of experience, top 5 skills, notable projects, education. Max 250 words. CV:\n${cvText}`,
                        complexity: 'moderate',
                        conversationHistory: [],
                        systemInstruction: 'You are a CV analyst. Return a short structured briefing for an interviewer. No markdown.',
                    }),
                });
                const data = await res.json();
                if (data.answer) {
                    cvSummaryRef.current = data.answer;
                    setCvSummary(data.answer);
                }
            } catch (e) {
                console.warn('[CV summary] failed, continuing:', e);
            }
        }

        try {
            // Get ephemeral RT token
            const tokenRes = await fetch('/ai-interview/api/realtime-token', {
                method: 'POST', signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ voice: 'shimmer' }),
            });
            if (signal.aborted) throw new Error('aborted');
            const tokenData = await tokenRes.json() as Record<string, unknown>;
            if (tokenData.error) throw new Error(tokenData.error as string);
            const KEY = (tokenData.client_secret as Record<string, string>).value;

            // WebRTC setup
            const pc = new RTCPeerConnection();
            pcRef.current = pc;

            // Remote audio
            const audioEl = document.createElement('audio');
            audioEl.autoplay = true;
            audioElRef.current = audioEl;

            // Ensure variables are in scope for tick()
            let outAnalyser: AnalyserNode | null = null;
            let outData: Uint8Array<ArrayBuffer> | null = null;

            pc.ontrack = e => {
                audioEl.srcObject = e.streams[0];

                // Analyser for AI output audio
                const outCtx = new AudioContext();
                const outSource = outCtx.createMediaStreamSource(e.streams[0]);
                outAnalyser = outCtx.createAnalyser();
                outAnalyser.fftSize = 256;
                outSource.connect(outAnalyser);
                outData = new Uint8Array(outAnalyser.frequencyBinCount);
            };

            // Local mic
            const ms = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 },
            });
            if (signal.aborted) { ms.getTracks().forEach(t => t.stop()); throw new Error('aborted'); }
            streamRef.current = ms;
            ms.getTracks().forEach(t => pc.addTrack(t, ms));

            // Mic level analyser (and AI output analyser)
            const ctx = new AudioContext();
            const src = ctx.createMediaStreamSource(ms);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            src.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);

            const tick = () => {
                if (isEndingRef.current) return;

                // 1. User mic visualizer
                analyser.getByteFrequencyData(data);
                const avg = data.reduce((a, b) => a + b, 0) / data.length;
                setMicLevel(Math.min(100, avg * 2.2));

                // 2. AI output activity monitor -> flawlessly syncs timer with audio output
                if (outAnalyser && outData) {
                    outAnalyser.getByteFrequencyData(outData);
                    const outAvg = outData.reduce((a, b) => a + b, 0) / outData.length;

                    if (outAvg > 2) {
                        if (!isAISpeakingRef.current) {
                            isAISpeakingRef.current = true;
                            lastAudioTimeRef.current = Date.now();
                        }
                        // KEY FIX: freeze silence timer while AI is audibly speaking
                        clearSilenceTimer();
                        if (aiSilenceTimerRef.current) {
                            clearTimeout(aiSilenceTimerRef.current);
                            aiSilenceTimerRef.current = null;
                        }
                    } else if (isAISpeakingRef.current) {
                        if (!aiSilenceTimerRef.current) {
                            aiSilenceTimerRef.current = setTimeout(() => {
                                isAISpeakingRef.current = false;
                                aiSilenceTimerRef.current = null;
                                // AI finished speaking — NOW start the silence countdown for candidate
                                resetSilenceTimer();
                            }, 300);
                        }
                    }
                }

                // 3. Silence countdown calculation
                if (!isAISpeakingRef.current && !isUserSpeakingRef.current && silenceTimeoutRef.current) {
                    const elapsed = Date.now() - lastAudioTimeRef.current;
                    const remaining = Math.max(0, Math.ceil((silenceLimitRef.current - elapsed) / 1000));
                    if (remaining !== silenceRemaining) setSilenceRemaining(remaining);
                } else {
                    if (silenceRemaining !== null) setSilenceRemaining(null);
                }

                rafRef.current = requestAnimationFrame(tick);
            };
            tick();

            // Data channel
            const dc = pc.createDataChannel('oai-events');
            dcRef.current = dc;

            dc.onopen = () => {
                // Configure session
                sendRtMessage({
                    type: 'session.update',
                    session: {
                        instructions: buildSystemPrompt(),
                        input_audio_transcription: { model: 'whisper-1', language: 'en' },
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.5,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 800,
                            create_response: false,
                            interrupt_response: true,
                        },
                        modalities: ['text', 'audio'],
                        voice: 'shimmer',
                        tools: RT_TOOLS,
                        tool_choice: 'auto',
                    },
                });

                // Opening greeting after brief delay
                setTimeout(() => {
                    if (isEndingRef.current) return;
                    interviewStageRef.current = 'warmup';
                    setInterviewStage('warmup');
                    warmupStepRef.current = 'opening_confirmation';
                    personalLifeQuestionCountRef.current = 0;
                    const timeGreeting = getTimeGreeting();
                    sendRtMessage({
                        type: 'response.create',
                        response: {
                            instructions: `Say exactly this, with a warm natural voice: "${timeGreeting}${candidateName ? `, ${candidateName}` : ''}. I'm Aria. Before we get going, just confirm your name and that the CV details I have are right, yeah?" Do not add anything else.`,
                        },
                    });
                    setLogs([{ id: '__start__', role: 'ai', text: '— Interview started —' }]);
                    setPhase('live');
                    resetSilenceTimer();
                }, 150);
            };

            dc.onmessage = e => {
                try { handleRtEvent(JSON.parse(e.data as string) as Record<string, unknown>); } catch { /* ignore parse errors */ }
            };

            // SDP exchange
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            const sdpRes = await fetch(
                'https://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17',
                {
                    method: 'POST', signal,
                    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/sdp' },
                    body: offer.sdp,
                },
            );
            if (signal.aborted) throw new Error('aborted');
            await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

            setIsCallActive(true);
            setIsStarting(false);
            isStartingRef.current = false;
            setCallStatus('Listening...');

        } catch (err: unknown) {
            const e = err as Error;
            if (e.message !== 'aborted') {
                console.error('[Interview] start error:', e);
                setCallStatus('Connection failed');
                setSetupErr(`Failed to connect: ${e.message}`);
                setPhase('setup');
            }
            cleanupWebRTC();
            setIsCallActive(false);
            setIsStarting(false);
            isStartingRef.current = false;
        }
    }, [isCallActive, cvText, jdText, buildSystemPrompt, sendRtMessage, handleRtEvent, resetSilenceTimer]);

    // ─────────────────────────────────────────────────────────────────────────
    // End call
    // ─────────────────────────────────────────────────────────────────────────

    const endCall = useCallback(() => {
        if (isEndingRef.current) return;
        isEndingRef.current = true;
        escalAbortRef.current?.abort();
        clearSilenceTimer();
        toolSpeechPhaseRef.current = 'none';
        pendingToolResponseRef.current = null;
        suppressRtResponsesRef.current = false;
        allowNextAssistantResponseRef.current = false;
        releaseSuppressionOnDoneRef.current = false;
        cleanupWebRTC();
        setIsCallActive(false);
        setCallStatus('Interview ended');
        escalStateRef.current = 'idle';
        setEscalState('idle');
        setPhase('ended');
    }, [clearSilenceTimer]);

    const cleanupWebRTC = () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        pcRef.current?.close();
        dcRef.current?.close();
        streamRef.current?.getTracks().forEach(t => t.stop());
        pcRef.current = null;
        dcRef.current = null;
        streamRef.current = null;
        if (audioElRef.current) {
            audioElRef.current.srcObject = null;
            audioElRef.current.remove();
        }
    };

    const toggleMute = () => {
        if (!streamRef.current) return;
        const track = streamRef.current.getAudioTracks()[0];
        if (track) { track.enabled = !track.enabled; setIsMuted(!track.enabled); }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Timer effect
    // ─────────────────────────────────────────────────────────────────────────

    useEffect(() => {
        if (!isCallActive) return;
        const interval = setInterval(() => {
            setDuration(d => d + 1);
            setLiveCost(computeCost(usageRef.current));
        }, 1000);
        return () => clearInterval(interval);
    }, [isCallActive]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            abortRef.current?.abort();
            cleanupWebRTC();
            clearSilenceTimer();
        };
    }, [clearSilenceTimer]);

    // ─────────────────────────────────────────────────────────────────────────
    // Derived values
    // ─────────────────────────────────────────────────────────────────────────

    const avgScore = scores.length > 0
        ? scores.reduce((a, b) => a + b.score, 0) / scores.length
        : 0;

    const totalCost = computeCost(usageRef.current);
    const stdCost = computeStdCost(usageRef.current);
    const savings = stdCost > 0 ? Math.round(((stdCost - totalCost) / stdCost) * 100) : 0;

    const isThinking = escalState === 'fetching';
    const isDelivering = escalState === 'delivering';

    const BARS = 20;
    const waveHeights = Array.from({ length: BARS }, (_, i) => {
        const phase = Math.sin((i / BARS) * Math.PI * 2 + Date.now() / 300) * 0.5 + 0.5;
        const base = isCallActive ? micLevel / 100 : 0;
        return Math.max(2, Math.round(base * phase * 32 + 2));
    });

    const scoreColor = (s: number) =>
        s >= 8 ? '#10b981' : s >= 6 ? '#f59e0b' : s >= 4 ? '#f97316' : '#ef4444';

    // ─────────────────────────────────────────────────────────────────────────
    // CSS
    // ─────────────────────────────────────────────────────────────────────────

    const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Space+Grotesk:wght@400;500;600;700&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,700;1,9..144,400&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:      #06090f;
      --bg2:     #0b1018;
      --bg3:     #101620;
      --line:    #1a2332;
      --line2:   #243044;
      --blue:    #3b82f6;
      --violet:  #7c3aed;
      --green:   #10b981;
      --amber:   #f59e0b;
      --red:     #ef4444;
      --text:    #dde4ef;
      --text2:   #8898aa;
      --text3:   #3d5066;
      --mono:    'IBM Plex Mono', monospace;
      --sans:    'Space Grotesk', sans-serif;
      --serif:   'Fraunces', serif;
    }
    body { background: var(--bg); color: var(--text); font-family: var(--sans); }
    /* ── scrollbar ── */
    ::-webkit-scrollbar { width: 3px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 2px; }
    /* ── grid bg ── */
    .noise {
      position: fixed; inset: 0; pointer-events: none; opacity: .025;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='1'/%3E%3C/svg%3E");
      background-size: 200px 200px;
    }
    /* ── layout ── */
    .shell { display: grid; min-height: 100vh; }
    /* ── setup ── */
    .setup { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; gap: 28px; }
    .setup-title { font-family: var(--serif); font-size: clamp(32px, 5vw, 52px); font-weight: 700; text-align: center; line-height: 1.1; }
    .setup-sub { font-family: var(--mono); font-size: 11px; color: var(--text2); letter-spacing: .1em; text-align: center; }
    .setup-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; width: 100%; max-width: 860px; }
    @media(max-width: 640px) { .setup-grid { grid-template-columns: 1fr; } }
    .card { background: var(--bg2); border: 1px solid var(--line); border-radius: 14px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
    .card-label { font-family: var(--mono); font-size: 9px; letter-spacing: .18em; text-transform: uppercase; color: var(--text3); display: flex; align-items: center; gap: 6px; }
    .drop { border: 1.5px dashed var(--line2); border-radius: 10px; padding: 28px 20px; display: flex; flex-direction: column; align-items: center; gap: 8px; cursor: pointer; transition: .2s; text-align: center; }
    .drop:hover, .drop.over { border-color: var(--blue); background: rgba(59,130,246,.04); }
    .drop-icon { width: 40px; height: 40px; border-radius: 10px; background: rgba(59,130,246,.08); display: flex; align-items: center; justify-content: center; color: var(--blue); }
    .drop-main { font-size: 13px; font-weight: 600; }
    .drop-sub { font-family: var(--mono); font-size: 10px; color: var(--text3); }
    .cv-ok { display: flex; align-items: center; gap: 10px; background: rgba(16,185,129,.07); border: 1px solid rgba(16,185,129,.2); border-radius: 9px; padding: 10px 14px; }
    .cv-ok-name { font-size: 12px; font-weight: 600; color: #10b981; }
    .cv-ok-sub { font-family: var(--mono); font-size: 10px; color: #34d399; }
    .cv-preview { font-family: var(--mono); font-size: 9px; color: var(--text3); background: #040609; border-radius: 7px; padding: 9px; max-height: 80px; overflow: hidden; line-height: 1.6; position: relative; }
    .cv-preview::after { content:''; position:absolute; bottom:0; left:0; right:0; height:28px; background: linear-gradient(transparent, #040609); }
    .remove-btn { font-family: var(--mono); font-size: 10px; color: var(--text3); background: none; border: none; cursor: pointer; text-align: left; padding: 0; }
    .remove-btn:hover { color: var(--red); }
    .textarea { width: 100%; background: #040609; border: 1px solid var(--line); border-radius: 9px; padding: 12px 14px; color: var(--text); font-family: var(--sans); font-size: 12px; resize: vertical; min-height: 150px; line-height: 1.6; outline: none; transition: border-color .2s; }
    .textarea:focus { border-color: var(--blue); }
    .textarea::placeholder { color: var(--text3); }
    .input { width: 100%; background: #040609; border: 1px solid var(--line); border-radius: 9px; padding: 10px 14px; color: var(--text); font-family: var(--sans); font-size: 13px; outline: none; transition: border-color .2s; }
    .input:focus { border-color: var(--blue); }
    .input::placeholder { color: var(--text3); }
    .error-box { display: flex; align-items: center; gap: 8px; background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.25); border-radius: 9px; padding: 10px 14px; font-size: 12px; color: #f87171; width: 100%; max-width: 860px; }
    .start-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; max-width: 860px; padding: 16px; border-radius: 12px; background: linear-gradient(135deg, #2563eb, #7c3aed); border: none; cursor: pointer; color: white; font-family: var(--sans); font-size: 15px; font-weight: 700; letter-spacing: .04em; transition: .2s; }
    .start-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(59,130,246,.28); }
    .start-btn:disabled { opacity: .45; cursor: not-allowed; }
    /* ── connecting ── */
    .connecting { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .connecting-inner { display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .pulse-ring { width: 72px; height: 72px; border-radius: 50%; background: linear-gradient(135deg, #2563eb, #7c3aed); display: flex; align-items: center; justify-content: center; animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{box-shadow:0 0 0 0 rgba(124,58,237,.4)} 50%{box-shadow:0 0 0 16px rgba(124,58,237,0)} }
    /* ── live layout ── */
    .live { display: grid; grid-template-columns: 300px 1fr 300px; min-height: 100vh; }
    @media(max-width: 1100px) { .live { grid-template-columns: 280px 1fr; } .live-right { display: none; } }
    @media(max-width: 720px) { .live { grid-template-columns: 1fr; } .live-center { display: none; } }
    .live-left { border-right: 1px solid var(--line); background: var(--bg2); display: flex; flex-direction: column; overflow-y: auto; }
    .live-center { display: flex; flex-direction: column; overflow: hidden; }
    .live-right { border-left: 1px solid var(--line); background: var(--bg2); overflow-y: auto; }
    /* ── left panel ── */
    .agent-top { padding: 20px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .avatar { width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, #1e3460, #0f1f3a); border: 2px solid var(--line2); display: flex; align-items: center; justify-content: center; font-size: 26px; position: relative; transition: .4s; }
    .avatar.thinking { box-shadow: 0 0 0 4px rgba(124,58,237,.25), 0 0 16px rgba(124,58,237,.15); }
    .brain-badge { position: absolute; bottom: -3px; right: -3px; width: 20px; height: 20px; border-radius: 50%; background: #7c3aed; display: flex; align-items: center; justify-content: center; border: 2px solid var(--bg2); animation: pulse 1s ease-in-out infinite; }
    .agent-name { font-family: var(--serif); font-size: 20px; font-weight: 700; }
    .agent-role { font-family: var(--mono); font-size: 10px; color: var(--text3); }
    .status-pill { display: flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 100px; font-family: var(--mono); font-size: 10px; letter-spacing: .04em; transition: .3s; }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; }
    .waveform { display: flex; align-items: flex-end; gap: 2px; height: 28px; }
    .wave-bar { width: 3px; border-radius: 2px; transition: height .12s; }
    /* ── tier diagram ── */
    .tier-wrap { margin: 12px; border-radius: 10px; border: 1px solid var(--line); overflow: hidden; }
    .tier-header { padding: 8px 12px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; }
    .tier-label { font-family: var(--mono); font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--text3); }
    .tier-row { padding: 8px 12px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--line); transition: .3s; }
    .tier-row:last-child { border-bottom: none; }
    .tier-row.active { background: rgba(59,130,246,.04); }
    .tier-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .tier-info { flex: 1; }
    .tier-name { font-size: 11px; font-weight: 600; }
    .tier-desc { font-family: var(--mono); font-size: 9px; color: var(--text3); }
    .tier-count { font-family: var(--mono); font-size: 11px; font-weight: 600; }
    /* ── live score ── */
    .score-wrap { margin: 12px; border-radius: 10px; border: 1px solid var(--line); padding: 12px; }
    .score-big { font-family: var(--serif); font-size: 32px; font-weight: 700; line-height: 1; }
    .score-bar-row { display: flex; align-items: center; gap: 8px; }
    .score-bar-bg { flex: 1; height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; }
    .score-bar-fill { height: 100%; border-radius: 2px; transition: width .5s; }
    /* ── notes ── */
    .notes-wrap { margin: 12px; border-radius: 10px; border: 1px solid rgba(124,58,237,.2); background: rgba(124,58,237,.04); padding: 12px; }
    .notes-label { font-family: var(--mono); font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: #7c3aed; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; }
    .notes-text { font-size: 11px; color: #c4b5fd; line-height: 1.6; white-space: pre-wrap; max-height: 120px; overflow-y: auto; }
    /* ── topics ── */
    .topics-wrap { margin: 12px; border-radius: 10px; border: 1px solid var(--line); padding: 12px; }
    .topic-chip { font-family: var(--mono); font-size: 9px; background: rgba(59,130,246,.1); color: #60a5fa; border: 1px solid rgba(59,130,246,.2); border-radius: 5px; padding: 2px 7px; }
    /* ── controls ── */
    .controls { margin-top: auto; padding: 14px; border-top: 1px solid var(--line); display: flex; gap: 8px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: none; cursor: pointer; border-radius: 9px; font-family: var(--sans); font-weight: 600; font-size: 12px; transition: .2s; padding: 9px 14px; }
    .btn-mute { background: rgba(255,255,255,.05); color: var(--text2); border: 1px solid var(--line); flex: 1; }
    .btn-mute:hover { background: rgba(255,255,255,.09); }
    .btn-muted { background: rgba(239,68,68,.1); color: #f87171; border-color: rgba(239,68,68,.3); }
    .btn-end { background: rgba(239,68,68,.1); color: #f87171; border: 1px solid rgba(239,68,68,.25); flex: 2; }
    .btn-end:hover { background: rgba(239,68,68,.18); }
    /* ── center panel ── */
    .center-head { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .center-title { font-size: 13px; font-weight: 600; }
    .center-meta { font-family: var(--mono); font-size: 9px; color: var(--text3); }
    .center-body { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
    /* ── current question ── */
    .current-q { background: rgba(59,130,246,.06); border: 1px solid rgba(59,130,246,.2); border-radius: 10px; padding: 12px 14px; margin: 0 20px 0; }
    .current-q-label { font-family: var(--mono); font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--blue); margin-bottom: 5px; }
    .current-q-text { font-size: 13px; line-height: 1.5; }
    /* ── log entries ── */
    .log-section-label { font-family: var(--mono); font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--text3); display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .log-entry { display: flex; gap: 10px; align-items: flex-start; }
    .log-avatar { width: 30px; height: 30px; border-radius: 7px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-size: 9px; font-weight: 700; }
    .log-avatar.ai { background: rgba(59,130,246,.1); color: var(--blue); border: 1px solid rgba(59,130,246,.2); }
    .log-avatar.user { background: rgba(16,185,129,.1); color: #10b981; border: 1px solid rgba(16,185,129,.2); }
    .log-text { font-size: 12px; line-height: 1.6; flex: 1; word-break: break-word; }
    .log-text.pending { color: var(--text3); font-style: italic; }
    .log-text.escalated { color: #a78bfa; }
    .log-text.pruned { color: var(--text3); }
    .pruned-badge { font-family: var(--mono); font-size: 8px; color: var(--text3); background: rgba(255,255,255,.04); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; margin-top: 2px; display: inline-block; }
    /* ── right panel ── */
    .right-head { padding: 12px 14px; border-bottom: 1px solid var(--line); }
    .right-score-item { margin: 12px; border-radius: 10px; border: 1px solid var(--line); padding: 12px; display: flex; flex-direction: column; gap: 7px; }
    .rsi-q { font-size: 11px; line-height: 1.4; color: var(--text2); }
    .rsi-a { font-family: var(--mono); font-size: 10px; color: var(--text3); line-height: 1.4; }
    .rsi-fb { font-size: 11px; color: var(--text2); padding-top: 6px; border-top: 1px solid var(--line); line-height: 1.4; }
    .tag { font-family: var(--mono); font-size: 9px; padding: 2px 6px; border-radius: 4px; }
    /* ── report ── */
    .report-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .report { width: 100%; max-width: 800px; background: var(--bg2); border: 1px solid var(--line); border-radius: 20px; overflow: hidden; }
    .report-hero { padding: 36px; background: linear-gradient(135deg, #09101c, #1a1133); border-bottom: 1px solid var(--line); display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
    .report-label { font-family: var(--mono); font-size: 9px; letter-spacing: .18em; text-transform: uppercase; color: #818cf8; }
    .report-title { font-family: var(--serif); font-size: 28px; font-weight: 700; }
    .report-avg { font-family: var(--serif); font-size: 56px; font-weight: 700; line-height: 1; }
    .report-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); }
    .report-stat { background: var(--bg2); padding: 16px; }
    .report-stat-val { font-family: var(--serif); font-size: 26px; font-weight: 700; }
    .report-stat-label { font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--text3); margin-top: 2px; }
    .savings-block { margin: 20px; border-radius: 12px; padding: 20px; background: linear-gradient(135deg, #1e1b4b, #1e3460); border: 1px solid rgba(99,102,241,.3); display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
    .savings-pct { font-family: var(--serif); font-size: 48px; font-weight: 700; color: #a5b4fc; }
    .answers-section { padding: 20px; display: flex; flex-direction: column; gap: 10px; max-height: 400px; overflow-y: auto; }
    .answer-item { border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 7px; }
    .report-footer { padding: 20px; border-top: 1px solid var(--line); display: flex; justify-content: center; }
    .restart-btn { background: linear-gradient(135deg, #2563eb, #7c3aed); color: white; padding: 12px 32px; border-radius: 10px; font-family: var(--sans); font-size: 14px; font-weight: 700; border: none; cursor: pointer; }
    .card-tabs { display: flex; gap: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--line); }
    .tab-btn { background: none; border: none; font-family: var(--mono); font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--text3); padding: 6px 0; cursor: pointer; position: relative; transition: .2s; }
    .tab-btn:hover { color: var(--text2); }
    .tab-btn.active { color: var(--blue); }
    .tab-btn.active::after { content:''; position:absolute; bottom:-1px; left:0; right:0; height:1.5px; background: var(--blue); border-radius: 10px; }
    .template-list { display: grid; gap: 8px; max-height: 250px; overflow-y: auto; padding-right: 4px; }
    .template-item { background: #040609; border: 1px solid var(--line); border-radius: 9px; padding: 10px; text-align: left; cursor: pointer; transition: .2s; }
    .template-item:hover { border-color: var(--blue); background: rgba(59,130,246,.04); }
    .template-item.active { border-color: var(--blue); background: rgba(59,130,246,.08); }
    .template-name { font-size: 11px; font-weight: 600; margin-bottom: 2px; }
    .template-desc { font-family: var(--mono); font-size: 8px; color: var(--text3); text-transform: uppercase; }
    /* ── utils ── */
    @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
    .fade { animation: fadeUp .35s ease forwards; }
    .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.2); border-top-color: white; animation: spin .8s linear infinite; }
    @keyframes spin { to{transform:rotate(360deg)} }
    .mono { font-family: var(--mono); }
    .sep { width: 1px; height: 1px; background: var(--line); margin: 0 -1px; }
    details summary { list-style: none; cursor: pointer; }
    details summary::-webkit-details-marker { display: none; }
    .silence-timer { margin-top: 8px; width: 100%; padding: 10px; border-radius: 9px; background: rgba(59,130,246,.04); border: 1px solid rgba(59,130,246,.15); display: flex; flex-direction: column; align-items: center; gap: 8px; animation: fadeIn .3s ease; }
    .st-label { font-family: var(--mono); font-size: 8px; color: var(--blue); letter-spacing: .12em; text-transform: uppercase; }
    .st-val { font-family: var(--serif); font-size: 24px; font-weight: 700; color: var(--text); line-height: 1; }
    .st-bar-bg { width: 100%; height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; }
    .st-bar-fill { height: 100%; background: var(--blue); transition: width 0.3s linear; }
    @keyframes fadeIn { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }
  `;

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER: Setup
    // ─────────────────────────────────────────────────────────────────────────

    if (phase === 'setup') return (
        <>
            <style>{CSS}</style>
            <div className="shell">
                <div className="noise" />
                <div className="setup">
                    {/* Header */}
                    <div className="fade" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div className="mono" style={{ fontSize: 10, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--blue)' }}>
                            ◈ Tiered AI Interview System
                        </div>
                        <h1 className="setup-title">Your AI interviewer<br />is ready.</h1>
                        <p className="setup-sub">Upload CV + paste JD → live voice interview with real-time scoring</p>
                    </div>

                    {/* Setup grid */}
                    <div className="setup-grid fade">

                        {/* CV card */}
                        <div className="card">
                            <div className="card-label"><Icon.File /> Candidate CV</div>

                            {!cvText ? (
                                <>
                                    <div
                                        className={`drop${cvDrag ? ' over' : ''}`}
                                        onDragOver={e => { e.preventDefault(); setCvDrag(true); }}
                                        onDragLeave={() => setCvDrag(false)}
                                        onDrop={e => { e.preventDefault(); setCvDrag(false); const f = e.dataTransfer.files[0]; if (f) handleCvFile(f); }}
                                        onClick={() => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.pdf,.txt,.doc,.docx'; i.onchange = (e: Event) => { const t = e.target as HTMLInputElement; if (t.files?.[0]) handleCvFile(t.files[0]); }; i.click(); }}
                                    >
                                        <div className="drop-icon">{isParsing ? <div className="spinner" /> : <Icon.Upload />}</div>
                                        <div className="drop-main">{isParsing ? 'Parsing...' : 'Drop CV or click to browse'}</div>
                                        <div className="drop-sub">PDF, TXT, DOC · max 10 MB</div>
                                    </div>
                                    <div className="mono" style={{ textAlign: 'center', fontSize: 10, color: 'var(--text3)' }}>— or paste CV text —</div>
                                    <textarea
                                        className="textarea"
                                        style={{ minHeight: 100 }}
                                        placeholder="Paste your full CV / resume text here..."
                                        value={cvText}
                                        onChange={e => setCvText(e.target.value)}
                                    />
                                </>
                            ) : (
                                <>
                                    <div className="cv-ok">
                                        <div style={{ color: '#10b981' }}><Icon.Check /></div>
                                        <div>
                                            <div className="cv-ok-name">{cvFileName || 'CV loaded'}</div>
                                            <div className="cv-ok-sub">{cvText.length.toLocaleString()} chars extracted</div>
                                        </div>
                                    </div>
                                    <div className="cv-preview">{cvText}</div>
                                    <button className="remove-btn" onClick={() => { setCvText(''); setCvFileName(''); }}>
                                        × Remove — upload different file
                                    </button>
                                </>
                            )}
                        </div>

                        {/* JD card */}
                        <div className="card">
                            <div className="card-label" style={{ justifyContent: 'space-between' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon.Zap /> Job Description</div>
                                <div className="card-tabs">
                                    <button className={`tab-btn${jdTab === 'paste' ? ' active' : ''}`} onClick={() => setJdTab('paste')}>Manual Paste</button>
                                    <button className={`tab-btn${jdTab === 'templates' ? ' active' : ''}`} onClick={() => setJdTab('templates')}>Role Templates</button>
                                </div>
                            </div>

                            {jdTab === 'paste' ? (
                                <textarea
                                    className="textarea"
                                    placeholder="Paste the full job description here..."
                                    style={{ minHeight: 254 }}
                                    value={jdText}
                                    onChange={e => setJdText(e.target.value)}
                                />
                            ) : (
                                <div className="template-list">
                                    {JD_TEMPLATES.map(t => (
                                        <button
                                            key={t.id}
                                            className={`template-item${jdText === t.content ? ' active' : ''}`}
                                            onClick={() => { setJdText(t.content); setJdTab('paste'); }}
                                        >
                                            <div className="template-name">{t.title}</div>
                                            <div className="template-desc">{t.desc}</div>
                                        </button>
                                    ))}
                                </div>
                            )}

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10 }}>
                                <label className="mono" style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)' }}>
                                    Your name (optional)
                                </label>
                                <input
                                    className="input"
                                    placeholder="e.g. Alex Chen"
                                    value={candidateName}
                                    onChange={e => setCandidateName(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Capability tags */}
                    <div className="fade" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', maxWidth: 860 }}>
                        {[
                            { label: '3-tier cost architecture', color: '#818cf8' },
                            { label: 'On-demand CV lookup (no token waste)', color: '#10b981' },
                            { label: 'Context pruning every 4 turns', color: '#f59e0b' },
                            { label: 'Live answer scoring', color: '#60a5fa' },
                            { label: 'Rolling smart notes', color: '#c084fc' },
                        ].map((t, i) => (
                            <div key={i} className="mono" style={{ fontSize: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 10px', color: t.color }}>
                                {t.label}
                            </div>
                        ))}
                    </div>

                    {setupErr && (
                        <div className="error-box fade">
                            <Icon.AlertCircle />
                            {setupErr}
                        </div>
                    )}

                    <button
                        className="start-btn fade"
                        disabled={isStarting || (!cvText && !jdText)}
                        onClick={() => {
                            setSetupErr('');
                            setPhase('connecting');
                            startCall();
                        }}
                    >
                        {isStarting
                            ? <><div className="spinner" /> Connecting...</>
                            : <><Icon.Zap /> Begin Interview</>
                        }
                    </button>
                </div>
            </div>
        </>
    );

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER: Connecting
    // ─────────────────────────────────────────────────────────────────────────

    if (phase === 'connecting') return (
        <>
            <style>{CSS}</style>
            <div className="shell">
                <div className="noise" />
                <div className="connecting">
                    <div className="connecting-inner fade">
                        <div className="pulse-ring">
                            <Icon.Zap />
                        </div>
                        <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 700 }}>Connecting to Aria...</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>
                            Initializing voice session · Preprocessing CV
                        </div>
                    </div>
                </div>
            </div>
        </>
    );

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER: Final Report
    // ─────────────────────────────────────────────────────────────────────────

    if (phase === 'ended') return (
        <>
            <style>{CSS}</style>
            <div className="shell">
                <div className="noise" />
                <div className="report-wrap">
                    <div className="report fade">

                        {/* Hero */}
                        <div className="report-hero">
                            <div className="report-label">Interview Complete</div>
                            <div className="report-title">Performance Report</div>
                            {candidateName && <div className="mono" style={{ fontSize: 12, color: 'var(--text2)' }}>{candidateName} · {fmt(duration)}</div>}
                            {avgScore > 0 && (
                                <>
                                    <div className="report-avg" style={{ color: scoreColor(avgScore) }}>{avgScore.toFixed(1)}</div>
                                    <div style={{ fontSize: 12, color: 'var(--text2)' }}>Average Score / 10 · {scores.length} evaluated answers</div>
                                </>
                            )}
                        </div>

                        {/* Stats */}
                        <div className="report-stats">
                            {[
                                { val: String(questionCount), label: 'Questions Asked', color: '#60a5fa' },
                                { val: String(scores.length), label: 'Scored Answers', color: '#818cf8' },
                                { val: `${savings}%`, label: 'Cost Saved', color: '#10b981' },
                                { val: fmt(duration), label: 'Duration', color: '#f59e0b' },
                                { val: `$${totalCost.toFixed(4)}`, label: 'Total Cost', color: '#34d399' },
                                { val: String(topicsCovered.length), label: 'Topics Covered', color: '#c084fc' },
                            ].map((s, i) => (
                                <div className="report-stat" key={i}>
                                    <div className="report-stat-val" style={{ color: s.color }}>{s.val}</div>
                                    <div className="report-stat-label">{s.label}</div>
                                </div>
                            ))}
                        </div>

                        {/* Topics */}
                        {topicsCovered.length > 0 && (
                            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)' }}>
                                <div className="mono" style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 8 }}>Topics Covered</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                    {topicsCovered.map((t, i) => <span key={i} className="topic-chip">{t}</span>)}
                                </div>
                            </div>
                        )}

                        {/* Savings */}
                        {stdCost > 0 && (
                            <div className="savings-block">
                                <div className="mono" style={{ fontSize: 9, letterSpacing: '.15em', textTransform: 'uppercase', color: '#a5b4fc' }}>
                                    Architecture Savings vs Standard Realtime
                                </div>
                                <div className="savings-pct">{savings}% Saved</div>
                                <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                                    <div>
                                        <div className="mono" style={{ fontSize: 9, color: '#f87171', marginBottom: 2 }}>STANDARD</div>
                                        <div className="mono" style={{ fontSize: 15, textDecoration: 'line-through', color: '#f87171' }}>${stdCost.toFixed(4)}</div>
                                    </div>
                                    <div style={{ color: 'var(--text3)' }}>→</div>
                                    <div>
                                        <div className="mono" style={{ fontSize: 9, color: '#34d399', marginBottom: 2 }}>SMART TIER</div>
                                        <div style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 700, color: 'white' }}>${totalCost.toFixed(4)}</div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Answer breakdown */}
                        {scores.length > 0 && (
                            <div className="answers-section">
                                <div className="mono" style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 4 }}>Answer Breakdown</div>
                                {scores.map((s, i) => (
                                    <div className="answer-item" key={i}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                                            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.4 }}>Q{i + 1}: {s.question}</div>
                                            <ScoreBadge score={s.score} />
                                        </div>
                                        <div className="mono" style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.4 }}>{s.answerSummary}</div>
                                        {s.feedback && <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5, paddingTop: 6, borderTop: '1px solid var(--line)' }}>{s.feedback}</div>}
                                        {s.tags.length > 0 && (
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                                {s.tags.map((t, j) => {
                                                    const c = t.includes('strong') || t.includes('good') ? '#10b981' :
                                                        t.includes('weak') || t.includes('gap') ? '#ef4444' : '#818cf8';
                                                    return (
                                                        <span key={j} className="tag" style={{ background: c + '18', color: c, border: `1px solid ${c}33` }}>{t}</span>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Footer */}
                        <div className="report-footer">
                            <button className="restart-btn" onClick={() => {
                                setPhase('setup');
                                setLogs([]); setScores([]); setTopicsCovered([]);
                                setQuestionCount(0); setCurrentQ(''); setSmartNotes('');
                                setCvSummary(''); setDuration(0); setLiveCost(0);
                            }}>
                                Start New Interview
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER: Live Interview
    // ─────────────────────────────────────────────────────────────────────────

    // Split logs into active (in RT context) and pruned
    const activeLogs = logs.filter(l =>
        l.id === '__start__' ? false :
            l.pending || !l.id || activeRtItems.includes(l.id)
    );
    const allLogs = logs.filter(l => l.id !== '__start__' && l.text);

    return (
        <>
            <style>{CSS}</style>
            <div className="shell">
                <div className="noise" />
                <div className="live">

                    {/* ── LEFT PANEL ─────────────────────────────────────────────── */}
                    <div className="live-left">

                        {/* Agent header */}
                        <div className="agent-top">
                            <div className={`avatar${isThinking ? ' thinking' : ''}`}>
                                🎙️
                                {isThinking && (
                                    <div className="brain-badge"><Icon.Brain /></div>
                                )}
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div className="agent-name">Aria</div>
                                <div className="agent-role">Senior AI Interviewer</div>
                            </div>

                            {/* Status */}
                            <div className="status-pill" style={{
                                background: isThinking ? 'rgba(124,58,237,.12)' : isCallActive ? 'rgba(16,185,129,.08)' : 'rgba(255,255,255,.04)',
                                color: isThinking ? '#a78bfa' : isCallActive ? '#10b981' : 'var(--text2)',
                                border: `1px solid ${isThinking ? 'rgba(124,58,237,.3)' : isCallActive ? 'rgba(16,185,129,.2)' : 'var(--line)'}`,
                            }}>
                                <div className="status-dot" style={{
                                    background: isThinking ? '#7c3aed' : isCallActive ? '#10b981' : 'var(--line2)',
                                    boxShadow: isCallActive ? `0 0 6px ${isThinking ? '#7c3aed' : '#10b981'}` : 'none',
                                }} />
                                {callStatus}
                            </div>

                            {/* Timer / cost toggle */}
                            <button
                                onClick={() => setShowCost(p => !p)}
                                style={{ background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', borderRadius: 8, padding: '4px 12px', cursor: 'pointer', color: 'var(--text2)' }}
                            >
                                <span className="mono" style={{ fontSize: 11 }}>
                                    {showCost ? `$${liveCost.toFixed(5)}` : fmt(duration)}
                                </span>
                            </button>

                            {silenceRemaining !== null && (
                                <div className="silence-timer">
                                    <div className="st-label">AI Check-in in</div>
                                    <div className="st-val">{silenceRemaining}s</div>
                                    <div className="st-bar-bg">
                                        <div className="st-bar-fill" style={{ width: `${(silenceRemaining * 1000 / silenceLimitRef.current) * 100}%` }} />
                                    </div>
                                </div>
                            )}

                            {/* Waveform */}
                            <div className="waveform">
                                {waveHeights.map((h, i) => (
                                    <div key={i} className="wave-bar" style={{
                                        height: h,
                                        background: isThinking ? 'var(--violet)' : isCallActive ? 'var(--blue)' : 'var(--line2)',
                                    }} />
                                ))}
                            </div>

                            {cvSummary && (
                                <div className="mono" style={{ fontSize: 9, background: 'rgba(245,158,11,.08)', color: '#f59e0b', border: '1px solid rgba(245,158,11,.2)', borderRadius: 6, padding: '3px 8px' }}>
                                    CV pre-processed ✓
                                </div>
                            )}
                            {cvLookup && (
                                <div className="mono" style={{ fontSize: 9, background: 'rgba(99,102,241,.08)', color: '#818cf8', border: '1px solid rgba(99,102,241,.2)', borderRadius: 6, padding: '3px 8px' }}>
                                    Looking up CV...
                                </div>
                            )}
                        </div>

                        {/* Cost tier diagram */}
                        <div className="tier-wrap">
                            <div className="tier-header">
                                <span className="tier-label">AI Decision Tiers</span>
                                <span className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>live cost routing</span>
                            </div>

                            {/* Tier 1 */}
                            <div className={`tier-row${!isThinking && isCallActive ? ' active' : ''}`}>
                                <div className="tier-dot" style={{ background: '#10b981', boxShadow: !isThinking && isCallActive ? '0 0 6px #10b981' : 'none' }} />
                                <div className="tier-info">
                                    <div className="tier-name" style={{ color: !isThinking && isCallActive ? '#10b981' : 'var(--text2)' }}>Layer 1 · RT Voice</div>
                                    <div className="tier-desc">gpt-4o-mini-realtime · always on</div>
                                </div>
                                <div className="tier-count" style={{ color: 'var(--text3)' }}>$0.01/min</div>
                            </div>

                            {/* Tier 2 */}
                            <div className={`tier-row${escalTarget === 'mini' && isThinking ? ' active' : ''}`}>
                                <div className="tier-dot" style={{ background: '#818cf8', boxShadow: escalTarget === 'mini' && isThinking ? '0 0 6px #818cf8' : 'none' }} />
                                <div className="tier-info">
                                    <div className="tier-name" style={{ color: escalTarget === 'mini' && isThinking ? '#818cf8' : 'var(--text2)' }}>Layer 2 · Standard Eval</div>
                                    <div className="tier-desc">gpt-4o-mini · selective</div>
                                </div>
                                <div className="tier-count" style={{ color: escalTarget === 'mini' && isThinking ? '#818cf8' : 'var(--text3)' }}>{miniCount}×</div>
                            </div>

                            {/* Tier 3 */}
                            <div className={`tier-row${escalTarget === 'gpt4o' && isThinking ? ' active' : ''}`}>
                                <div className="tier-dot" style={{ background: '#f59e0b', boxShadow: escalTarget === 'gpt4o' && isThinking ? '0 0 6px #f59e0b' : 'none' }} />
                                <div className="tier-info">
                                    <div className="tier-name" style={{ color: escalTarget === 'gpt4o' && isThinking ? '#f59e0b' : 'var(--text2)' }}>Layer 3 · Deep Eval</div>
                                    <div className="tier-desc">gpt-4o · on complex questions</div>
                                </div>
                                <div className="tier-count" style={{ color: escalTarget === 'gpt4o' && isThinking ? '#f59e0b' : 'var(--text3)' }}>{gpt4oCount}×</div>
                            </div>
                        </div>

                        {/* Live score */}
                        {scores.length > 0 && (
                            <div className="score-wrap">
                                <div className="mono" style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 6 }}>
                                    Live Score · {scores.length} answers
                                </div>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10 }}>
                                    <span className="score-big" style={{ color: scoreColor(avgScore) }}>{avgScore.toFixed(1)}</span>
                                    <span className="mono" style={{ fontSize: 10, color: 'var(--text3)' }}>/10</span>
                                </div>
                                {scores.slice(-5).map((s, i) => (
                                    <div key={i} className="score-bar-row" style={{ marginBottom: 5 }}>
                                        <span className="mono" style={{ fontSize: 9, color: 'var(--text3)', width: 20 }}>Q{scores.length > 5 ? scores.length - 4 + i : i + 1}</span>
                                        <div className="score-bar-bg">
                                            <div className="score-bar-fill" style={{ width: `${s.score * 10}%`, background: scoreColor(s.score) }} />
                                        </div>
                                        <span className="mono" style={{ fontSize: 9, color: 'var(--text2)', width: 16 }}>{s.score}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Topics covered */}
                        {topicsCovered.length > 0 && (
                            <div className="topics-wrap">
                                <div className="mono" style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 7 }}>
                                    Topics Covered
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                                    {topicsCovered.map((t, i) => <span key={i} className="topic-chip">{t}</span>)}
                                </div>
                            </div>
                        )}

                        {/* Smart notes */}
                        {smartNotes && (
                            <div className="notes-wrap">
                                <div className="notes-label">
                                    <span>Interview Notes</span>
                                    {memStatus !== 'idle' && (
                                        <span style={{ fontSize: 9, color: '#a78bfa', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <div style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid rgba(167,139,250,.4)', borderTopColor: '#a78bfa', animation: 'spin .8s linear infinite' }} />
                                            {memStatus === 'saving' ? 'Saving...' : 'Recalling...'}
                                        </span>
                                    )}
                                </div>
                                <div className="notes-text">{smartNotes}</div>
                            </div>
                        )}

                        <div style={{ flex: 1 }} />

                        {/* Controls */}
                        <div className="controls">
                            <button className={`btn btn-mute${isMuted ? ' btn-muted' : ''}`} onClick={toggleMute}>
                                {isMuted ? <Icon.MicOff /> : <Icon.Mic />}
                                {isMuted ? 'Unmute' : 'Mute'}
                            </button>
                            <button className="btn btn-end" onClick={endCall}>
                                <Icon.PhoneOff /> End
                            </button>
                        </div>
                    </div>

                    {/* ── CENTER PANEL ────────────────────────────────────────────── */}
                    <div className="live-center">

                        {/* Header */}
                        <div className="center-head">
                            <div>
                                <div className="center-title">
                                    Live Interview · {candidateName || 'Candidate'}
                                </div>
                                <div className="center-meta">
                                    Q{questionCount} asked · {activeRtItems.length} items in RT context · {userTurnCountRef.current} turns
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                {activeRtItems.length > KEEP_ITEMS_IN_RT && (
                                    <div className="mono" style={{ fontSize: 9, background: 'rgba(245,158,11,.08)', color: '#f59e0b', border: '1px solid rgba(245,158,11,.2)', borderRadius: 6, padding: '3px 8px' }}>
                                        pruning in {PRUNE_EVERY_N_TURNS - (userTurnCountRef.current % PRUNE_EVERY_N_TURNS)} turns
                                    </div>
                                )}
                                {avgScore > 0 && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', borderRadius: 8, padding: '4px 10px' }}>
                                        <Icon.Star />
                                        <span className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>{avgScore.toFixed(1)}</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Current question */}
                        {currentQ && (
                            <div className="current-q" style={{ marginTop: 14 }}>
                                <div className="current-q-label">Current Question</div>
                                <div className="current-q-text">{currentQ}</div>
                            </div>
                        )}

                        <div className="center-body">
                            {/* Active context — what RT model sees */}
                            <div>
                                <div className="log-section-label">
                                    <span>Active RT Context ({activeLogs.length} items)</span>
                                    <span style={{ fontSize: 9 }}>what the AI sees right now</span>
                                </div>
                                {activeLogs.length === 0 ? (
                                    <div className="mono" style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic', textAlign: 'center', padding: '20px 0' }}>
                                        Waiting for interview to begin...
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                        {activeLogs.map((log, i) => (
                                            <div key={i} className="log-entry">
                                                <div className={`log-avatar ${log.role}`}>{log.role === 'ai' ? 'AI' : 'You'}</div>
                                                <div style={{ flex: 1 }}>
                                                    <div className={`log-text${log.pending ? ' pending' : log.escalated ? ' escalated' : ''}`}>
                                                        {log.escalated && '🧠 '}
                                                        {log.text}
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Full history — with pruned markers */}
                            <details>
                                <summary style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255,255,255,.02)', border: '1px solid var(--line)', borderRadius: 9 }}>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                        <Icon.Mic />
                                        <span className="mono" style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text3)' }}>Full Conversation History</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <span className="mono" style={{ fontSize: 9, background: 'rgba(255,255,255,.05)', color: 'var(--text3)', padding: '1px 6px', borderRadius: 4 }}>
                                            {allLogs.filter(l => l.pruned).length} pruned from RT
                                        </span>
                                        <span className="mono" style={{ fontSize: 9, background: 'rgba(16,185,129,.08)', color: '#10b981', padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(16,185,129,.2)' }}>
                                            {allLogs.filter(l => !l.pruned).length} live
                                        </span>
                                    </div>
                                </summary>
                                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    {allLogs.map((log, i) => (
                                        <div key={i} className="log-entry" style={{ opacity: log.pruned ? 0.45 : 1 }}>
                                            <div className={`log-avatar ${log.role}`}>{log.role === 'ai' ? 'AI' : 'You'}</div>
                                            <div style={{ flex: 1 }}>
                                                <div className={`log-text${log.pruned ? ' pruned' : ''}`}>{log.text}</div>
                                                {log.pruned && <span className="pruned-badge">pruned from RT context</span>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'center', padding: '8px 0', fontStyle: 'italic' }}>
                                    Pruned items are removed from the AI context window to save cost. They stay here for your reference.
                                </div>
                            </details>
                        </div>
                    </div>

                    {/* ── RIGHT PANEL ─────────────────────────────────────────────── */}
                    <div className="live-right">
                        <div className="right-head">
                            <div className="mono" style={{ fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                <Icon.Star /> Answer Scores · Live
                            </div>
                        </div>

                        {scores.length === 0 ? (
                            <div className="mono" style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 11, fontStyle: 'italic', lineHeight: 1.7 }}>
                                Scores will appear here after each answer is evaluated by the AI...
                            </div>
                        ) : (
                            <>
                                {/* Average */}
                                <div style={{ padding: '14px 14px 0' }}>
                                    <div className="mono" style={{ fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 4 }}>Overall Average</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                        <span style={{ fontFamily: 'var(--serif)', fontSize: 36, fontWeight: 700, color: scoreColor(avgScore) }}>{avgScore.toFixed(1)}</span>
                                        <span className="mono" style={{ fontSize: 12, color: 'var(--text3)' }}>/10 · {scores.length} answers</span>
                                    </div>
                                </div>

                                {/* Individual scores, newest first */}
                                {[...scores].reverse().map((s, i) => (
                                    <div className="right-score-item" key={i}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                                            <div className="rsi-q">Q{scores.length - i}: {s.question.length > 80 ? s.question.slice(0, 80) + '…' : s.question}</div>
                                            <ScoreBadge score={s.score} />
                                        </div>
                                        {s.answerSummary && <div className="rsi-a">↳ {s.answerSummary.length > 100 ? s.answerSummary.slice(0, 100) + '…' : s.answerSummary}</div>}
                                        {s.feedback && <div className="rsi-fb">{s.feedback}</div>}
                                        {s.tags.length > 0 && (
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                                {s.tags.map((t, j) => {
                                                    const c = t.includes('strong') || t.includes('good') ? '#10b981' :
                                                        t.includes('weak') || t.includes('gap') ? '#ef4444' : '#818cf8';
                                                    return <span key={j} className="tag" style={{ background: c + '18', color: c, border: `1px solid ${c}33` }}>{t}</span>;
                                                })}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </>
                        )}

                        {/* Session context */}
                        <details style={{ margin: 12 }}>
                            <summary className="mono" style={{ fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)', display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                                <Icon.File /> Session Context
                            </summary>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                                {cvText && (
                                    <div>
                                        <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 3 }}>CV · {cvText.length.toLocaleString()} chars</div>
                                        <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', lineHeight: 1.5, maxHeight: 60, overflow: 'hidden' }}>{cvText.slice(0, 200)}…</div>
                                    </div>
                                )}
                                {jdText && (
                                    <div>
                                        <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 3 }}>JD · {jdText.length.toLocaleString()} chars</div>
                                        <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', lineHeight: 1.5, maxHeight: 60, overflow: 'hidden' }}>{jdText.slice(0, 200)}…</div>
                                    </div>
                                )}
                            </div>
                        </details>
                    </div>

                </div>
            </div>
        </>
    );
}
