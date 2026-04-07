'use client';

/**
 * Aria v4 — AI Interview System
 * Architecture: Asynchronous Sidecar (Actor-Observer Pattern) with Phase-Split Observers
 *
 * 1. The Actor (RT Voice Pipe):
 * - Zero tools, zero signal instructions. Purely conversational.
 * - "Clutch" Prompt: If asked for data it lacks, it says "Let me check..." and stops.
 *
 * 2. The Specialized Observers (GPT-4o-mini REST):
 * - Constantly watches the transcript array asynchronously.
 * - SPLIT BY PHASE to reduce hallucination:
 * a) Greeting/Warmup Observer (Focus: Rapport, CV lookups, transition to tech)
 * b) Interview Observer (Focus: Scoring triggers, topic exhaustion, technical deep-dives)
 * c) Closing Observer (Focus: Wrap-up, final questions, end-call transitions)
 *
 * 3. The Scoring Sub-Observer:
 * - A separate, lightweight parallel model explicitly designated for candidate grading.
 *
 * 4. The Injector:
 * - Pushes out-of-band `role: "system"` messages into the RT context.
 */

import { useState, useEffect, useRef, useCallback, Fragment } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type AppPhase = 'setup' | 'connecting' | 'greeting' | 'warmup' | 'interview' | 'closing' | 'report';

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
    // Sub-Observer Metrics
    confidence?: string;
    grammar?: string;
    clarity?: string;
    depthStr?: string;
};

type TopicDepth = {
    topic: string;
    level: number; // 1=surface, 2=technical, 3=deep
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

// Master Observer Analysis Type (Merged schema for all phases)
type ObserverAnalysis = {
    is_filler_pause: boolean;
    is_substantive_answer: boolean;
    answer_summary: string;
    needs_cv_lookup: boolean;
    cv_topic: string;
    topic_exhausted: boolean;
    suggested_phase_advance: 'none' | 'warmup' | 'interview' | 'closing' | 'report';
    should_score_answer: boolean;
    // Supervisor Features
    ai_rambling: boolean;
    ai_hallucination_or_tone_issue: string;
    candidate_struggling: boolean;
    red_flag_detected: string;
    callback_opportunity: string;
    // Dynamic Timer Features
    requested_pause_seconds: number;
    is_complex_question: boolean;
    // Closing Specific
    candidate_has_final_question?: boolean;
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

const PRUNE_EVERY_N_TURNS = 6;
const KEEP_ITEMS_IN_RT = 10;
const INTERVIEW_DURATION_MS = 10 * 60 * 1000;
const INTERVIEW_WARNING_MS = 8 * 60 * 1000;
const TOPIC_TIME_LIMIT_MS = 4 * 60 * 1000;
const GREETING_AUTO_ADVANCE_MS = 60000;
const WARMUP_QUESTIONS_REQUIRED = 3;
const WARMUP_QUESTIONS_HARD_LIMIT = 6;
const GAP_DETECT_EVERY_N_ANSWERS = 3;

const SILENCE_BASE_MS = 15000; // 15 seconds default
const SILENCE_COMPLEX_MS = 40000; // 40 seconds for hard questions

const JD_TEMPLATES = [
    {
        id: 'frontend', title: 'Frontend Engineer', desc: 'React, Next.js, UI engineering',
        content: `We are looking for a Frontend Engineer to build premium web experiences.\n\nCore Responsibilities:\n- Build high-performance React/Next.js interfaces\n- Implement responsive layouts and animations\n- Optimize for Core Web Vitals and SEO\n- Collaborate with Design via Figma\n\nRequirements:\n- 3+ years React experience\n- Expert TypeScript and Tailwind knowledge\n- Familiarity with Framer Motion or GSAP`,
    },
    {
        id: 'backend', title: 'Backend Engineer', desc: 'Node.js, PostgreSQL, System Design',
        content: `Seeking a Backend Engineer to scale our distributed systems.\n\nCore Responsibilities:\n- Design robust REST and GraphQL APIs\n- Manage PostgreSQL and Redis performance\n- Implement secure auth and data protection\n- Architecture for high-concurrency workloads\n\nRequirements:\n- 4+ years Node.js or similar\n- Strong SQL and database modeling\n- Experience with K8s, Docker, or Serverless`,
    },
];

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

function getTimeGreeting(): string {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
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
        level >= 3 ? ['#c084fc', 'Deep'] :
            level >= 2 ? ['#38bdf8', 'Technical'] :
                ['#94a3b8', 'Surface'];
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
    const phases: AppPhase[] = ['greeting', 'warmup', 'interview', 'closing', 'report'];
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
    const [cvDrag, setCvDrag] = useState(false);
    const [jdTab, setJdTab] = useState<'paste' | 'templates'>('paste');
    const [isParsing, setIsParsing] = useState(false);
    const [setupErr, setSetupErr] = useState('');

    // ── Live State ───────────────────────────────────────────────────────────
    const [isCallActive, setIsCallActive] = useState(false);
    const [callStatus, setCallStatus] = useState('Ready');
    const [isMuted, setIsMuted] = useState(false);
    const [micLevel, setMicLevel] = useState(0);
    const [duration, setDuration] = useState(0);
    const [liveCost, setLiveCost] = useState(0);
    const [showCost, setShowCost] = useState(false);

    // ── Interview State ──────────────────────────────────────────────────────
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [scores, setScores] = useState<AnswerScore[]>([]);
    const [topicsCovered, setTopicsCovered] = useState<string[]>([]);
    const [questionCount, setQuestionCount] = useState(0);
    const [numQuestions, setNumQuestions] = useState(5);
    const [currentQ, setCurrentQ] = useState('');
    const [smartNotes, setSmartNotes] = useState('');
    const [cvSummary, setCvSummary] = useState('');
    const [warmupCount, setWarmupCount] = useState(0);
    const [bridgeCount, setBridgeCount] = useState(0);
    const [isBridging, setIsBridging] = useState(false);
    const [isCvLooking, setIsCvLooking] = useState(false);
    const [isCvAnalyzing, setIsCvAnalyzing] = useState(false);
    const [isThinking, setIsThinking] = useState(false);
    const [interviewTimeLeft, setInterviewTimeLeft] = useState(INTERVIEW_DURATION_MS / 1000);
    const [activeRtItems, setActiveRtItems] = useState<string[]>([]);
    const [currentTopicDisplay, setCurrentTopicDisplay] = useState('');
    const [currentDepth, setCurrentDepth] = useState(1);
    const [detectedGap, setDetectedGap] = useState('');
    const [strategyTopics, setStrategyTopics] = useState<string[]>([]);
    const [intelLog, setIntelLog] = useState<IntelLog[]>([]);
    const [lastObserverAnalysis, setLastObserverAnalysis] = useState<ObserverAnalysis | null>(null);
    const [silenceTimeLeft, setSilenceTimeLeft] = useState<number | null>(null);
    const [lastInjection, setLastInjection] = useState<string | null>(null);

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
    const warmupCountRef = useRef(0);

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

    const greetingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const interviewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const interviewStartTimeRef = useRef<number>(0);
    const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closingTimeLeftRef = useRef<number>(0);

    // ── Dynamic Silence Timer Refs ──
    const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const silenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const silenceStartTimeRef = useRef<number>(0);
    const silenceDurationRef = useRef<number>(0);
    const currentSilenceMsRef = useRef<number>(SILENCE_BASE_MS);
    const numQuestionsRef = useRef<number>(5);

    const usageRef = useRef<Usage>({
        rtTextIn: 0, rtAudioIn: 0, rtTextOut: 0, rtAudioOut: 0, miniPrompt: 0, miniCompletion: 0,
    });

    // Sync data refs
    useEffect(() => { cvTextRef.current = cvText; }, [cvText]);
    useEffect(() => { jdTextRef.current = jdText; }, [jdText]);
    useEffect(() => { candidateNameRef.current = candidateName; }, [candidateName]);
    useEffect(() => { numQuestionsRef.current = numQuestions; }, [numQuestions]);

    // ─────────────────────────────────────────────────────────────────────────
    // RT Comm Helpers
    // ─────────────────────────────────────────────────────────────────────────

    const sendRt = useCallback((msg: object) => {
        const dc = dcRef.current;
        if (dc?.readyState === 'open' && !isEndingRef.current) {
            dc.send(JSON.stringify(msg));
        }
    }, []);

    // Inject out-of-band context silently to the RT model
    const injectSystemMessage = useCallback((text: string, forceResponse = false) => {
        // Force strict compliance onto every directive injected into the transcript
        const strictText = text.includes('SYSTEM DIRECTIVE')
            ? `${text} (CRITICAL RULE: Obey this directive for your next turn only. Discard previous directives. NEVER ask more than one question total).`
            : text;

        sendRt({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: strictText }]
            }
        });

        // Record in local history so Observer sees it
        convHistoryRef.current = [...convHistoryRef.current.slice(-39), { role: 'system', content: strictText }];

        setLastInjection(strictText);

        if (forceResponse) {
            sendRt({ type: 'response.create' });
        }
    }, [sendRt]);

    const addIntelLog = useCallback((type: IntelLog['type'], message: string) => {
        const id = makeId();
        setIntelLog(prev => [{ id, type, message, status: 'active' as const, timestamp: Date.now() }, ...prev].slice(0, 5));
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
            const elapsed = Date.now() - silenceStartTimeRef.current;
            const remaining = Math.max(0, silenceDurationRef.current - elapsed);
            setSilenceTimeLeft(remaining);
            if (remaining <= 0) {
                if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
            }
        }, 100);

        silenceTimerRef.current = setTimeout(() => {
            // Timer triggers! Wake up the AI to check on user
            injectSystemMessage("SYSTEM DIRECTIVE: The user has been completely silent. Politely ask if they are still there, if they need more time, or if they need you to repeat the question.", true);
            // Reset back to normal default
            currentSilenceMsRef.current = SILENCE_BASE_MS;
            clearSilenceTimer();
        }, timeout);
    }, [clearSilenceTimer, injectSystemMessage]);


    // ─────────────────────────────────────────────────────────────────────────
    // Prompt Builder (The Pure Actor)
    // ─────────────────────────────────────────────────────────────────────────

    const buildActorPrompt = useCallback((forPhase?: AppPhase): string => {
        const p = forPhase ?? phaseRef.current;
        const name = candidateNameRef.current || 'the candidate';
        const jd = jdTextRef.current;

        const phaseInstructions: Record<AppPhase, string> = {
            setup: 'Wait.', connecting: 'Wait.',
            greeting: `${getTimeGreeting()}! Greet ${name} warmly. You are Aria, a senior interviewer. Ask if they can hear you clearly and are comfortable to begin. Keep it to 2 sentences.`,
            warmup: `Ask warm, light personal questions to build rapport. Listen and respond humanly. Follow any injected system directives for what to ask.`,
            interview: `Conduct the technical interview. Listen carefully to their answers. Follow injected system directives to guide your questions and transitions.`,
            closing: `Thank ${name} warmly. Tell them the interview is complete. Give one sentence on next steps. Wish them well and stop.`,
            report: 'Silent.',
        };

        return `CURRENT PHASE: ${p.toUpperCase()}
INSTRUCTIONS: ${phaseInstructions[p]}

─────────────────────────────────────────
CANDIDATE: ${name}
JOB ROLE: ${jd ? jd.split('\n')[0] : 'Not provided'}
─────────────────────────────────────────

CRITICAL DIRECTIVES (THE CLUTCH & THE OBSERVER):
1. You are Aria, a human, warm, and highly conversational senior interviewer. Keep responses under 35 words.
2. IMPORTANT: You have a backend assistant retrieving CV data and documents for you in real-time. NEVER tell the user "I don't have access to your CV" or "I am an AI." You DO have access, it just takes a second to load.
3. THE CLUTCH PAUSE: If you are asked to verify, check, or summarize the candidate's CV/resume, OR asked a specific background question not in your context, you MUST stall. Say EXACTLY: "Let me pull up your file...", "Give me a second to check your CV...", or "Let me look at my notes..." and then IMMEDIATELY STOP SPEAKING.
4. Do NOT hallucinate facts. Do NOT apologize. Just use the filler phrase and pause. The backend will instantly inject the correct SYSTEM DATA into your thoughts.
5. STRICT ONE QUESTION RULE: You MUST NEVER ask more than one question per response. If you ask a question, you must STOP speaking immediately. Do not stack questions.
6. EPHEMERAL DIRECTIVES: When you receive a "SYSTEM DIRECTIVE", it applies ONLY to your very next turn. Follow it strictly, ask exactly one question if prompted to, and then consider it obsolete. ALWAYS prioritize the most recent directive over past ones.
`;
    }, []);

    const transitionPhase = useCallback((newPhase: AppPhase) => {
        if (isEndingRef.current) return;
        phaseRef.current = newPhase;
        setPhase(newPhase);
        sendRt({
            type: 'session.update',
            session: { instructions: buildActorPrompt(newPhase) },
        });
    }, [sendRt, buildActorPrompt]);

    const endCall = useCallback(() => {
        if (isEndingRef.current) return;
        isEndingRef.current = true;

        clearSilenceTimer();
        if (greetingTimeoutRef.current) clearTimeout(greetingTimeoutRef.current);
        if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);
        if (closingTimerRef.current) clearTimeout(closingTimerRef.current);
        if (rafRef.current) cancelAnimationFrame(rafRef.current);

        pcRef.current?.close();
        dcRef.current?.close();
        streamRef.current?.getTracks().forEach(t => t.stop());
        pcRef.current = null; dcRef.current = null; streamRef.current = null;
        if (audioElRef.current) audioElRef.current.srcObject = null;

        phaseRef.current = 'report';
        setPhase('report');
        setIsCallActive(false);
        setCallStatus('Interview ended');
    }, [clearSilenceTimer]);

    const startInterviewTimer = useCallback(() => {
        interviewStartTimeRef.current = Date.now();
        topicStartTimeRef.current = Date.now();
        if (interviewTimerRef.current) clearInterval(interviewTimerRef.current);

        interviewTimerRef.current = setInterval(() => {
            if (isEndingRef.current) { clearInterval(interviewTimerRef.current!); return; }
            const elapsed = Date.now() - interviewStartTimeRef.current;
            const remaining = Math.max(0, INTERVIEW_DURATION_MS - elapsed);
            setInterviewTimeLeft(Math.floor(remaining / 1000));

            if (elapsed >= INTERVIEW_WARNING_MS) {
                injectSystemMessage('SYSTEM DIRECTIVE: You have 2 minutes left. Wrap up the current topic and transition towards the closing phase naturally.', false);
            }
            if (elapsed >= INTERVIEW_DURATION_MS) {
                clearInterval(interviewTimerRef.current!);
                injectSystemMessage('SYSTEM DIRECTIVE: Time is up. Transition to the closing phase immediately and say goodbye.', true);
                transitionPhase('closing');
                closingTimerRef.current = setTimeout(() => endCall(), 12000);
            }

            if (phaseRef.current === 'interview') {
                const topicElapsed = Date.now() - topicStartTimeRef.current;
                if (topicElapsed >= TOPIC_TIME_LIMIT_MS && !isBridging) {
                    topicStartTimeRef.current = Date.now();
                    const tid = addIntelLog('director', 'Topic time limit reached.');
                    // Don't forceResponse here, wait for next natural gap so it doesn't abruptly interrupt the user
                    injectSystemMessage(`SYSTEM DIRECTIVE: We have spent over 4 minutes on the topic "${currentTopicRef.current}". On your next turn, wrap up the current point and pivot the conversation to the next topic naturally.`, false);
                    updateIntelLog(tid, 'done', 'Time-box pivot injected ✓');
                }
            }
        }, 1000);
    }, [endCall, injectSystemMessage, transitionPhase, addIntelLog, updateIntelLog, isBridging]);


    // ─────────────────────────────────────────────────────────────────────────
    // 🧠 THE OBSERVER ENGINE (Split by Phase to Reduce Hallucinations)
    // ─────────────────────────────────────────────────────────────────────────

    const runObserverPipeline = useCallback(async () => {
        if (isObserverRunningRef.current || isEndingRef.current || phaseRef.current === 'connecting' || phaseRef.current === 'setup' || phaseRef.current === 'report') return;
        if (userTurnCountRef.current <= observerRunTurnRef.current) return;

        isObserverRunningRef.current = true;
        const currentPhase = phaseRef.current;
        const tid = addIntelLog('observer', `[${currentPhase.toUpperCase()}] Observer scanning transcript...`);

        try {
            const recentHistory = convHistoryRef.current.slice(-10).map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n');
            const topicElapsedSeconds = Math.floor((Date.now() - topicStartTimeRef.current) / 1000);

            let prompt = '';
            let systemRole = 'You are a silent observer extracting intent from conversation logs.';

            // ── PHASE: GREETING & WARMUP ──
            if (currentPhase === 'greeting' || currentPhase === 'warmup') {
                prompt = `Analyze this recent transcript snippet for the ${currentPhase.toUpperCase()} phase.
[STATE]
Warmup Qs Completed: ${warmupCount} / ${WARMUP_QUESTIONS_REQUIRED}

Transcript:
${recentHistory}

Task: Return a JSON object matching this schema:
{
  "is_filler_pause": boolean, // TRUE if the AI's last message was a "Clutch Pause" (e.g. "Let me pull up your file").
  "is_substantive_answer": boolean, // TRUE if the candidate provided ANY answer to a warmup question.
  "answer_summary": "string", // Summarize the answer in 20 words.
  "needs_cv_lookup": boolean, // TRUE if the AI paused to check notes OR user mentions a specific background detail.
  "cv_topic": "string", // Specific project or experience mentioned.
  "suggested_phase_advance": "none" | "warmup" | "interview", // CRITICAL: Suggest "interview" if Warmup Qs >= 3.
  "ai_rambling": boolean, // TRUE if AI's last message was too long.
  "candidate_struggling": boolean, // TRUE if candidate uses many fillers or asks for help.
  "red_flag_detected": "string", // Detail any concerning attitude.
  "requested_pause_seconds": number // If user asks to hold on, time in seconds. Else 0.
}`;
            }
            // ── PHASE: INTERVIEW ──
            else if (currentPhase === 'interview') {
                prompt = `Analyze this recent transcript snippet for the INTERVIEW phase.
[STATE]
Topic: ${currentTopicRef.current}
Scored Technical Answers: ${scoresRef.current.length} / ${numQuestionsRef.current}
Time on Topic: ${topicElapsedSeconds}s / ${TOPIC_TIME_LIMIT_MS / 1000}s max
Job Details: ${jdTextRef.current.slice(0, 300)}

Transcript:
${recentHistory}

Task: Return a JSON object matching this schema:
{
  "is_filler_pause": boolean, // TRUE if the AI's last message was a "Clutch Pause" (e.g. "Let me pull up your file").
  "is_substantive_answer": boolean, // TRUE if candidate provided ANY answer to a technical question.
  "should_score_answer": boolean, // TRUE if answer should be evaluated (includes weak answers like "I don't know"). FALSE for pure filler/meta-talk.
  "answer_summary": "string", // Summarize the answer in 20 words.
  "needs_cv_lookup": boolean, // TRUE if the AI paused OR user references their background requiring verification.
  "cv_topic": "string", // Specific project or experience mentioned.
  "topic_exhausted": boolean, // TRUE if candidate asks to move on or topic has been covered for over 4 mins.
  "suggested_phase_advance": "none" | "closing", // Suggest "closing" if Scored Technical Answers >= ${numQuestionsRef.current}.
  "ai_rambling": boolean,
  "ai_hallucination_or_tone_issue": "string", // Detail if AI hallucinated facts or sounded robotic.
  "candidate_struggling": boolean,
  "red_flag_detected": "string", // Detail any concerning technical answer.
  "callback_opportunity": "string", // Detail past context to seamlessly bring up.
  "requested_pause_seconds": number,
  "is_complex_question": boolean // TRUE if AI just asked a highly technical question requiring thought.
}`;
            }
            // ── PHASE: CLOSING ──
            else if (currentPhase === 'closing') {
                prompt = `Analyze this recent transcript snippet for the CLOSING phase.
Transcript:
${recentHistory}

Task: Return a JSON object matching this schema:
{
  "is_filler_pause": boolean, 
  "candidate_has_final_question": boolean, // TRUE if the candidate asks a final question before leaving.
  "answer_summary": "string", // Summarize their final question/response.
  "suggested_phase_advance": "none" | "report", // Suggest "report" to end the call once goodbyes are exchanged.
  "ai_rambling": boolean
}`;
            }

            const raw = await callMini(prompt, systemRole, usageRef, true);

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

            // Merge with base defaults to ensure the director logic doesn't break
            const analysis: ObserverAnalysis = {
                is_filler_pause: false,
                is_substantive_answer: false,
                answer_summary: '',
                needs_cv_lookup: false,
                cv_topic: '',
                topic_exhausted: false,
                suggested_phase_advance: 'none',
                should_score_answer: false,
                ai_rambling: false,
                ai_hallucination_or_tone_issue: '',
                candidate_struggling: false,
                red_flag_detected: '',
                callback_opportunity: '',
                requested_pause_seconds: 0,
                is_complex_question: false,
                candidate_has_final_question: false,
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
            } else if (analysis.is_complex_question) {
                currentSilenceMsRef.current = SILENCE_COMPLEX_MS;
                startSilenceTimer(currentSilenceMsRef.current);
            } else {
                if (currentSilenceMsRef.current !== SILENCE_BASE_MS) {
                    currentSilenceMsRef.current = SILENCE_BASE_MS;
                }
            }

            // ── DIRECTOR BEHAVIORS (COLLISION PREVENTION LOGIC) ──
            let injectedDirector = false;

            if (analysis.red_flag_detected) {
                const d_tid = addIntelLog('director', `Red Flag: ${analysis.red_flag_detected}`);
                injectSystemMessage(`SYSTEM DIRECTIVE: RED FLAG DETECTED: ${analysis.red_flag_detected}. For your next turn, abandon the standard queue and ask ONLY ONE question probing this specific concern. Do not ask anything else.`, false);
                updateIntelLog(d_tid, 'done', 'Injected red flag pivot ✓');
                injectedDirector = true;
            } else if (analysis.candidate_struggling) {
                const d_tid = addIntelLog('director', 'Detected candidate struggle.');
                injectSystemMessage("SYSTEM DIRECTIVE: The candidate is struggling. For your next turn, ONLY offer a helpful hint or simplify your previous question. Do NOT ask a new question.", false);
                updateIntelLog(d_tid, 'done', 'Injected help prompt ✓');
                injectedDirector = true;
            } else if (analysis.ai_hallucination_or_tone_issue) {
                injectSystemMessage(`SYSTEM DIRECTIVE: Correction needed: ${analysis.ai_hallucination_or_tone_issue}. Adjust your tone to be professional and neutral, and correct any factual errors seamlessly.`, false);
                injectedDirector = true;
            } else if (analysis.ai_rambling) {
                injectSystemMessage("SYSTEM DIRECTIVE: You are talking too much. Limit your next response strictly to 15 words or less.", false);
                injectedDirector = true;
            } else if (analysis.callback_opportunity) {
                injectSystemMessage(`SYSTEM DIRECTIVE: If appropriate, tie your next question into this past context: ${analysis.callback_opportunity}`, false);
                injectedDirector = true;
            }

            // ── 1. Phase Advances ──
            if (analysis.suggested_phase_advance !== 'none' && analysis.suggested_phase_advance !== phaseRef.current) {
                const target = analysis.suggested_phase_advance;

                if (target === 'report') {
                    endCall();
                    return;
                }

                if (target === 'closing') {
                    const d_tid = addIntelLog('director', 'Limit reached. Pivoting to closing phase...');
                    injectSystemMessage("SYSTEM DIRECTIVE: Interview limit reached. Wrap up the conversation decisively but warmly. Do not ask any more technical questions. Move to the closing phase now.", false);
                    transitionPhase('closing');
                    closingTimeLeftRef.current = 12;
                    closingTimerRef.current = setTimeout(() => endCall(), 12000);
                    updateIntelLog(d_tid, 'done', 'Injected closing pivot ✓');
                    return;
                }

                if (target === 'warmup' && phaseRef.current === 'greeting') {
                    if (greetingTimeoutRef.current) clearTimeout(greetingTimeoutRef.current);
                    transitionPhase('warmup');
                    const firstWQ = warmupQueueRef.current[0] || "What have you been up to lately outside of work?";
                    warmupQIndexRef.current = 1;
                    topicStartTimeRef.current = Date.now();
                    injectSystemMessage(`SYSTEM DIRECTIVE: Transition to warmup naturally. You can use this question: "${firstWQ}"`, false);
                    return;
                } else if (target === 'interview' && (phaseRef.current === 'warmup' || phaseRef.current === 'greeting')) {
                    if (greetingTimeoutRef.current) clearTimeout(greetingTimeoutRef.current);
                    setQuestionCount(0);
                    transitionPhase('interview');
                    startInterviewTimer();
                    generateInterviewStrategy();
                    return;
                }
            }

            // ── 2. The "Clutch" CV Lookup & Un-Stick ──
            if (analysis.needs_cv_lookup && analysis.cv_topic) {
                handleCvLookup(analysis.cv_topic, analysis.is_filler_pause);
            } else if (analysis.is_filler_pause) {
                injectSystemMessage(`SYSTEM DIRECTIVE: You paused to check your notes, but no external lookup is needed right now. Simply resume the conversation naturally based on the candidate's last message.`, true);
            }

            // ── 3. Topic Exhaustion (Bridge) ──
            if (analysis.topic_exhausted && phaseRef.current === 'interview' && !injectedDirector) {
                handleTopicExhausted(currentTopicRef.current);
            }

            // ── 4. Warmup turns / Answer Scoring ──
            const isWarmupAnswer = phaseRef.current === 'warmup' && (analysis.is_substantive_answer || analysis.answer_summary.length > 5);

            if (isWarmupAnswer) {
                const newCount = warmupCountRef.current + 1;
                warmupCountRef.current = newCount;
                setWarmupCount(newCount);
                if (newCount < WARMUP_QUESTIONS_REQUIRED) {
                    const nextQ = warmupQueueRef.current[warmupQIndexRef.current] || '';
                    warmupQIndexRef.current += 1;
                    if (nextQ && !injectedDirector) {
                        injectSystemMessage(`SYSTEM DIRECTIVE: Acknowledge their answer briefly, then ask ONLY this next warmup question: "${nextQ}". Do not ask any other questions.`, false);
                    }
                } else if (newCount < WARMUP_QUESTIONS_HARD_LIMIT) {
                    if (!injectedDirector) {
                        injectSystemMessage(`SYSTEM DIRECTIVE: Warmup target reached (Question ${newCount}). For your next turn, wrap up the current personal topic and PIVOT strictly to the technical interview questions. Do not ask more personal questions.`, false);
                    }
                } else {
                    const t_tid = addIntelLog('director', 'Warmup hard limit (6) reached. Auto-advancing...');
                    setQuestionCount(0);
                    transitionPhase('interview');
                    startInterviewTimer();
                    generateInterviewStrategy();
                    updateIntelLog(t_tid, 'done', 'Transitioned to Interview ✓');
                    return;
                }
            } else if (analysis.should_score_answer && analysis.answer_summary && phaseRef.current === 'interview') {
                handleScoreAnswer(analysis.answer_summary, injectedDirector);
            }

        } catch (e) {
            console.error('[Observer] pipeline error:', e);
            updateIntelLog(tid, 'error', 'Observer analysis failed');
        } finally {
            isObserverRunningRef.current = false;
        }
    }, [addIntelLog, updateIntelLog, injectSystemMessage, transitionPhase, startInterviewTimer, endCall, startSilenceTimer, warmupCount]);


    // ─────────────────────────────────────────────────────────────────────────
    // Intelligence Functions (Triggered by Observer)
    // ─────────────────────────────────────────────────────────────────────────

    const handleCvLookup = async (topic: string, isPaused: boolean) => {
        setIsCvLooking(true);
        const tid = addIntelLog('cv', `Analyzing CV for "${topic}"...`);
        try {
            const result = await callMini(
                `FULL CV:\n${cvTextRef.current}\n\nThe interviewer needs info about: "${topic}". \nIf the topic is "General Summary" or similar, provide a 3-sentence summary of the candidate's current role, total experience, and top skills.\nOtherwise, extract specific details about the requested topic. If completely missing, say "Not mentioned in the CV."`,
                'CV lookup tool. Factual, brief, no commentary.',
                usageRef
            );

            injectSystemMessage(`SYSTEM DATA - CV LOOKUP for "${topic}": ${result}. Use this information seamlessly to reply to the candidate.`, isPaused);
            updateIntelLog(tid, 'done', `CV lookup: "${topic}" ✓`);
        } catch {
            injectSystemMessage('SYSTEM DIRECTIVE: Resume conversation naturally. Acknowledge the user but transition smoothly to the next question.', isPaused);
            updateIntelLog(tid, 'error', 'CV lookup failed');
        } finally {
            setIsCvLooking(false);
        }
    };

    const [queuedCvProjects, setQueuedCvProjects] = useState<string[]>([]);

    const handleScoreAnswer = async (answerSummary: string, suppressInjection: boolean = false) => {
        const tid = addIntelLog('score', `Sub-Observer scoring answer...`);
        try {
            // 1. Separate Lightweight Model for Scoring (Sub-Observer)
            const scoringPrompt = `You are a specialized Scoring Sub-Observer. Evaluate the candidate's technical answer.
Question: "${lastAiQuestionRef.current}"
Answer: "${answerSummary}"

SCORING RULES:
1. If the candidate says "I don't know", "I'm not sure", or provides no technical information, score it 1-2/10.
2. If they provide a partially correct but weak answer (like the one above), score it 3-5/10.
3. Only give 8-10/10 for deep, insightful, or expert-level answers.

Return JSON only:
{
  "score": <1-10>,
  "confidence": "<high|medium|low>",
  "grammar": "<good|average|poor>",
  "clarity": "<good|average|poor>",
  "depth": "<shallow|adequate|deep>"
}`;

            // 2. Follow-up & Feedback Model (Director)
            const followUpPrompt = `Interview context:
Question asked: "${lastAiQuestionRef.current}"
Candidate's answer summary: "${answerSummary}"
Topic: ${currentTopicRef.current}
JD: ${jdTextRef.current.slice(0, 400)}

Return JSON only:
{
  "feedback": "<one sentence for report>",
  "tags": ["<tag1>", "<tag2>"],
  "suggested_followup": "<specific follow-up question referencing what they said, max 25 words>"
}`;

            const cvDeepDivePrompt = `You are a specialized CV-Technical Sub-Observer.
Candidate's CV:
${cvTextRef.current.slice(0, 4000)}

Current technical answer: "${answerSummary}"
Topic: ${currentTopicRef.current}

Identify ONE specific project or experience from the CV that relates to this answer. 
Generate ONE deep-dive follow-up question that connects their answer to that CV project. 
Example: "You mentioned React hooks—how did you apply that when you were building the [Project Name] mentioned in your CV?"

Return JSON only:
{
  "project_reference": "<project name>",
  "cv_followup": "<follow-up question connecting to CV experience>"
}`;

            setIsCvAnalyzing(true);
            const [scoreRaw, followUpRaw, cvDeepDiveRaw] = await Promise.all([
                callMini(scoringPrompt, 'Scoring Sub-Observer. Return valid JSON only.', usageRef, true),
                callMini(followUpPrompt, 'Follow-up generator. Return valid JSON only.', usageRef, true),
                callMini(cvDeepDivePrompt, 'CV-Deep-Dive Sub-Observer. Return valid JSON only.', usageRef, true)
            ]);
            setIsCvAnalyzing(false);

            let parsedScore = { score: 5, confidence: 'medium', grammar: 'average', clarity: 'average', depth: 'adequate' };
            try { parsedScore = JSON.parse(scoreRaw.replace(/```json|```/g, '').trim()); } catch (e) { console.error("Scoring Parse Error"); }

            let parsedFollowUp = { feedback: 'Answer recorded.', tags: [], suggested_followup: '' };
            try { parsedFollowUp = JSON.parse(followUpRaw.replace(/```json|```/g, '').trim()); } catch (e) { console.error("FollowUp Parse Error"); }

            let parsedCvDeepDive = { project_reference: '', cv_followup: '' };
            try { parsedCvDeepDive = JSON.parse(cvDeepDiveRaw.replace(/```json|```/g, '').trim()); } catch (e) { console.error("CV Deep Dive Parse Error"); }

            const finalScore = Math.min(10, Math.max(1, parsedScore.score || 5));

            const score: AnswerScore = {
                question: lastAiQuestionRef.current,
                answerSummary: answerSummary.slice(0, 200),
                score: finalScore,
                feedback: parsedFollowUp.feedback || '',
                tags: parsedFollowUp.tags || [],
                topic: currentTopicRef.current,
                depth: topicDepthMapRef.current.get(currentTopicRef.current)?.level || 1,
                confidence: parsedScore.confidence || 'medium',
                grammar: parsedScore.grammar || 'average',
                clarity: parsedScore.clarity || 'average',
                depthStr: parsedScore.depth || 'adequate',
            };

            scoresRef.current = [...scoresRef.current, score];
            setScores([...scoresRef.current]);
            updateIntelLog(tid, 'done', `Scored: ${finalScore}/10 ✓`);

            const depthInfo = topicDepthMapRef.current.get(currentTopicRef.current);
            const ansCount = (depthInfo?.answerCount || 0) + 1;
            let newLevel = depthInfo?.level || 1;

            // ── ADAPTIVE DIFFICULTY LOGIC (Guarded against Director interventions) ──
            if (!suppressInjection) {
                if (finalScore <= 4) {
                    newLevel = Math.max(1, newLevel - 1);
                    injectSystemMessage(`SYSTEM DIRECTIVE: The candidate struggled with that concept (Score ${finalScore}/10). Downgrade difficulty to Level ${newLevel} for your next turn. Keep your next question foundational.`, false);
                } else if (finalScore >= 8) {
                    newLevel = Math.min(3, newLevel + 1);
                    injectSystemMessage(`SYSTEM DIRECTIVE: The candidate crushed that concept (Score ${finalScore}/10). Increase difficulty to Level ${newLevel} for your next turn. Move to a harder edge-case or advanced challenge.`, false);
                } else {
                    // If the balance is good, just update the notes for future reference
                    if (parsedFollowUp.suggested_followup) {
                        // "KEEP IT FOR FUTURE DONT FIRE IMMEDIATELY"
                        const topicInfo = topicDepthMapRef.current.get(currentTopicRef.current);
                        if (topicInfo) {
                            topicInfo.questions.push(parsedFollowUp.suggested_followup);
                            addIntelLog('notes', `Queued follow-up: "${parsedFollowUp.suggested_followup.slice(0, 30)}..."`);

                            if (parsedScore.depth === 'shallow' && ansCount < 3) {
                                injectSystemMessage(`SYSTEM NOTE: The candidate's answer was surface-level. If you need a follow-up later, consider probing deeper into: "${parsedFollowUp.suggested_followup}".`, false);
                            }
                        }
                    }

                    if (parsedCvDeepDive.cv_followup) {
                        const topicInfo = topicDepthMapRef.current.get(currentTopicRef.current);
                        if (topicInfo) {
                            topicInfo.questions.push(parsedCvDeepDive.cv_followup);
                            setQueuedCvProjects(prev => [...new Set([...prev, parsedCvDeepDive.project_reference])]);
                            addIntelLog('cv', `Queued CV Follow-up: "${parsedCvDeepDive.project_reference}" ✓`);
                            injectSystemMessage(`SYSTEM NOTE (BACKGROUND): The candidate's CV mentions work on "${parsedCvDeepDive.project_reference}". Keep this in mind as a potential topic to explore naturally later: "${parsedCvDeepDive.cv_followup}"`, false);
                        }
                    }
                }
            } else {
                if (finalScore <= 4) newLevel = Math.max(1, newLevel - 1);
                if (finalScore >= 8) newLevel = Math.min(3, newLevel + 1);
            }

            if (depthInfo) {
                topicDepthMapRef.current.set(currentTopicRef.current, { ...depthInfo, level: newLevel, answerCount: ansCount });
                if (newLevel !== currentDepth) {
                    addIntelLog('strategy', `Difficulty ${newLevel > currentDepth ? 'increased' : 'decreased'} to Level ${newLevel}`);
                }
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
                injectSystemMessage('SYSTEM DIRECTIVE: All planned topics are covered. Ask one final wrap-up question.', false);
                setIsBridging(false);
                updateIntelLog(tid, 'done', 'All topics exhausted ✓');
                return;
            }

            currentTopicRef.current = nextTopic;
            setCurrentTopicDisplay(nextTopic);
            setCurrentDepth(1);
            topicStartTimeRef.current = Date.now();
            setBridgeCount(p => p + 1);

            topicDepthMapRef.current.set(nextTopic, { topic: nextTopic, level: 1, answerCount: 0, questions: strategy?.questionQueue[nextTopic] || [], currentQIndex: 0 });

            injectSystemMessage(`SYSTEM DIRECTIVE: Topic "${exhaustedTopic}" is complete. Transition to a new topic: "${nextTopic}". Ask ONLY this question: "${nextQ}". Do not add any other questions.`, false);
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
                `JD Requirements:\n${jdTextRef.current.slice(0, 600)}\n\nTopics covered: ${topicsCoveredRef.current.join(', ')}\nScored answers: ${scoresRef.current.map(s => s.topic).join(', ')}\n\nWhat important JD requirement has NOT been probed yet? Return ONE specific gap area in 10 words or less. If no gap, return "none".`,
                'Gap detection engine. Return only the gap area name or "none". No preamble.',
                usageRef
            );
            if (gap && gap !== 'none' && gap.length < 80) {
                setDetectedGap(gap);
                const gapQ = await callMini(
                    `Gap area not yet covered: "${gap}"\nGenerate ONE targeted question to probe this gap. Max 25 words.`,
                    'Question generator. Return only the question.',
                    usageRef
                );
                if (gapQ) {
                    injectSystemMessage(`SYSTEM DIRECTIVE: JD Gap Identified - "${gap}". At your next turn, probe this by asking ONLY this question: "${gapQ}". Do not ask multiple questions.`, false);
                    updateIntelLog(tid, 'done', `Identified gap: "${gap}" ✓`);
                }
            } else {
                updateIntelLog(tid, 'done', 'JD coverage complete ✓');
            }
        } catch (e) {
            console.error('[Gap] failed:', e);
        }
    };

    const generateInterviewStrategy = async () => {
        setIsThinking(true);
        const tid = addIntelLog('strategy', 'Generating interview strategy...');
        try {
            const raw = await callMini(
                `CV Summary: ${cvSummaryRef.current}\nJD: ${jdTextRef.current.slice(0, 800)}\n\nGenerate interview strategy. Return JSON strictly matching:\n{\n  "topics": ["<topic1>", "<topic2>", "<topic3>", "<topic4>", "<topic5>"],\n  "questionQueue": {\n    "<topic1>": ["<surface q>", "<technical q>", "<deep q>"],\n    "<topic2>": ["<surface q>", "<technical q>", "<deep q>"],\n    "<topic3>": ["<surface q>", "<technical q>", "<deep q>"],\n    "<topic4>": ["<surface q>", "<technical q>", "<deep q>"],\n    "<topic5>": ["<surface q>", "<technical q>", "<deep q>"]\n  },\n  "gapAreas": ["<gap>"]\n}`,
                'Interview strategy engine. Return valid JSON only.',
                usageRef,
                true
            );

            let strategy: InterviewStrategy;
            try { strategy = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
            catch { strategy = { topics: ['Technical Skills', 'Experience'], questionQueue: {}, gapAreas: [] }; }

            strategyRef.current = strategy;
            setStrategyTopics(strategy.topics);

            for (const topic of strategy.topics) {
                topicDepthMapRef.current.set(topic, { topic, level: 1, answerCount: 0, questions: strategy.questionQueue[topic] || [], currentQIndex: 0 });
            }

            const firstTopic = strategy.topics[0] || 'Technical Skills';
            const firstQ = strategy.questionQueue[firstTopic]?.[0] || '';

            currentTopicRef.current = firstTopic;
            setCurrentTopicDisplay(firstTopic);
            topicStartTimeRef.current = Date.now();

            injectSystemMessage(`SYSTEM DIRECTIVE: INTERVIEW STRATEGY BRIEFING. Topics to cover: ${strategy.topics.join(' → ')}. First topic is "${firstTopic}". Steer the conversation towards this topic. Example question: "${firstQ}"`, false);
            updateIntelLog(tid, 'done', 'Interview strategy ready ✓');

        } catch (e) {
            console.error('[Strategy] failed:', e);
        } finally { setIsThinking(false); }
    };

    const generateWarmupQuestions = async () => {
        try {
            const raw = await callMini(
                `CV Summary: ${cvSummaryRef.current.slice(0, 500)}\n\nGenerate 3 warm personal questions for the start of an interview. Light, conversational, contextual to their background. Return JSON array only: ["<q1>", "<q2>", "<q3>"]`,
                'Warmup question generator.', usageRef, true
            );
            let qs: string[] = [];
            try { qs = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { /* ignore */ }
            if (qs.length >= 3) { warmupQueueRef.current = qs; warmupQIndexRef.current = 0; }
        } catch { /* ignore */ }
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
                setActiveRtItems([...rtItemIdsRef.current]);
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
                clearSilenceTimer(); // USER started speaking, clear timer immediately
                if (greetingTimeoutRef.current) {
                    clearTimeout(greetingTimeoutRef.current);
                    greetingTimeoutRef.current = null;
                }
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
                        if (phaseRef.current === 'interview') {
                            setQuestionCount(p => p + 1);
                        }
                        setCurrentQ(transcript);
                    }
                }
                setCallStatus('Listening...');

                // AI finished speaking, start the default silence timer!
                startSilenceTimer();
                // Since the AI just finished, we allow the observer to see the complete turn.
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
                // Trigger Observer immediately so it can think while the AI is preparing its response
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
                    clearSilenceTimer(); // AI is speaking, clear timer
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
            } catch { /* ignore */ }
        } catch { setSetupErr('Failed to read file.'); setCvFileName(''); }
        setIsParsing(false);
    };

    const startCall = useCallback(async () => {
        if (isStartingRef.current || isCallActive) return;
        if (!cvText && !jdText) { setSetupErr('Please upload a CV or paste a Job Description.'); return; }
        isStartingRef.current = true;
        isEndingRef.current = false;

        setLogs([]); setScores([]); setTopicsCovered([]); setQuestionCount(0);
        setCurrentQ(''); setSmartNotes(''); setCvSummary(''); setWarmupCount(0);
        setBridgeCount(0); setIsBridging(false); setIsCvLooking(false); setIsThinking(false);
        setInterviewTimeLeft(INTERVIEW_DURATION_MS / 1000); setActiveRtItems([]);
        setCurrentTopicDisplay(''); setCurrentDepth(1); setDetectedGap(''); setStrategyTopics([]);
        setCallStatus('Connecting...');

        convHistoryRef.current = [];
        rtItemIdsRef.current = [];
        userTurnCountRef.current = 0;
        observerRunTurnRef.current = -1;
        isObserverRunningRef.current = false;
        answerCountRef.current = 0;
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
            pc.ontrack = e => { audioEl.srcObject = e.streams[0]; };

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
                        instructions: buildActorPrompt('greeting'),
                        input_audio_transcription: { model: 'whisper-1' },
                        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800 },
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

                    greetingTimeoutRef.current = setTimeout(() => {
                        if (phaseRef.current === 'greeting' && !isEndingRef.current) {
                            transitionPhase('warmup');
                            injectSystemMessage(`SYSTEM DIRECTIVE: Transition to warmup naturally. First question: "${warmupQueueRef.current[0] || 'How are you today?'}"`, true);
                        }
                    }, GREETING_AUTO_ADVANCE_MS);
                }, 200);
            };

            dc.onmessage = e => {
                try { handleRtEvent(JSON.parse(e.data as string)); } catch { /* ignore */ }
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
    }, [isCallActive, cvText, jdText, buildActorPrompt, sendRt, handleRtEvent, transitionPhase, clearSilenceTimer]);

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
    const timeLeftPct = (interviewTimeLeft / (INTERVIEW_DURATION_MS / 1000)) * 100;
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
        closing: 'Closing', report: 'Complete',
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
    html, body { background: var(--bg); color: var(--text); font-family: var(--sans); overflow-x: hidden; }
    ::-webkit-scrollbar { width: 3px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 3px; }

    .noise { position: fixed; inset: 0; pointer-events: none; opacity: .03;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      background-size: 180px; }

    .setup { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 28px; gap: 32px; }
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
    .tabs { display: flex; gap: 14px; border-bottom: 1px solid var(--line); }
    .tab { background: none; border: none; font-family: var(--mono); font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--text3); padding: 5px 0; cursor: pointer; }
    .tab.on { color: var(--blue); border-bottom: 1.5px solid var(--blue); }
    .tpl-list { display: flex; flex-direction: column; gap: 7px; max-height: 260px; overflow-y: auto; }
    .tpl { background: #040709; border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; cursor: pointer; text-align: left; }
    .tpl:hover { border-color: var(--blue); }
    .err { display: flex; align-items: center; gap: 8px; background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.25); border-radius: 9px; padding: 10px 14px; font-size: 12px; color: #f87171; width: 100%; max-width: 900px; }
    .start-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; max-width: 900px; padding: 17px; border-radius: 13px; background: linear-gradient(135deg,#1d4ed8,#4f46e5); border: none; cursor: pointer; color: white; font-family: var(--sans); font-size: 15px; font-weight: 700; transition: .25s; }
    .start-btn:disabled { opacity: .4; cursor: not-allowed; }
    .tags-row { display: flex; flex-wrap: wrap; gap: 7px; justify-content: center; max-width: 900px; }
    .feature-tag { font-family: var(--mono); font-size: 9px; background: rgba(255,255,255,.03); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; }

    .connecting { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .conn-inner { display: flex; flex-direction: column; align-items: center; gap: 18px; text-align: center; }
    .conn-ring { width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg,#1d4ed8,#4f46e5); display: flex; align-items: center; justify-content: center; animation: pulseRing 1.8s ease-in-out infinite; font-size: 28px; }
    @keyframes pulseRing { 0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,.5)} 50%{box-shadow:0 0 0 20px rgba(99,102,241,0)} }

    .live { display: grid; grid-template-columns: 290px 1fr 310px; min-height: 100vh; }
    @media(max-width:1100px) { .live { grid-template-columns: 270px 1fr; } .live-right { display: none; } }
    @media(max-width:720px) { .live { grid-template-columns: 1fr; } .live-center { display: none; } }
    .live-left { border-right: 1px solid var(--line); background: var(--bg2); display: flex; flex-direction: column; overflow-y: auto; }
    .live-center { display: flex; flex-direction: column; overflow: hidden; }
    .live-right { border-left: 1px solid var(--line); background: var(--bg2); overflow-y: auto; }

    .agent-top { padding: 22px 18px 18px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .avatar { width: 68px; height: 68px; border-radius: 50%; background: linear-gradient(135deg,#1a2b5e,#111e42); border: 2px solid var(--line2); display: flex; align-items: center; justify-content: center; font-size: 28px; transition: .4s; }
    .avatar.speaking { box-shadow: 0 0 0 4px rgba(59,123,255,.3), 0 0 20px rgba(59,123,255,.15); }
    .avatar.bridging { box-shadow: 0 0 0 4px rgba(99,102,241,.3), 0 0 20px rgba(99,102,241,.15); }
    .agent-name { font-family: var(--serif); font-size: 22px; font-weight: 700; }
    .status-pill { display: flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 100px; font-family: var(--mono); font-size: 10px; }
    .sdot { width: 6px; height: 6px; border-radius: 50%; }
    .wave { display: flex; align-items: flex-end; gap: 2px; height: 28px; }
    .wbar { width: 3px; border-radius: 2px; transition: height .1s; }

    .tier-wrap { margin: 10px; border: 1px solid var(--line); border-radius: 11px; overflow: hidden; }
    .tier-hd { padding: 8px 12px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
    .tier-row { padding: 9px 12px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--line); transition: .3s; }
    .tier-row.on { background: rgba(59,123,255,.04); }
    .tdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

    .strategy-wrap { margin: 10px; border: 1px solid rgba(56,189,248,.2); background: rgba(56,189,248,.03); border-radius: 11px; padding: 12px; }
    .strategy-topic { display: flex; align-items: center; gap: 7px; padding: 4px 0; }

    .score-wrap { margin: 10px; border: 1px solid var(--line); border-radius: 11px; padding: 13px; }
    .score-big { font-family: var(--serif); font-size: 34px; font-weight: 700; line-height: 1; }
    .sbar-row { display: flex; align-items: center; gap: 8px; }
    .sbar-bg { flex: 1; height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; }
    .sbar-fill { height: 100%; border-radius: 2px; transition: width .5s; }

    .controls { margin-top: auto; padding: 14px; border-top: 1px solid var(--line); display: flex; gap: 8px; }
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
    
    .intel-feed { margin: 10px; border: 1px solid var(--line); border-radius: 11px; overflow: hidden; background: rgba(255,255,255,.01); }
    .intel-hd { padding: 8px 12px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
    .intel-row { padding: 8px 12px; display: flex; align-items: flex-start; gap: 10px; border-bottom: 1px solid var(--line); }
    .intel-icon { width: 16px; height: 16px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; margin-top: 1px; }

    .score-card { margin: 10px; border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 7px; }
    .sc-q { font-size: 11px; color: var(--text2); }
    .sc-a { font-family: var(--mono); font-size: 10px; color: var(--text3); }
    
    .depth-wrap { margin: 10px; border: 1px solid var(--line); border-radius: 11px; padding: 12px; background: linear-gradient(135deg, rgba(56,189,248,0.05), transparent); border-left: 3px solid var(--cyan); }
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

    /* Report specifics omitted for brevity, identical to V3 structure */
    .report-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 28px; }
    .report { width: 100%; max-width: 860px; background: var(--bg2); border: 1px solid var(--line); border-radius: 20px; overflow: hidden; }
    .report-hero { padding: 40px; background: linear-gradient(135deg,#08101f,#110e2b); border-bottom: 1px solid var(--line); text-align: center; }
    .report-avg { font-family: var(--serif); font-size: 64px; font-weight: 700; }
    .report-stats { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; background: var(--line); }
    .rstat { background: var(--bg2); padding: 18px; }
    .rstat-val { font-family: var(--serif); font-size: 28px; font-weight: 700; }
    .rstat-lbl { font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--text3); }
    .answers-section { padding: 18px; display: flex; flex-direction: column; gap: 10px; max-height: 500px; overflow-y: auto; }
    .answer-item { border: 1px solid var(--line); border-radius: 10px; padding: 13px; display: flex; flex-direction: column; gap: 7px; }
    .restart-btn { background: linear-gradient(135deg,#1d4ed8,#4f46e5); color: white; padding: 13px 36px; border-radius: 10px; font-family: var(--sans); font-size: 14px; font-weight: 700; border: none; cursor: pointer; }
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
                    <div className="setup-eyebrow">Aria v4 · Split Observer Architecture</div>
                    <h1 className="setup-title">The smartest <em>Voice Pipe</em><br />in the world.</h1>
                    <p className="setup-sub">Zero RT tool hallucinations. Pure voice speed powered by silent background Observers.</p>
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
                        <div className="card-label">Job Description</div>
                        <textarea className="textarea" placeholder="Paste JD..." style={{ minHeight: 110 }} value={jdText} onChange={e => setJdText(e.target.value)} />
                        <input className="input" placeholder="Candidate Name (Optional)" value={candidateName} onChange={e => setCandidateName(e.target.value)} />

                        <div className="card-label" style={{ marginTop: 10 }}>Interview Length</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                            {[3, 5, 10, 15].map(n => (
                                <button
                                    key={n}
                                    onClick={() => setNumQuestions(n)}
                                    style={{
                                        flex: 1,
                                        padding: '8px 0',
                                        borderRadius: 8,
                                        background: numQuestions === n ? 'var(--blue)' : 'var(--bg3)',
                                        border: '1px solid ' + (numQuestions === n ? 'var(--blue)' : 'var(--line)'),
                                        color: numQuestions === n ? 'white' : 'var(--text2)',
                                        fontFamily: 'var(--mono)',
                                        fontSize: 11,
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        transition: '.2s'
                                    }}
                                >
                                    {n} Qs
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="tags-row fade">
                    <div className="feature-tag" style={{ color: '#60a5fa' }}>Zero RT Tool Definitions</div>
                    <div className="feature-tag" style={{ color: '#22c55e' }}>Phase-Split Observer Patterns</div>
                    <div className="feature-tag" style={{ color: '#c084fc' }}>Out-of-band Context Injection</div>
                    <div className="feature-tag" style={{ color: '#f59e0b' }}>The "Clutch" Pause Pattern</div>
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

    if (phase === 'report') return (
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
                        <div className="rstat"><div className="rstat-val">{fmtTime(duration)}</div><div className="rstat-lbl">Duration</div></div>
                        <div className="rstat"><div className="rstat-val">${totalCost.toFixed(4)}</div><div className="rstat-lbl">Est. Cost</div></div>
                    </div>
                    {scores.length > 0 && (
                        <div className="answers-section">
                            {scores.map((s, i) => (
                                <div className="answer-item" key={i}>
                                    <div style={{ fontSize: 12, color: 'var(--text2)' }}>Q: {s.question}</div>
                                    <div style={{ display: 'flex', gap: 5 }}>
                                        <ScoreBadge score={s.score} />
                                        {s.depth && <DepthBadge level={s.depth} />}
                                    </div>
                                    <div style={{ fontSize: 11 }}>{s.answerSummary}</div>

                                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
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
                    <div className="agent-top">
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
                                        <span>{(silenceTimeLeft / 1000).toFixed(1)}s</span>
                                    </div>
                                    <div style={{ height: 2, background: 'var(--line)', borderRadius: 1, overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%',
                                            background: silenceTimeLeft < 5000 ? 'var(--red)' : 'var(--blue)',
                                            width: `${(silenceTimeLeft / silenceDurationRef.current) * 100}%`,
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

                    <div className="tier-wrap">
                        <div className="tier-hd"><span style={{ fontSize: 9, color: 'var(--text3)' }}>ARCHITECTURE</span></div>
                        <div className={`tier-row${isSpeaking ? ' on' : ''}`}>
                            <div className="tdot" style={{ background: '#22c55e' }} />
                            <div style={{ flex: 1 }}><div style={{ fontSize: 11, fontWeight: 600 }}>The Actor (RT)</div><div style={{ fontSize: 9, color: 'var(--text3)' }}>Pure voice pipe, 0 tools</div></div>
                        </div>
                        <div className={`tier-row${isObserverRunningRef.current ? ' on' : ''}`}>
                            <div className="tdot" style={{ background: '#c084fc', boxShadow: isObserverRunningRef.current ? '0 0 8px #c084fc' : 'none' }} />
                            <div style={{ flex: 1 }}><div style={{ fontSize: 11, fontWeight: 600 }}>{phaseRef.current === 'interview' ? 'Interview Observer' : phaseRef.current === 'closing' ? 'Closing Observer' : 'Warmup Observer'}</div><div style={{ fontSize: 9, color: 'var(--text3)' }}>Phase-specific intent analysis</div></div>
                        </div>
                    </div>

                    {phase === 'interview' && (
                        <div className="depth-wrap fade">
                            <div className="depth-label">
                                <span style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 700, letterSpacing: '.05em' }}>TECHNICAL COMPLEXITY</span>
                                <span style={{ fontSize: 10, color: 'var(--cyan)', fontWeight: 800, fontFamily: 'var(--mono)' }}>LVL {currentDepth}</span>
                            </div>
                            <div className="depth-dots">
                                <div className={`depth-dot ${currentDepth >= 1 ? 'on' : ''}`} />
                                <div className={`depth-dot ${currentDepth >= 2 ? 'on' : ''}`} />
                                <div className={`depth-dot ${currentDepth >= 3 ? 'on' : ''}`} />
                            </div>
                            <div style={{ marginTop: 8, fontSize: 8, color: 'var(--text3)', fontFamily: 'var(--mono)', textTransform: 'uppercase' }}>
                                {currentDepth === 3 ? 'Deep Architecture Mode' : currentDepth === 2 ? 'Technical Implementation' : 'Foundational Concepts'}
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
                                    <span style={{ fontSize: 9, color: lastObserverAnalysis.suggested_phase_advance !== 'none' ? 'var(--green)' : 'var(--text3)' }}>
                                        {lastObserverAnalysis.suggested_phase_advance.toUpperCase()}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ fontSize: 9, color: 'var(--text3)' }}>TOPIC EXHAUSTED:</span>
                                    <span style={{ fontSize: 9, color: lastObserverAnalysis.topic_exhausted ? 'var(--amber)' : 'var(--text3)' }}>
                                        {lastObserverAnalysis.topic_exhausted ? 'YES' : 'NO'}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ fontSize: 9, color: 'var(--text3)' }}>SUBSTANTIVE ANSWER:</span>
                                    <span style={{ fontSize: 9, color: lastObserverAnalysis.is_substantive_answer ? 'var(--blue)' : 'var(--text3)' }}>
                                        {lastObserverAnalysis.is_substantive_answer ? 'YES' : 'NO'}
                                    </span>
                                </div>
                                {lastObserverAnalysis.answer_summary && (
                                    <div style={{ borderTop: '1px solid var(--violet)22', marginTop: 4, paddingTop: 6 }}>
                                        <div style={{ fontSize: 8, color: 'var(--text3)', marginBottom: 2 }}>SUMMARY:</div>
                                        <div style={{ fontSize: 10, color: 'var(--text2)', fontStyle: 'italic', lineHeight: 1.4 }}>"{lastObserverAnalysis.answer_summary}"</div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {queuedCvProjects.length > 0 && (
                        <div className="intel-feed" style={{ borderColor: 'var(--green)33', background: 'var(--green)04' }}>
                            <div className="intel-hd" style={{ borderBottomColor: 'var(--green)22' }}>
                                <span style={{ fontSize: 9, color: 'var(--green)', fontWeight: 700 }}>CV TECHNICAL PROFILE</span>
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
                                <span style={{ fontSize: 9, color: 'var(--blue)', fontWeight: 700 }}>SYSTEM DIRECTIVE INJECTED</span>
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
                            <div className="intel-hd"><span style={{ fontSize: 9, color: 'var(--text3)' }}>Observer Feed</span></div>
                            {intelLog.map((log) => (
                                <div key={log.id} className="intel-row">
                                    <div className="intel-icon" style={{ color: log.status === 'active' ? '#60a5fa' : '#94a3b8' }}>⚡</div>
                                    <div style={{ fontSize: 10, color: log.status === 'error' ? 'var(--red)' : 'var(--text2)' }}>{log.message}</div>
                                </div>
                            ))}
                        </div>
                    )}

                    <div style={{ flex: 1 }} />
                    <div className="controls">
                        <button className={`btn btn-mute${isMuted ? ' btn-muted' : ''}`} onClick={toggleMute}>{isMuted ? 'Unmute' : 'Mute'}</button>
                        <button className="btn btn-end" onClick={endCall}>End</button>
                    </div>
                </div>

                {/* CENTER PANEL */}
                <div className="live-center">
                    <div className="phase-strip">
                        <div className="phase-flow">
                            {(['greeting', 'warmup', 'interview', 'closing'] as AppPhase[]).map((p, i) => (
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

                    <div className="center-body">
                        {activeLogs.length === 0 ? <div style={{ textAlign: 'center', padding: 20, color: 'var(--text3)' }}>Waiting to begin...</div> :
                            activeLogs.map((log, i) => (
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