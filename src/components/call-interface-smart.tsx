'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { PhoneOff, Brain, Zap, Activity, DollarSign, X, Mic, MicOff, ArrowRight, ArrowDown, BookOpen, Loader2, Timer, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Agent = {
    id: string;
    name: string;
    systemInstruction: string;
    voiceId?: string | null;
};

export type SmartUsage = {
    textInput: number;
    audioInput: number;
    textOutput: number;
    audioOutput: number;
    escalationPromptTokens: number;
    escalationCompletionTokens: number;
    escalationMiniPromptTokens: number;
    escalationMiniCompletionTokens: number;
    escalationCount: number;
    interruptedEscalations: number;
    memoryTokens: number;
    filterPromptTokens: number;     // New
    filterCompletionTokens: number; // New
};

export type SmartCallSummary = {
    id: string;
    durationSeconds: number;
    usage: SmartUsage;
    cost: number;
    date: string;
};

type LogEntry = {
    id: string;
    role: 'user' | 'model';
    text: string;
    escalated?: boolean;
    interrupted?: boolean;
    pending?: boolean;
};

type EscalationState =
    | 'idle'
    | 'fetching'       // GPT-4o is thinking
    | 'interrupted'    // user spoke during fetch — we cancelled
    | 'delivering';    // mini is speaking the answer

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Realtime GPT-4o-mini pricing (per 1M tokens) - User provided
const RT_AUDIO_IN = 10.00;
const RT_AUDIO_OUT = 20.00;
const RT_TEXT_IN = 0.60;
const RT_TEXT_OUT = 2.40;
const RT_CACHED_IN = 0.30;

// Standard GPT-4o pricing (per 1M tokens) - User provided
const GPT4O_TEXT_IN = 2.50;
const GPT4O_TEXT_OUT = 10.00;

// Standard GPT-4o-mini pricing (per 1M tokens) - User provided
const MINI_TEXT_IN = 0.15;
const MINI_TEXT_OUT = 0.60;

// Standard Mode Reference Pricing (GPT-4o Realtime Non-Mini) - User provided
const STD_RT_AUDIO_IN = 40.00;
const STD_RT_AUDIO_OUT = 80.00;
const STD_RT_TEXT_IN = 5.00;
const STD_RT_TEXT_OUT = 20.00;

const NODE_DESCRIPTIONS: Record<string, { title: string, text: string }> = {
    you: {
        title: "Human Voice (You)",
        text: "Your live audio is captured and streamed directly to the AI for instant understanding."
    },
    core: {
        title: "Daily Chat",
        text: "The main engine that manages the live conversation, generates natural voice, and handles standard logic."
    },

    basic: {
        title: "Standard Brain (Fast)",
        text: "A highly efficient brain used for general conversation and basic reasoning to keep the call responsive."
    },
    complex: {
        title: "Advanced Brain (Expert)",
        text: "The expert reasoning model activated for deep analysis, complex math, or high-stakes logic."
    },
    filter: {
        title: "Response Filter (Safe-Voice)",
        text: "A real-time sanitization layer that strips out markdown, math formulas, and long-windedness for natural speech."
    },
    memory: {
        title: "Learned Knowledge base",
        text: "The agent's memory system where it stores and recalls specific facts mentioned during the call."
    }
};

// How long to wait before giving up on escalation and letting mini answer
const ESCALATION_TIMEOUT_MS = 8_000;

// Max retries for escalation fetch
const MAX_ESCALATION_RETRIES = 2;

// How many turns of history to send for escalation context
const HISTORY_CONTEXT_TURNS = 12;

// Scoring threshold — queries scoring below this are answered by mini directly
const ESCALATION_SCORE_THRESHOLD = 2;

// Weighted keyword map — higher weight = stronger signal
// --- CLIENT-SIDE TRIGGERS REMOVED: Now trusting the AI model to escalate via tools ---

function isFillerPhrase(text: string): boolean {
    const lower = text.toLowerCase().trim();
    // Match common fillers the model uses before tool calls
    return lower.includes('let me think') ||
        lower.includes('give me a sec') ||
        lower.includes('one moment') ||
        lower.includes('let me work through that') ||
        lower.includes('let me make sure i get this right') ||
        lower.includes('one sec') ||
        lower.includes('give me a moment') ||
        lower.includes('let me look into that') ||
        lower.includes('let me pull that together') ||
        lower.includes('tough one') ||
        lower.includes('actually figure that out') ||
        lower.includes('good question') ||
        lower.includes('hang on');
}

function randomFiller(): string {
    const fillers = [
        "Hmm, give me just a sec...",
        "Oh that's a good one — one moment...",
        "Let me think about that...",
        "Okay, give me a second...",
        "Right, let me work that out...",
        "Hang on, thinking...",
        "Ooh, let me actually figure that out properly...",
    ];
    return fillers[Math.floor(Math.random() * fillers.length)];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function CallInterfaceSmartV2({
    agent,
    onCallEnd,
}: {
    agent: Agent;
    onCallEnd?: (summary: SmartCallSummary) => void;
}) {
    // ── UI state ──────────────────────────────────────────────────────────
    const [isCallActive, setIsCallActive] = useState(false);
    const [isStarting, setIsStarting] = useState(false);
    const [status, setStatus] = useState<string>('Ready');
    const [escalState, setEscalState] = useState<EscalationState>('idle');
    const [escalTarget, setEscalTarget] = useState<'moderate' | 'complex' | null>(null);
    const [escalModel, setEscalModel] = useState<string | null>(null);
    const [isFilterActive, setIsFilterActive] = useState(false);
    const [escalCountMini, setEscalCountMini] = useState(0);
    const [escalCount4o, setEscalCount4o] = useState(0);
    const [interruptCount, setInterruptCount] = useState(0);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [duration, setDuration] = useState(0);
    const [liveCost, setLiveCost] = useState(0);
    const [showCost, setShowCost] = useState(false);
    const [micLevel, setMicLevel] = useState(0); // 0-100
    const [isMuted, setIsMuted] = useState(false);

    const [isSmartNotesOn, setIsSmartNotesOn] = useState(true);
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);
    const [memoryActivity, setMemoryActivity] = useState<'idle' | 'adding' | 'recalling'>('idle');
    const [smartNotes, setSmartNotes] = useState('');
    const [activeItemIds, setActiveItemIds] = useState<string[]>([]);
    const [idleSeconds, setIdleSeconds] = useState(0);
    const [showSavingsReport, setShowSavingsReport] = useState(false);


    // ── Refs: WebRTC ──────────────────────────────────────────────────────
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const dcRef = useRef<RTCDataChannel | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioElRef = useRef<HTMLAudioElement | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const rafRef = useRef<number | null>(null);
    const aiSilenceTimerRef = useRef<NodeJS.Timeout | null>(null);

    // ── Refs: control ────────────────────────────────────────────────────
    const startTimeRef = useRef<number | null>(null);
    const isCallEndingRef = useRef(false);
    const hasSavedRef = useRef(false);
    const isStartingRef = useRef(false);
    const abortControllerRef = useRef<AbortController | null>(null);

    // ── Refs: escalation state machine ───────────────────────────────────
    const escalStateRef = useRef<EscalationState>('idle');
    const escalAbortRef = useRef<AbortController | null>(null);
    // If user speaks while escalation is in-flight, we buffer their transcript here
    const pendingInterruptRef = useRef<string | null>(null);
    // The call_id for the in-flight tool call (needed to submit result)
    const pendingCallIdRef = useRef<string | null>(null);
    // Whether mini already said a filler phrase for this escalation
    const fillerSentRef = useRef(false);

    // ── Refs: conversation ───────────────────────────────────────────────
    const convHistoryRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);
    const lastUserTranscriptRef = useRef('');
    const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    // Set when user speaks DURING an escalation fetch — we queue instead of aborting
    const userSpokeWhileFetchingRef = useRef(false);

    const isSmartNotesOnRef = useRef(true);
    const smartNotesRef = useRef('');
    const lastMemoryToolRef = useRef<'check_memory' | null>(null);
    const turnCountRef = useRef(0);
    const isSummarizingRef = useRef(false);
    const convItemIdsRef = useRef<string[]>([]); // all Realtime item IDs in order
    const KEEP_ITEMS = 6; // how many recent items to keep after pruning
    const lastAudioTimeRef = useRef(Date.now());
    const isUserSpeakingRef = useRef(false);
    const isAISpeakingRef = useRef(false);
    const silenceLimitRef = useRef(15000); // Dynamic: 15s or 120s

    const resetSilenceTimer = useCallback(() => {
        lastAudioTimeRef.current = Date.now();
        setIdleSeconds(0);
        if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
        silenceTimeoutRef.current = setTimeout(() => {
            if (!isCallEndingRef.current && dcRef.current && dcRef.current.readyState === 'open') {
                dcRef.current.send(JSON.stringify({
                    type: 'response.create',
                    response: {
                        instructions: 'The user has been silent for a while. Casually and briefly ask if they are still there or if they need anything.',
                    },
                }));
            }
        }, silenceLimitRef.current);
    }, []);

    // ── Refs: usage ──────────────────────────────────────────────────────
    const usageRef = useRef<SmartUsage>({
        textInput: 0, audioInput: 0, textOutput: 0, audioOutput: 0,
        escalationPromptTokens: 0, escalationCompletionTokens: 0,
        escalationMiniPromptTokens: 0, escalationMiniCompletionTokens: 0,
        escalationCount: 0, interruptedEscalations: 0,
        memoryTokens: 0,
        filterPromptTokens: 0, filterCompletionTokens: 0,
    });

    // ─────────────────────────────────────────────────────────────────────
    // Helpers: state sync
    // ─────────────────────────────────────────────────────────────────────

    function buildSystemPrompt(): string {
        const memorySection = isSmartNotesOnRef.current
            ? `

SMART MEMORY (always active when enabled):
- You have a memory tool: check_memory — call this ONLY when the user asks you to recall something from earlier (e.g. "what did I say about...?", "do you remember...", "remind me of..."). Before calling, say a filler like "Let me check my notes..." or "One sec, let me think back...". Then speak ONLY the relevant fact from the result.
- NEVER mention memory, notes, or storage to the user. It is invisible.
- IDLE TIMER RULE (CRITICAL): If the user says ANYTHING like "wait", "hold on", "give me a minute", "brb", "one sec", "wait X minutes/seconds", you MUST immediately call set_idle_timer with the appropriate duration_seconds BEFORE saying anything else. Do not skip this. Pass the number of seconds (e.g. "wait 2 minutes" → duration_seconds: 120). Then confirm naturally: "Sure, take your time!"`
            : '';

        return `${agent.systemInstruction}

VOICE BEHAVIOR RULES:
- You are on a phone call. Be warm, natural, conversational.
- Keep casual answers SHORT (1-3 sentences max).
- CRITICAL TRIVIA RULE: You are a lightweight conversational agent. You DO NOT know math, complex logic, comparisons, or deep facts. For EVERYTHING except basic chit-chat or simple greetings, YOU MUST CALL the escalate_thinking tool. 
- If the user asks a question (like pros and cons, or math problems of any kind), DO NOT try to answer it yourself. You MUST use the escalate_thinking tool.
  1. BEFORE calling the tool, say ONE short natural filler — vary it every time. Examples: "Hmm, one sec...", "Oh let me think...", "Right, give me a moment...", "Okay hang on...", "Let me work that out..." — pick randomly, never repeat the same one twice in a row, never say "Certainly" or "Great question".
  2. Then call escalate_thinking IMMEDIATELY and SILENTLY. Do NOT speak the function name, parameters, JSON, or any code-like text.
  3. When the result comes back, speak ONLY that answer. Don't add your own reasoning on top.
- CRITICAL: You must NEVER speak, write, or output function names, parameters, JSON objects, or anything that looks like code or programming syntax. Tool calls happen invisibly — the user must never hear or see them.
- For extremely simple things — greetings, yes/no, the time, casual small talk — answer directly without the tool.
- If interrupted mid-sentence, stop and address what the user just said.
- Never mention tools, AI, or that you are processing. Just sound human and natural.${memorySection}`;
    }

    const setEscalStateSync = (s: EscalationState) => {
        escalStateRef.current = s;
        setEscalState(s);
    };

    const computeLiveCost = () => {
        const u = usageRef.current;
        return (
            (u.textInput * RT_TEXT_IN / 1_000_000) +
            (u.audioInput * RT_AUDIO_IN / 1_000_000) +
            (u.textOutput * RT_TEXT_OUT / 1_000_000) +
            (u.audioOutput * RT_AUDIO_OUT / 1_000_000) +
            (u.escalationPromptTokens * GPT4O_TEXT_IN / 1_000_000) +
            (u.escalationCompletionTokens * GPT4O_TEXT_OUT / 1_000_000) +
            (u.escalationMiniPromptTokens * MINI_TEXT_IN / 1_000_000) +
            (u.escalationMiniCompletionTokens * MINI_TEXT_OUT / 1_000_000) +
            (u.memoryTokens * MINI_TEXT_OUT / 1_000_000) + // Use Mini Out for memory
            (u.filterPromptTokens * MINI_TEXT_IN / 1_000_000) +
            (u.filterCompletionTokens * MINI_TEXT_OUT / 1_000_000)
        );
    };

    // ─────────────────────────────────────────────────────────────────────
    // Timer
    // ─────────────────────────────────────────────────────────────────────

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isCallActive) {
            setDuration(0);
            interval = setInterval(() => {
                setDuration(p => p + 1);
                setLiveCost(computeLiveCost());

                const isAnyActive = isUserSpeakingRef.current ||
                    isAISpeakingRef.current ||
                    escalStateRef.current !== 'idle';

                if (isAnyActive) {
                    lastAudioTimeRef.current = Date.now();
                    setIdleSeconds(0);
                } else {
                    setIdleSeconds(Math.max(0, Math.floor((Date.now() - lastAudioTimeRef.current) / 1000)));
                }
            }, 1000);
        } else {
            setDuration(0);
        }
        return () => clearInterval(interval);
    }, [isCallActive]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (isStartingRef.current) abortControllerRef.current?.abort();
            endCall();
        };
    }, []);



    // ─────────────────────────────────────────────────────────────────────
    // Tool definition
    // ─────────────────────────────────────────────────────────────────────

    const timeTool = {
        type: 'function',
        name: 'get_current_time',
        description: 'Get the current local time to help the user schedule or know the time.',
        parameters: { type: 'object', properties: {} },
    };

    const weatherTool = {
        type: 'function',
        name: 'check_weather',
        description: 'Check the weather for a specific location.',
        parameters: {
            type: 'object',
            properties: {
                location: { type: 'string', description: 'The city or location' }
            },
            required: ['location'],
        },
    };

    const escalateTool = {
        type: 'function',
        name: 'escalate_thinking',
        description: 'Use for ANY question that needs real reasoning — math, analysis, comparisons, advice, decisions, opinions, complex memory questions, tradeoffs, recommendations, or anything that requires more than a simple factual reply. When in doubt, escalate.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: "The user's full question or request, including any relevant context",
                },
                complexity: {
                    type: 'string',
                    enum: ['moderate', 'complex'],
                    description: 'moderate = math, basic advice, simple comparisons. complex = multi-step reasoning, deep analysis, life decisions, nuanced tradeoffs, anything involving stored memory context.',
                },
            },
            required: ['query', 'complexity'],
        },
    };

    const appendMemoryTool = {
        type: 'function',
        name: 'append_to_memory',
        description: 'Silently save an important fact the user mentioned (name, preference, number, decision). Call this quietly without telling the user.',
        parameters: {
            type: 'object',
            properties: {
                note: {
                    type: 'string',
                    description: 'The concise fact to remember, e.g. "User name is Alex" or "Budget is $500"',
                },
            },
            required: ['note'],
        },
    };

    const checkMemoryTool = {
        type: 'function',
        name: 'check_memory',
        description: 'MANDATORY: Call this immediately whenever the user asks what you remember, what they said, their name, preferences, or anything from earlier in the conversation. You MUST call this tool — never answer from memory directly.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'What the user is asking you to recall',
                },
            },
            required: ['query'],
        },
    };

    const setIdleTimerTool = {
        type: 'function',
        name: 'set_idle_timer',
        description: 'Set an idle timer when the user asks you to wait or hold on. This prevents the call from timing out.',
        parameters: {
            type: 'object',
            properties: {
                duration_seconds: {
                    type: 'number',
                    description: 'Number of seconds to wait.',
                },
            },
            required: ['duration_seconds'],
        },
    };

    // ─────────────────────────────────────────────────────────────────────
    // Start call
    // ─────────────────────────────────────────────────────────────────────

    const startCall = async () => {
        if (isStartingRef.current || isStarting || isCallActive) return;

        isStartingRef.current = true;
        setIsStarting(true);
        isCallEndingRef.current = false;
        hasSavedRef.current = false;
        setLogs([]);
        setEscalCountMini(0);
        setEscalCount4o(0);
        setInterruptCount(0);
        setLiveCost(0);
        convHistoryRef.current = [];
        pendingInterruptRef.current = null;
        pendingCallIdRef.current = null;
        fillerSentRef.current = false;
        setEscalStateSync('idle');
        setEscalTarget(null);
        setEscalModel(null);
        setIsFilterActive(false);
        usageRef.current = {
            textInput: 0, audioInput: 0, textOutput: 0, audioOutput: 0,
            escalationPromptTokens: 0, escalationCompletionTokens: 0,
            escalationMiniPromptTokens: 0, escalationMiniCompletionTokens: 0,
            escalationCount: 0, interruptedEscalations: 0,
            memoryTokens: 0,
            filterPromptTokens: 0, filterCompletionTokens: 0,
        };
        smartNotesRef.current = '';
        setSmartNotes('');
        setMemoryActivity('idle');
        lastMemoryToolRef.current = null;
        turnCountRef.current = 0;
        isSummarizingRef.current = false;
        convItemIdsRef.current = [];
        setActiveItemIds([]);
        lastAudioTimeRef.current = Date.now();
        isUserSpeakingRef.current = false;
        setIsMuted(false);
        setIdleSeconds(0);
        startTimeRef.current = Date.now();

        abortControllerRef.current = new AbortController();
        const { signal } = abortControllerRef.current;

        try {
            setStatus('Connecting...');

            // 1. Ephemeral token
            const tokenRes = await fetch('/ai-interview/api/realtime-token', {
                method: 'POST',
                signal,
                body: JSON.stringify({ voice: agent.voiceId || 'alloy' }),
                headers: { 'Content-Type': 'application/json' },
            });
            if (signal.aborted) throw new Error('aborted');
            const tokenData = await tokenRes.json();
            if (tokenData.error) throw new Error(tokenData.error);
            const KEY = tokenData.client_secret.value;

            // 2. PeerConnection
            const pc = new RTCPeerConnection();
            pcRef.current = pc;

            const audioEl = document.createElement('audio');
            audioEl.autoplay = true;
            audioElRef.current = audioEl;
            pc.ontrack = e => {
                audioEl.srcObject = e.streams[0];

                // Detect actual AI audio playback using output analyser
                const outCtx = new AudioContext();
                const outSource = outCtx.createMediaStreamSource(e.streams[0]);
                const outAnalyser = outCtx.createAnalyser();
                outAnalyser.fftSize = 256;
                outSource.connect(outAnalyser);
                const outData = new Uint8Array(outAnalyser.frequencyBinCount);

                const checkAIAudio = () => {
                    if (isCallEndingRef.current) return;
                    outAnalyser.getByteFrequencyData(outData);
                    const avg = outData.reduce((a, b) => a + b, 0) / outData.length;

                    if (avg > 2) {
                        // AI is actually playing audio
                        isAISpeakingRef.current = true;
                        if (aiSilenceTimerRef.current) {
                            clearTimeout(aiSilenceTimerRef.current);
                            aiSilenceTimerRef.current = null;
                        }
                    } else if (isAISpeakingRef.current) {
                        // Audio dropped — start a short silence grace period
                        if (!aiSilenceTimerRef.current) {
                            aiSilenceTimerRef.current = setTimeout(() => {
                                isAISpeakingRef.current = false;
                                aiSilenceTimerRef.current = null;
                            }, 300);
                        }
                    }
                    requestAnimationFrame(checkAIAudio);
                };
                checkAIAudio();
            };

            // 3. Mic
            const ms = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48_000,
                    channelCount: 1,
                },
            });
            if (signal.aborted) { ms.getTracks().forEach(t => t.stop()); throw new Error('aborted'); }
            streamRef.current = ms;
            pc.addTrack(ms.getTracks()[0]);

            // 4. Mic analyser for visualizer
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(ms);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyserRef.current = analyser;
            const dataArr = new Uint8Array(analyser.frequencyBinCount);
            const tick = () => {
                if (isCallEndingRef.current) return;
                analyser.getByteFrequencyData(dataArr);
                const avg = dataArr.reduce((a, b) => a + b, 0) / dataArr.length;
                setMicLevel(isMuted ? 0 : Math.min(100, avg * 2));
                rafRef.current = requestAnimationFrame(tick);
            };
            tick();

            // 5. Data channel
            const dc = pc.createDataChannel('oai-events');
            dcRef.current = dc;

            dc.addEventListener('open', () => {
                // Session config
                dc.send(JSON.stringify({
                    type: 'session.update',
                    session: {
                        instructions: buildSystemPrompt(),
                        input_audio_transcription: { model: 'whisper-1' },
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.5,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 800,
                        },
                        modalities: ['text', 'audio'],
                        voice: agent.voiceId || 'alloy',
                        tools: isSmartNotesOnRef.current
                            ? [escalateTool, timeTool, weatherTool, checkMemoryTool, setIdleTimerTool]
                            : [escalateTool, timeTool, weatherTool, setIdleTimerTool],
                        tool_choice: 'auto',
                    },
                }));

                // Greeting
                setTimeout(() => {
                    if (isCallEndingRef.current) return;
                    dc.send(JSON.stringify({
                        type: 'response.create',
                        response: {
                            instructions: `Greet the user warmly and briefly introduce yourself as ${agent.name}. One or two sentences max.`,
                        },
                    }));
                    // Reset state
                    setLogs([{ id: 'init', role: 'model', text: '— call started —' }]);
                    setActiveItemIds([]);
                    setShowSavingsReport(false);
                    convItemIdsRef.current = [];
                }, 100);
            });

            dc.addEventListener('message', e => {
                try { handleEvent(JSON.parse(e.data)); } catch { }
            });

            // 6. WebRTC handshake
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            const sdpRes = await fetch(
                'https://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17',
                {
                    method: 'POST',
                    body: offer.sdp,
                    signal,
                    headers: {
                        Authorization: `Bearer ${KEY}`,
                        'Content-Type': 'application/sdp',
                    },
                }
            );
            if (signal.aborted) throw new Error('aborted');

            await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

            setStatus('Listening...');
            setIsCallActive(true);
            setIsStarting(false);
            isStartingRef.current = false;

        } catch (err: any) {
            if (err.message !== 'aborted') {
                console.error('[SmartV2] Connection error:', err);
                setStatus('Connection failed');
            }
            cleanupWebRTC();
            setIsCallActive(false);
            setIsStarting(false);
            isStartingRef.current = false;
        }
    };

    // ─────────────────────────────────────────────────────────────────────
    // Event handler
    // ─────────────────────────────────────────────────────────────────────

    const handleEvent = useCallback((ev: any) => {
        switch (ev.type) {

            // ── Track all conversation item IDs and create log ───────────
            case 'conversation.item.created': {
                const item = ev.item;
                if (item?.id) {
                    convItemIdsRef.current = [...convItemIdsRef.current, item.id];
                    setActiveItemIds([...convItemIdsRef.current]);
                }
                // Only log actual messages — skip function_call and function_call_output items
                if (item?.type === 'message') {
                    const role = item.role === 'assistant' ? 'model' : 'user';
                    addLog({ id: item.id, role, text: '', pending: true });
                }
                break;
            }

            // ── User started speaking ──────────────────────────────────────
            case 'input_audio_buffer.speech_started': {
                isUserSpeakingRef.current = true;
                lastAudioTimeRef.current = Date.now();
                setIdleSeconds(0);
                if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);

                if (escalStateRef.current === 'fetching') {
                    // ✨ SMART QUEUE: Don't abort the fetch — just flag that the user spoke.
                    // We'll deliver the original answer and then handle their new question.
                    userSpokeWhileFetchingRef.current = true;
                    setStatus('Still thinking...');
                } else {
                    setStatus('Listening...');
                }
                break;
            }

            // ── User stopped speaking ──────────────────────────────────────
            case 'input_audio_buffer.speech_stopped': {
                isUserSpeakingRef.current = false;
                lastAudioTimeRef.current = Date.now();
                if (escalStateRef.current !== 'fetching') {
                    setStatus('Processing...');
                }
                break;
            }

            case 'response.audio.delta': {
                isAISpeakingRef.current = true;
                lastAudioTimeRef.current = Date.now();
                if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
                break;
            }

            // ── Streaming transcript delta ─────────────────────────────────
            case 'response.audio_transcript.delta': {
                // Pause idle timer while AI is speaking
                isAISpeakingRef.current = true;
                lastAudioTimeRef.current = Date.now();
                if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);

                if (ev.delta && ev.item_id) {
                    updateLog(ev.item_id, l => ({ ...l, text: l.text + ev.delta, pending: false }));
                }
                break;
            }

            // ── Transcript complete ────────────────────────────────────────
            case 'response.audio_transcript.done': {
                // Restart idle timer after AI finishes speaking
                lastAudioTimeRef.current = Date.now();
                resetSilenceTimer();

                if (ev.transcript) {
                    updateLog(ev.item_id, l => ({ ...l, text: ev.transcript, pending: false }));
                    convHistoryRef.current = [
                        ...convHistoryRef.current,
                        { role: 'assistant', content: ev.transcript },
                    ];
                }
                if (escalStateRef.current === 'delivering') {
                    setEscalStateSync('idle');
                }
                setStatus('Listening...');
                break;
            }

            // ── User transcript complete ───────────────────────────────────
            case 'conversation.item.input_audio_transcription.completed': {
                resetSilenceTimer();
                const t = (ev.transcript || '').trim();
                if (!t) break;

                lastUserTranscriptRef.current = t;
                convHistoryRef.current = [...convHistoryRef.current, { role: 'user', content: t }];
                // Keep history bounded
                if (convHistoryRef.current.length > 40) {
                    convHistoryRef.current = convHistoryRef.current.slice(-40);
                }

                updateLog(ev.item_id, l => ({ ...l, text: t, pending: false }), {
                    id: ev.item_id, role: 'user', text: t,
                });

                // ✅ DYNAMIC SILENCE LIMIT: Reset to default on every user message
                // (The AI will call set_idle_timer if it needs to wait longer)
                if (silenceLimitRef.current !== 15000) {
                    console.log(`[TIMER] ▶️ User spoke → resetting idle limit to 15s`);
                }
                silenceLimitRef.current = 15000;

                // Buffer transcript if user spoke during fetching OR interrupted
                if (escalStateRef.current === 'fetching' || escalStateRef.current === 'interrupted') {
                    pendingInterruptRef.current = t;
                }

                // ── Every 3 user turns: prune + (optionally) summarize ────────
                if (!isCallEndingRef.current) {
                    turnCountRef.current += 1;

                    if (turnCountRef.current % 3 === 0) {
                        const dc = dcRef.current;

                        // 1. Always prune old session items (keeps last KEEP_ITEMS)
                        if (dc && dc.readyState === 'open') {
                            const items = convItemIdsRef.current;
                            const toPrune = items.slice(0, Math.max(0, items.length - KEEP_ITEMS));
                            for (const itemId of toPrune) {
                                dc.send(JSON.stringify({
                                    type: 'conversation.item.delete',
                                    item_id: itemId,
                                }));
                            }
                            convItemIdsRef.current = items.slice(-KEEP_ITEMS);
                            setActiveItemIds([...convItemIdsRef.current]);
                        }

                        // 2. Smart Notes ON → also background-summarize for semantic backup
                        if (isSmartNotesOnRef.current && !isSummarizingRef.current) {
                            isSummarizingRef.current = true;
                            setMemoryActivity('adding');
                            const recentMessages = convHistoryRef.current.slice(-12);
                            fetch('/ai-interview/api/summarize-notes', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    previousNotes: smartNotesRef.current,
                                    recentMessages,
                                    systemInstruction: agent.systemInstruction,
                                }),
                            })
                                .then(r => r.json())
                                .then(data => {
                                    if (data.notes && !isCallEndingRef.current) {
                                        smartNotesRef.current = data.notes;
                                        setSmartNotes(data.notes);
                                        if (dcRef.current && dcRef.current.readyState === 'open') {
                                            dcRef.current.send(JSON.stringify({
                                                type: 'session.update',
                                                session: { instructions: buildSystemPrompt() },
                                            }));
                                        }
                                    }
                                })
                                .catch(e => console.error('[SmartMemory] summarize error:', e))
                                .finally(() => {
                                    isSummarizingRef.current = false;
                                    setMemoryActivity('idle');
                                });
                        }
                    }
                }
                break;
            }

            // ── AI output started ──────────────────────────────────────────
            case 'response.output_item.added': {
                if (ev.item?.role === 'assistant') {
                    isAISpeakingRef.current = true;
                }
                if (escalStateRef.current !== 'fetching') {
                    setStatus('Speaking...');
                }
                break;
            }

            // ── Tool call complete ─────────────────────────────────────────
            case 'response.function_call_arguments.done': {
                if (ev.name === 'get_current_time') {
                    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    submitToolResult(ev.call_id, `The current time is ${time}.`);

                } else if (ev.name === 'check_weather') {
                    let args: any = {};
                    try { args = JSON.parse(ev.arguments || '{}'); } catch { }
                    const loc = args.location || 'that location';
                    submitToolResult(ev.call_id, `It's currently 72 degrees and sunny in ${loc}.`);

                } else if (ev.name === 'escalate_thinking') {
                    // ── DEDUP GUARD: client-side already fired escalation for this transcript ──
                    // If we're already fetching, just acknowledge the tool call with a no-op
                    // so the model doesn't stall waiting for a response.
                    console.log(`[ESCAL] 🛠️ Model fired escalate_thinking | state: ${escalStateRef.current}`);
                    if (escalStateRef.current === 'fetching') {
                        console.log(`[ESCAL] 🛑 DEDUP GUARD — already fetching (client-side), ACK-ing model tool call as no-op`);
                        // Already in flight from client-side trigger — submit a dummy result
                        // that tells mini to stay quiet (the real answer is coming via handleEscalation)
                        const dc = dcRef.current;
                        if (dc && dc.readyState === 'open') {
                            dc.send(JSON.stringify({
                                type: 'conversation.item.create',
                                item: { type: 'function_call_output', call_id: ev.call_id, output: '__handled_client_side__' },
                            }));
                            // Do NOT send response.create — the client-side escalation will handle it
                        }
                    } else {
                        console.log(`[ESCAL] ✅ Model tool call escalating (not already fetching) → calling handleEscalation`);
                        let args: { query?: string; complexity?: string } = {};
                        try { args = JSON.parse(ev.arguments || '{}'); } catch { }
                        const query = args.query || lastUserTranscriptRef.current;
                        console.log(`[ESCAL]    query: "${query.slice(0, 60)}..." | complexity: ${args.complexity}`);
                        pendingCallIdRef.current = ev.call_id;
                        handleEscalation(ev.call_id, query, args.complexity);
                    }

                } else if (ev.name === 'check_memory') {
                    setMemoryActivity('recalling');
                    lastMemoryToolRef.current = 'check_memory';

                    const finishMemoryCall = () => {
                        const notes = smartNotesRef.current || 'No notes saved yet.';
                        submitToolResult(ev.call_id, notes, 'Use the provided tool result to answer the user truthfully. Extract ONLY the relevant part. Be brief and natural. Do NOT read the whole tool result verbatim. If no notes match, say you don\'t remember seeing that.');
                    };

                    if (isSummarizingRef.current) {
                        // RARE EDGE CASE: Wait for background notes summarization to finish before reading memory
                        const checkInterval = setInterval(() => {
                            if (!isSummarizingRef.current) {
                                clearInterval(checkInterval);
                                finishMemoryCall();
                            }
                        }, 100);
                        // Failsafe timeout so it doesn't freeze forever if summarization crashes
                        setTimeout(() => clearInterval(checkInterval), 6000);
                    } else {
                        finishMemoryCall();
                    }
                } else if (ev.name === 'set_idle_timer') {
                    let args: { duration_seconds?: number } = {};
                    try { args = JSON.parse(ev.arguments || '{}'); } catch { }
                    const seconds = args.duration_seconds || 60;
                    console.log(`[TIMER] ⏸️ AI requested pause via tool → setting idle limit to ${seconds}s`);
                    silenceLimitRef.current = seconds * 1000;
                    // Cancel the already-running 15s timer and restart with the new limit
                    if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
                    lastAudioTimeRef.current = Date.now();
                    setIdleSeconds(0);
                    silenceTimeoutRef.current = setTimeout(() => {
                        if (!isCallEndingRef.current && dcRef.current && dcRef.current.readyState === 'open') {
                            dcRef.current.send(JSON.stringify({
                                type: 'response.create',
                                response: {
                                    instructions: 'The user has been silent for a while. Casually and briefly ask if they are still there or if they need anything.',
                                },
                            }));
                        }
                    }, silenceLimitRef.current);
                    submitToolResult(ev.call_id, `success: idle timer set for ${seconds}s`, `The timer is set. Now confirm naturally: "Sure, take your time!"`);
                }
                break;
            }

            // ── Response done — track usage ────────────────────────────────
            case 'response.done': {
                resetSilenceTimer();
                if (ev.response?.usage) {
                    const u = ev.response.usage;
                    const inp = u.input_token_details || {};
                    const out = u.output_token_details || {};
                    usageRef.current.textInput += inp.text_tokens || 0;
                    usageRef.current.audioInput += inp.audio_tokens || 0;
                    usageRef.current.textOutput += out.text_tokens || 0;
                    usageRef.current.audioOutput += out.audio_tokens || 0;

                    // If this response was a result of a memory tool, track it
                    if (lastMemoryToolRef.current) {
                        usageRef.current.memoryTokens += (u.total_tokens || 0);
                        lastMemoryToolRef.current = null;
                        setMemoryActivity('idle');
                    }
                }

                // FALLBACK: If the model said a filler phrase but failed to actually call the escalate tool,
                // we forcefully trigger the client-side escalation here to prevent stalling.
                if (escalStateRef.current === 'idle' && !isCallEndingRef.current) {
                    const outputItems = ev.response?.output || [];
                    const hasToolCall = outputItems.some((item: any) => item.type === 'function_call');

                    // Look at the last message to see if it was just a filler
                    const lastModelMsg = convHistoryRef.current[convHistoryRef.current.length - 1];
                    const wasFiller = lastModelMsg && lastModelMsg.role === 'assistant' && isFillerPhrase(lastModelMsg.content);

                    if (!hasToolCall && wasFiller) {
                        console.log(`[ESCAL] ⚠️ Model got stuck after filler! Force firing client-side escalation.`);
                        const syntheticCallId = `client_fallback_${Date.now()}`;
                        pendingCallIdRef.current = syntheticCallId;
                        handleEscalation(syntheticCallId, lastUserTranscriptRef.current, 'complex');
                    } else {
                        setStatus('Listening...');
                    }
                } else if (escalStateRef.current === 'idle') {
                    setStatus('Listening...');
                }
                break;
            }
        }
    }, []);

    // ─────────────────────────────────────────────────────────────────────
    // Escalation handler — with retry, timeout, interrupt handling
    // ─────────────────────────────────────────────────────────────────────

    const handleEscalation = async (callId: string, query: string, complexity?: string) => {
        if (isCallEndingRef.current) return;

        console.log(`[ESCAL] ⚡ handleEscalation ENTER | callId: ${callId} | complexity: ${complexity} | query: "${query.slice(0, 60)}..."`);

        setEscalStateSync('fetching');
        setStatus('Thinking...');
        setEscalTarget((complexity as 'moderate' | 'complex') || 'moderate');
        fillerSentRef.current = true;
        userSpokeWhileFetchingRef.current = false; // reset queue flag
        pendingInterruptRef.current = null;         // clear any stale queue

        // Create a new abort controller for this escalation
        const ac = new AbortController();
        escalAbortRef.current = ac;

        // Race: actual fetch vs timeout
        let answer: string | null = null;
        let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
        let filterUsage: { prompt_tokens: number; completion_tokens: number } | null = null;
        let fetchedModel: string | null = null;

        for (let attempt = 0; attempt <= MAX_ESCALATION_RETRIES; attempt++) {
            // If interrupted between retries, bail
            if (escalStateRef.current === 'interrupted' || ac.signal.aborted || isCallEndingRef.current) {
                break;
            }

            try {
                const timeoutPromise = sleep(ESCALATION_TIMEOUT_MS).then(() => {
                    throw new Error('timeout');
                });

                const fetchPromise = fetch('/ai-interview/api/escalate', {
                    method: 'POST',
                    signal: ac.signal,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query,
                        conversationHistory: convHistoryRef.current.slice(-HISTORY_CONTEXT_TURNS),
                        systemInstruction: agent.systemInstruction,
                        complexity
                    }),
                }).then(r => r.json());

                const data = await Promise.race([fetchPromise, timeoutPromise]);

                if (data?.answer) {
                    console.log(`[ESCAL] ✅ Got answer from ${data.modelUsed} on attempt ${attempt}`);
                    answer = data.answer;
                    usage = data.usage || null;
                    filterUsage = data.filterUsage || null;
                    if (data.modelUsed) {
                        fetchedModel = data.modelUsed;
                        setEscalModel(data.modelUsed);
                    }
                    if (data.wasSanitized) {
                        console.log(`[ESCAL] ✨ API flagged response as sanitized`);
                        setIsFilterActive(true);
                    } else {
                        setIsFilterActive(false);
                    }
                    break; // success
                }

                console.log(`[ESCAL] ⚠️ No answer in response on attempt ${attempt}, retrying...`);
                // If we got a response but no answer, retry
                if (attempt < MAX_ESCALATION_RETRIES) {
                    await sleep(300 * (attempt + 1)); // back-off
                }

            } catch (err: any) {
                if (err.name === 'AbortError' || (escalStateRef.current as string) === 'interrupted') {
                    console.log(`[ESCAL] 🛑 Fetch aborted (AbortError or interrupted)`);
                    break; // user interrupted — handled below
                }
                if (err.message === 'timeout' && attempt < MAX_ESCALATION_RETRIES) {
                    console.log(`[ESCAL] ⏱️ Timeout on attempt ${attempt}, retrying...`);
                    // On timeout, tell user we're still thinking (only once)
                    if (!fillerSentRef.current && dcRef.current && !isCallEndingRef.current) {
                        fillerSentRef.current = true;
                        sendMiniSpeech("Just a moment longer, I want to make sure I get this right...", true);
                    }
                    continue;
                }
                console.log(`[ESCAL] ❌ Final error on attempt ${attempt}:`, err.message);
                // Final failure
                break;
            }
        }

        // ── Post-fetch handling ────────────────────────────────────────────

        // Case 1: fetch was explicitly aborted (edge case — shouldn't normally happen now)
        if (escalStateRef.current === 'interrupted') {
            console.log(`[ESCAL] 🔄 Case 1: interrupted after fetch, submitting redirect`);
            submitToolResult(callId, "Sorry about that — let me address what you just said.");
            const buffered = pendingInterruptRef.current;
            pendingInterruptRef.current = null;
            userSpokeWhileFetchingRef.current = false;
            if (buffered && dcRef.current && !isCallEndingRef.current) {
                setTimeout(() => {
                    if (isCallEndingRef.current || !dcRef.current) return;
                    dcRef.current.send(JSON.stringify({
                        type: 'response.create',
                        response: {
                            instructions: `The user said: "${buffered}". Address it directly and naturally.`,
                        },
                    }));
                }, 200);
            }
            setEscalStateSync('idle');
            setStatus('Listening...');
            return;
        }

        // Case 2: Call ended while we were fetching
        if (isCallEndingRef.current) return;

        // Case 3: We got an answer
        if (answer) {
            console.log(`[ESCAL] 🎯 Case 3: delivering answer via ${callId.startsWith('client_') ? 'client response.create' : 'tool result'}`);
            if (usage) {
                if (fetchedModel === 'gpt-4o-mini') {
                    usageRef.current.escalationMiniPromptTokens += usage.prompt_tokens || 0;
                    usageRef.current.escalationMiniCompletionTokens += usage.completion_tokens || 0;
                    setEscalCountMini(p => p + 1);
                } else {
                    usageRef.current.escalationPromptTokens += usage.prompt_tokens || 0;
                    usageRef.current.escalationCompletionTokens += usage.completion_tokens || 0;
                    setEscalCount4o(p => p + 1);
                }
                usageRef.current.escalationCount++;
            }

            if (filterUsage) {
                usageRef.current.filterPromptTokens += filterUsage.prompt_tokens || 0;
                usageRef.current.filterCompletionTokens += filterUsage.completion_tokens || 0;
            }

            // Mark last model log as escalated
            setLogs(prev => {
                const copy = [...prev];
                for (let i = copy.length - 1; i >= 0; i--) {
                    if (copy[i].role === 'model') {
                        copy[i] = { ...copy[i], escalated: true };
                        break;
                    }
                }
                return copy;
            });

            // ✨ SMART QUEUE: if user spoke while we were thinking, handle their queued question too
            const queuedQuestion = pendingInterruptRef.current;
            pendingInterruptRef.current = null;
            userSpokeWhileFetchingRef.current = false;

            setEscalStateSync('delivering');
            setStatus('Speaking...');

            if (queuedQuestion) {
                // Deliver the answer, then immediately address their queued question
                submitToolResult(
                    callId,
                    answer,
                    `After giving that answer, you heard the user say something during your thinking. Naturally transition and address their follow-up: "${queuedQuestion}"`
                );
            } else {
                submitToolResult(callId, answer);
            }

        } else {
            // Case 4: All retries exhausted / timeout — check for queued question first
            console.log(`[ESCAL] ❌ Case 4: all retries failed, sending fallback response`);
            const queuedQuestion = pendingInterruptRef.current;
            pendingInterruptRef.current = null;
            userSpokeWhileFetchingRef.current = false;

            setEscalStateSync('idle');
            setStatus('Speaking...');

            if (queuedQuestion) {
                submitToolResult(
                    callId,
                    `I wasn't quite able to get that one — but I heard you. Let me help with what you just said.`,
                    `Now directly address the user's follow-up question: "${queuedQuestion}"`
                );
            } else {
                submitToolResult(
                    callId,
                    "I want to make sure I give you the right answer — let me look into that a bit more. Anything else I can help with in the meantime?"
                );
            }
        }
    };

    // ─────────────────────────────────────────────────────────────────────
    // Submit tool result + trigger response
    // ─────────────────────────────────────────────────────────────────────

    const submitToolResult = (callId: string, result: string, extraInstruction?: string) => {
        const dc = dcRef.current;
        if (!dc || dc.readyState !== 'open' || isCallEndingRef.current) return;

        console.log(`[ESCAL] 📤 submitToolResult | callId: ${callId} | synthetic: ${callId.startsWith('client_')} | result: "${result.slice(0, 60)}..."`);

        const instruction = extraInstruction
            ? `I have provided the tool result. ${extraInstruction}`
            : `You just figured this out after thinking for a moment. Deliver it naturally like a human who just worked it through — vary your opening (sometimes dive straight in, sometimes use "So...", "Okay so...", "Right, so...", "Alright —", never use "Certainly" or "Of course"). Keep it conversational, not lecture-like. The answer is: "${result}"`;
        // Synthetic call IDs come from client-side escalation — no real tool call exists in the
        // Realtime session, so we skip function_call_output and inject the answer directly.
        if (callId.startsWith('client_')) {
            dc.send(JSON.stringify({
                type: 'response.create',
                response: { instructions: instruction },
            }));
            return;
        }

        dc.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: result,
            },
        }));

        dc.send(JSON.stringify({
            type: 'response.create',
            response: { instructions: instruction },
        }));
    };

    // Helper: make mini say something immediately (used only for silence recovery, NOT during tool calls)
    const sendMiniSpeech = (text: string, allowDuringFetch: boolean = false) => {
        const dc = dcRef.current;
        if (!dc || dc.readyState !== 'open' || isCallEndingRef.current) return;
        // Guard: never fire a parallel response.create if a tool call is in-flight
        if (!allowDuringFetch && (escalStateRef.current === 'fetching' || escalStateRef.current === 'delivering')) return;

        dc.send(JSON.stringify({
            type: 'response.create',
            response: { instructions: `Say this naturally and briefly: "${text}"` },
        }));
    };

    // ─────────────────────────────────────────────────────────────────────
    // Log helpers
    // ─────────────────────────────────────────────────────────────────────

    const addLog = (entry: LogEntry) => {
        setLogs(prev => prev.find(l => l.id === entry.id) ? prev : [...prev, entry]);
    };

    const updateLog = (
        id: string,
        updater: (l: LogEntry) => LogEntry,
        fallback?: LogEntry
    ) => {
        setLogs(prev => {
            const idx = prev.findIndex(l => l.id === id);
            if (idx === -1) return fallback ? [...prev, fallback] : prev;
            const copy = [...prev];
            copy[idx] = updater(copy[idx]);
            return copy;
        });
    };

    // ─────────────────────────────────────────────────────────────────────
    // End call
    // ─────────────────────────────────────────────────────────────────────

    const endCall = () => {
        if (hasSavedRef.current) return;
        isCallEndingRef.current = true;
        escalAbortRef.current?.abort();

        const dur = startTimeRef.current
            ? Math.floor((Date.now() - startTimeRef.current) / 1000)
            : 0;

        const cost = computeLiveCost();

        if (onCallEnd && pcRef.current) {
            hasSavedRef.current = true;
            setShowSavingsReport(true);
            onCallEnd({
                id: Math.random().toString(36).substring(7),
                durationSeconds: dur,
                usage: { ...usageRef.current },
                cost,
                date: new Date().toLocaleString(),
            });
        }


        cleanupWebRTC();
        setIsCallActive(false);
        setEscalStateSync('idle');
        setStatus('Call ended');
        setTimeout(() => setStatus('Ready'), 2500);
    };

    const toggleMute = () => {
        if (!streamRef.current) return;
        const audioTrack = streamRef.current.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            setIsMuted(!audioTrack.enabled);
        }
    };

    const cleanupWebRTC = () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        pcRef.current?.close();
        dcRef.current?.close();
        streamRef.current?.getTracks().forEach(t => t.stop());
        pcRef.current = null;
        dcRef.current = null;
        streamRef.current = null;
    };

    // ─────────────────────────────────────────────────────────────────────
    // UI helpers
    // ─────────────────────────────────────────────────────────────────────

    const fmt = (s: number) =>
        `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

    const isThinking = escalState === 'fetching';
    const isInterrupted = escalState === 'interrupted';
    const isDelivering = escalState === 'delivering';

    // Waveform bars
    const BARS = 20;
    const waveHeights = Array.from({ length: BARS }, (_, i) => {
        const base = isCallActive ? (micLevel / 100) : 0;
        const phase = Math.sin((i / BARS) * Math.PI * 2) * 0.5 + 0.5;
        return Math.max(4, Math.round(base * phase * 40 + 4));
    });

    // ─────────────────────────────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────────────────────────────

    return (
        <div className="relative flex flex-col md:flex-row items-start justify-start gap-8 w-full max-w-5xl mx-auto"

            style={{ fontFamily: "'DM Sans', sans-serif" }}>

            {/* ── Left Column: Call Interface ────────────────────────────── */}
            <div className="flex flex-col items-center w-full max-w-sm shrink-0 h-fit">

                {/* ── Card ──────────────────────────────────────────────────── */}
                <div className={cn(
                    "relative w-full rounded-[2rem] overflow-hidden border transition-all duration-700",
                    isThinking
                        ? "border-violet-200 shadow-xl shadow-violet-100/50"
                        : isCallActive
                            ? "border-slate-100 shadow-xl shadow-slate-200/60"
                            : "border-slate-100 shadow-lg"
                )}>

                    {/* Background */}
                    <div className={cn(
                        "absolute inset-0 transition-all duration-1000",
                        isThinking
                            ? "bg-gradient-to-br from-violet-50 via-white to-indigo-50"
                            : "bg-white"
                    )} />

                    {/* Subtle grid texture */}
                    <div className="absolute inset-0 opacity-[0.03]"
                        style={{
                            backgroundImage: 'repeating-linear-gradient(0deg,#000 0,#000 1px,transparent 1px,transparent 20px),repeating-linear-gradient(90deg,#000 0,#000 1px,transparent 1px,transparent 20px)',
                        }} />

                    <div className="relative flex flex-col items-center px-6 pt-8 pb-7 gap-5">

                        {/* ── Top row: status + cost ───────────────────────────── */}
                        <div className="w-full flex items-center justify-between">
                            <div className={cn(
                                "flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-semibold tracking-wide transition-all duration-300",
                                isThinking
                                    ? "bg-violet-100 text-violet-700"
                                    : isCallActive
                                        ? "bg-emerald-50 text-emerald-700"
                                        : "bg-slate-100 text-slate-400"
                            )}>
                                <div className={cn(
                                    "w-1.5 h-1.5 rounded-full transition-all",
                                    isThinking
                                        ? "bg-violet-500 animate-pulse"
                                        : isCallActive
                                            ? "bg-emerald-500 animate-pulse"
                                            : "bg-slate-300"
                                )} />
                                {status}
                            </div>

                            {isCallActive && (
                                <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50/80 backdrop-blur-sm border border-slate-100 shadow-sm transition-all duration-500">
                                    <Timer size={12} className={cn("transition-colors", idleSeconds > (silenceLimitRef.current / 2000) ? "text-amber-500 animate-pulse" : "text-slate-400")} />
                                    <span className={cn(
                                        "text-[10px] font-bold tabular-nums tracking-tight",
                                        idleSeconds > (silenceLimitRef.current / 2000) ? "text-amber-700" : "text-slate-500"
                                    )}>
                                        {Math.max(0, Math.floor(silenceLimitRef.current / 1000 - idleSeconds))}s
                                    </span>
                                </div>
                            )}

                            {isCallActive && (
                                <button
                                    onClick={() => setShowCost(p => !p)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-500 text-[11px] font-semibold transition-all shadow-sm border border-slate-100"
                                >
                                    {showCost ? <DollarSign size={11} /> : <Clock size={11} />}
                                    {showCost ? `$${liveCost.toFixed(5)}` : fmt(duration)}
                                </button>
                            )}
                        </div>

                        {/* ── Avatar ──────────────────────────────────────────── */}
                        <div className="relative">
                            {/* Outer ring — pulses on state */}
                            <div className={cn(
                                "absolute -inset-3 rounded-full transition-all duration-700",
                                isThinking
                                    ? "bg-violet-100 animate-pulse"
                                    : isCallActive
                                        ? "bg-sky-50"
                                        : "bg-transparent"
                            )} />

                            <div className={cn(
                                "relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-500",
                                "border-2",
                                isThinking
                                    ? "border-violet-200 shadow-lg shadow-violet-100"
                                    : isCallActive
                                        ? "border-sky-100 shadow-md"
                                        : "border-slate-100 shadow-sm"
                            )}>
                                <span className="text-4xl">🤖</span>

                                {/* Brain badge */}
                                {isThinking && (
                                    <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-violet-500 rounded-full flex items-center justify-center shadow-md animate-bounce">
                                        <Brain size={13} className="text-white" />
                                    </div>
                                )}
                                {isInterrupted && (
                                    <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-amber-400 rounded-full flex items-center justify-center shadow-md">
                                        <X size={13} className="text-white" />
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* ── Agent name ──────────────────────────────────────── */}
                        <div className="text-center -mt-1">
                            <h2 className="text-xl font-bold text-slate-900 tracking-tight">{agent.name}</h2>
                            <p className="text-[11px] text-slate-400 mt-0.5">Your Personal Assistant</p>

                        </div>

                        {/* ── Waveform visualizer ─────────────────────────────── */}
                        <div className="flex items-end justify-center gap-[3px] h-10 w-full px-4">
                            {waveHeights.map((h, i) => (
                                <div
                                    key={i}
                                    className={cn(
                                        "w-[3px] rounded-full transition-all duration-100",
                                        isThinking
                                            ? "bg-violet-300"
                                            : isCallActive
                                                ? "bg-sky-400"
                                                : "bg-slate-200"
                                    )}
                                    style={{ height: `${h}px` }}
                                />
                            ))}
                        </div>

                        {/* ── Real-time Architecture Flow Diagram ──────────────────────────────── */}
                        <div className="w-full mt-2 flex flex-col items-center gap-3 p-4 rounded-2xl bg-slate-50/50 border border-slate-100 shadow-inner">
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 flex items-center justify-between w-full relative">
                                <span>AI Decision Flow</span>

                                {/* Hover Tooltip Overlay */}
                                {hoveredNode && NODE_DESCRIPTIONS[hoveredNode] && (
                                    <div className="absolute top-[-70px] left-1/2 -translate-x-1/2 w-64 bg-white/95 backdrop-blur-md border border-slate-200 shadow-2xl rounded-xl p-3 z-[60] animate-in fade-in zoom-in duration-200">
                                        <div className="text-[11px] font-bold text-slate-900 border-b border-slate-100 pb-1 mb-1.5 flex items-center gap-1.5">
                                            <div className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                                            {NODE_DESCRIPTIONS[hoveredNode].title}
                                        </div>
                                        <p className="text-[10px] text-slate-500 leading-relaxed font-medium">
                                            {NODE_DESCRIPTIONS[hoveredNode].text}
                                        </p>
                                        <div className="absolute bottom-[-6px] left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-r border-b border-slate-200 rotate-45" />
                                    </div>
                                )}



                                {interruptCount > 0 && (
                                    <span className="flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                                        <Activity size={9} /> {interruptCount} QUEUES
                                    </span>
                                )}
                            </div>

                            {/* Top Layer: Input & Realtime System */}
                            <div className="flex w-full items-center justify-between px-2">
                                {/* User Voice */}
                                <div
                                    className={cn("flex flex-col items-center gap-1 transition-all duration-300 cursor-help", isCallActive ? "opacity-100" : "opacity-40")}
                                    onMouseEnter={() => setHoveredNode('you')}
                                    onMouseLeave={() => setHoveredNode(null)}
                                >
                                    <div className={cn("w-10 h-10 rounded-full flex items-center justify-center bg-white border shadow-sm transition-all duration-100", isCallActive && micLevel > 5 ? "border-emerald-300 shadow-emerald-100 ring-4 ring-emerald-50 scale-105" : "border-slate-200")}>
                                        {isMuted ? <MicOff size={16} className="text-rose-400" /> : <Mic size={16} className={isCallActive ? "text-emerald-500" : "text-slate-300"} />}
                                    </div>
                                    <span className="text-[9px] font-bold text-slate-500">You</span>


                                    {isCallActive && (
                                        <div className="w-8 h-1 bg-slate-100 rounded-full overflow-hidden mt-0.5" title="Idle timeout">
                                            <div className={cn("h-full transition-all duration-1000", idleSeconds > (silenceLimitRef.current / 1000 - 5) ? "bg-amber-400" : "bg-emerald-300")} style={{ width: `${Math.min(100, (idleSeconds / (silenceLimitRef.current / 1000)) * 100)}%` }} />
                                        </div>
                                    )}
                                </div>

                                {/* Stream Arrow */}
                                <div className="flex-1 flex items-center justify-center relative h-[2px] mx-3 bg-slate-200">
                                    <div className={cn("absolute inset-y-0 left-0 bg-emerald-400 transition-all duration-300", isCallActive ? "w-full" : "w-0")} />
                                    <ArrowRight size={12} className={cn("absolute right-[-4px] text-emerald-400 transition-all", isCallActive ? "opacity-100" : "opacity-0")} />
                                </div>

                                {/* Realtime Engine */}
                                <div
                                    className={cn("flex flex-col items-center gap-1.5 transition-all duration-300 cursor-help", isCallActive ? "opacity-100" : "opacity-40")}
                                    onMouseEnter={() => setHoveredNode('core')}
                                    onMouseLeave={() => setHoveredNode(null)}
                                >
                                    <div className={cn("w-11 h-11 rounded-xl flex items-center justify-center border shadow-sm transition-all duration-300", isCallActive && !isThinking ? "bg-sky-500 border-sky-400 shadow-sky-200 ring-4 ring-sky-50" : "bg-white border-slate-200")}>
                                        <Zap size={20} className={isCallActive && !isThinking ? "text-white animate-pulse" : "text-slate-400"} />
                                    </div>
                                    <span className="text-[10px] font-bold text-slate-700 uppercase tracking-tighter">Daily Chat</span>

                                </div>

                            </div>

                            {/* Middle Layer: Routing Pipes */}
                            <div className="flex w-full items-center justify-center relative h-10 mt-1">
                                {/* Pipe from Realtime */}
                                <div className="absolute top-0 right-[40px] w-[2px] h-4 bg-slate-200" />
                                {/* Horizontal connector to Leftmost pipe */}
                                <div
                                    className="absolute top-4 h-[2px] bg-slate-200 transition-all duration-500"
                                    style={{ right: '40px', width: `calc(50% + ${isSmartNotesOn ? 16 : -12}px)` }}
                                />

                                {/* Left Path (Moderate) */}
                                <div
                                    className={cn("absolute top-4 w-[2px] h-6 transition-all duration-300", escalTarget === 'moderate' && isThinking ? "bg-indigo-400" : "bg-slate-200")}
                                    style={{ left: `calc(50% - ${isSmartNotesOn ? 56 : 28}px)` }}
                                />
                                <ArrowDown size={10} className={cn("absolute top-8 transition-all", escalTarget === 'moderate' && isThinking ? "text-indigo-400 opacity-100" : "opacity-0")} style={{ left: `calc(50% - ${isSmartNotesOn ? 60 : 32}px)` }} />

                                {/* Middle/Right Path (Complex) */}
                                <div
                                    className={cn("absolute top-4 w-[2px] h-6 transition-all duration-300", escalTarget === 'complex' && isThinking ? "bg-violet-400" : "bg-slate-200")}
                                    style={{ left: `calc(50% ${isSmartNotesOn ? '+ 0' : '+ 28'}px)` }}
                                />
                                <ArrowDown size={10} className={cn("absolute top-8 transition-all", escalTarget === 'complex' && isThinking ? "text-violet-400 opacity-100" : "opacity-0")} style={{ left: `calc(50% ${isSmartNotesOn ? '- 4' : '+ 24'}px)` }} />

                                {/* Far Right Path (Memory DB) */}
                                {isSmartNotesOn && (
                                    <>
                                        <div className={cn("absolute top-4 w-[2px] h-6 transition-all duration-300", memoryActivity !== 'idle' ? "bg-sky-400" : "bg-slate-200")} style={{ left: 'calc(50% + 56px)' }} />
                                        <ArrowDown size={10} className={cn("absolute top-8 transition-all", memoryActivity !== 'idle' ? "text-sky-400 opacity-100" : "opacity-0")} style={{ left: 'calc(50% + 52px)' }} />
                                    </>
                                )}
                            </div>

                            {/* Bottom Layer: The Brains + Memory */}
                            <div className="flex w-full justify-center gap-5 -mt-2">
                                {/* GPT-4o-Mini Brain (Moderate) */}
                                <div
                                    className={cn("flex flex-col items-center gap-1.5 transition-all duration-500 cursor-help", escalTarget === 'moderate' && isThinking ? "scale-110 opacity-100" : (escalCountMini > 0 ? "scale-100 opacity-80" : "scale-90 opacity-40"))}
                                    onMouseEnter={() => setHoveredNode('basic')}
                                    onMouseLeave={() => setHoveredNode(null)}
                                >
                                    <div className={cn("relative w-9 h-9 rounded-[10px] flex items-center justify-center bg-white border shadow-sm transition-all", escalTarget === 'moderate' && isThinking ? "border-indigo-400 shadow-indigo-200 ring-4 ring-indigo-50" : "border-slate-200")}>
                                        <Brain size={16} className={escalTarget === 'moderate' && isThinking ? "text-indigo-500 animate-bounce" : "text-slate-400"} />


                                        {escalCountMini > 0 && (
                                            <span className="absolute -top-2 -right-2 bg-indigo-500 text-white text-[9px] w-[18px] h-[18px] flex items-center justify-center rounded-full font-bold shadow-sm">{escalCountMini}</span>
                                        )}
                                    </div>
                                    <div className="flex flex-col items-center">
                                        <span className="text-[8px] font-bold text-indigo-500 uppercase">Basic</span>
                                        <span className="text-[9px] font-bold text-slate-600">Standard Brain</span>
                                    </div>
                                </div>


                                {/* GPT-4o Brain (Complex) */}
                                <div
                                    className={cn("flex flex-col items-center gap-1.5 transition-all duration-500 cursor-help", escalTarget === 'complex' && isThinking ? "scale-110 opacity-100" : (escalCount4o > 0 ? "scale-100 opacity-80" : "scale-90 opacity-40"))}
                                    onMouseEnter={() => setHoveredNode('complex')}
                                    onMouseLeave={() => setHoveredNode(null)}
                                >
                                    <div className={cn("relative w-9 h-9 rounded-[10px] flex items-center justify-center bg-white border shadow-sm transition-all", escalTarget === 'complex' && isThinking ? "border-violet-400 shadow-violet-200 ring-4 ring-violet-50" : "border-slate-200")}>
                                        <Brain size={16} className={escalTarget === 'complex' && isThinking ? "text-violet-500 animate-bounce" : "text-slate-400"} />


                                        {escalCount4o > 0 && (
                                            <span className="absolute -top-2 -right-2 bg-violet-600 text-white text-[9px] w-[18px] h-[18px] flex items-center justify-center rounded-full font-bold shadow-sm">{escalCount4o}</span>
                                        )}
                                    </div>
                                    <div className="flex flex-col items-center">
                                        <span className="text-[8px] font-bold text-violet-500 uppercase">Deep Analysis</span>
                                        <span className="text-[9px] font-bold text-slate-600">Advanced Brain</span>
                                    </div>
                                </div>


                                {/* Smart Memory Node */}
                                {isSmartNotesOn && (
                                    <div className={cn("flex flex-col items-center gap-1.5 transition-all duration-500", memoryActivity !== 'idle' ? "scale-110 opacity-100" : "scale-90 opacity-50")}>
                                        <div className={cn("relative w-9 h-9 rounded-[10px] flex items-center justify-center bg-white border shadow-sm transition-all", memoryActivity !== 'idle' ? "border-sky-400 shadow-sky-200 ring-4 ring-sky-50" : "border-slate-200")} title="Knowledge Base - Agent stores and recalls specific facts about you">
                                            <BookOpen size={14} className={memoryActivity !== 'idle' ? "text-sky-500 animate-pulse" : "text-slate-400"} />

                                            {memoryActivity !== 'idle' && (
                                                <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-sky-400 rounded-full animate-ping" />
                                            )}
                                        </div>
                                        <div className="flex flex-col items-center">
                                            <span className="text-[8px] font-bold text-sky-500 uppercase">Context</span>
                                            <span className="text-[9px] font-bold text-slate-600">Knowledge Base</span>
                                        </div>
                                    </div>

                                )}
                            </div>

                            {/* ── Layer 4: Output Synthesis & Filtering ── */}
                            <div className="w-full flex flex-col items-center gap-1 mt-3.5 pt-3 border-t border-slate-50 relative">
                                {/* Connection Lines from Brains to Filter */}
                                <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-48 h-3 flex justify-between px-6">
                                    <div className={cn("w-[2px] h-full transition-all duration-500", (isThinking || isDelivering) && escalTarget === 'moderate' ? "bg-indigo-300" : "bg-slate-100")} />
                                    <div className={cn("w-[2px] h-full transition-all duration-500", (isThinking || isDelivering) && escalTarget === 'complex' ? "bg-violet-300" : "bg-slate-100")} />
                                    {isSmartNotesOn && <div className={cn("w-[2px] h-full transition-all duration-500", memoryActivity !== 'idle' ? "bg-sky-300" : "bg-slate-100")} />}
                                </div>

                                <div className="flex items-center gap-8 px-4">
                                    {/* Filter Node */}
                                    <div
                                        className={cn("flex flex-col items-center gap-1 transition-all duration-300 cursor-help", isDelivering || isFilterActive ? "opacity-100" : "opacity-30")}
                                        onMouseEnter={() => setHoveredNode('filter')}
                                        onMouseLeave={() => setHoveredNode(null)}
                                    >
                                        <div className={cn(
                                            "w-8 h-8 rounded-full flex items-center justify-center border shadow-sm transition-all duration-500",
                                            isFilterActive
                                                ? "bg-emerald-500 border-emerald-400 shadow-emerald-200 ring-4 ring-emerald-50 scale-110"
                                                : "bg-white border-slate-200"
                                        )}>
                                            <BookOpen size={12} className={isFilterActive ? "text-white animate-pulse" : "text-slate-300"} />
                                        </div>
                                        <span className={cn("text-[8px] font-bold transition-all", isFilterActive ? "text-emerald-500" : "text-slate-400 uppercase tracking-tighter")}>Filter</span>
                                    </div>

                                    {/* Flow Arrow */}
                                    <div className="flex items-center">
                                        <ArrowRight size={10} className={cn("transition-all duration-500", isDelivering ? "text-emerald-400 translate-x-0 opacity-100" : "text-slate-200 -translate-x-2 opacity-0")} />
                                    </div>

                                    {/* Voice Output Node */}
                                    <div className={cn("flex flex-col items-center gap-1 transition-all duration-500", isDelivering ? "opacity-100" : "opacity-30")}>
                                        <div className={cn(
                                            "w-9 h-9 rounded-full flex items-center justify-center bg-white border shadow-sm transition-all duration-300",
                                            isDelivering ? "border-emerald-300 shadow-emerald-100 ring-4 ring-emerald-50" : "border-slate-200"
                                        )}>
                                            <Activity size={14} className={isDelivering ? "text-emerald-500 animate-pulse" : "text-slate-300"} />
                                        </div>
                                        <span className={cn("text-[8px] font-bold uppercase tracking-tighter", isDelivering ? "text-emerald-500" : "text-slate-400")}>Voice</span>
                                    </div>
                                </div>
                            </div>

                        </div>

                        {/* ── Post-Call Savings Report ───────────────────────────── */}
                        {showSavingsReport && (
                            <div className="w-full mt-5 rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-600 to-fuchsia-600 border border-violet-400 p-5 shadow-2xl animate-in slide-in-from-bottom-8 fade-in duration-700 text-white relative overflow-hidden">
                                <div className="absolute -top-10 -right-10 w-32 h-32 bg-white/10 rounded-full blur-2xl" />
                                <div className="absolute -bottom-10 -left-10 w-24 h-24 bg-white/10 rounded-full blur-xl" />

                                <div className="relative z-10 flex flex-col items-center text-center">
                                    <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center mb-3">
                                        <DollarSign size={20} className="text-white" />
                                    </div>
                                    <h3 className="text-[10px] font-black uppercase tracking-widest text-violet-100 mb-1">Architecture Savings Report</h3>
                                    <p className="text-[28px] font-black tracking-tighter mb-4 leading-none">
                                        {(((usageRef.current.audioInput * STD_RT_AUDIO_IN / 1000000 + usageRef.current.audioOutput * STD_RT_AUDIO_OUT / 1000000) - liveCost) / ((usageRef.current.audioInput * STD_RT_AUDIO_IN / 1000000 + usageRef.current.audioOutput * STD_RT_AUDIO_OUT / 1000000) || 1) * 100).toFixed(0)}% Saved
                                    </p>


                                    <div className="w-full bg-white/10 rounded-xl p-3 flex justify-between items-center border border-white/20">
                                        <div className="flex flex-col text-left">
                                            <span className="text-[9px] text-violet-200 uppercase font-bold tracking-wider">Standard Mode Cost</span>
                                            <span className="text-[13px] font-medium text-slate-300 line-through decoration-rose-400/70">
                                                ${((usageRef.current.audioInput * STD_RT_AUDIO_IN / 1000000) + (usageRef.current.audioOutput * STD_RT_AUDIO_OUT / 1000000)).toFixed(4)}
                                            </span>
                                        </div>
                                        <ArrowRight size={14} className="text-violet-300 mx-2" />
                                        <div className="flex flex-col text-right">
                                            <span className="text-[9px] text-emerald-200 uppercase font-bold tracking-wider">Smart Mode Cost</span>
                                            <span className="text-[14px] font-black text-white">
                                                ${liveCost.toFixed(4)}
                                            </span>
                                        </div>
                                    </div>

                                    <p className="text-[10px] text-violet-200 font-medium italic mt-3">
                                        Calculated automatically after the call finishes.
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* ── Smart Notes Viewer (Integrated) ────────────────────────── */}

                        {isSmartNotesOn && (
                            <div className="w-full mt-3 rounded-xl bg-violet-50/50 border border-violet-100 p-3 space-y-1.5 animate-in fade-in slide-in-from-top-2 duration-500">
                                <div className="flex items-center gap-1.5 mb-1 text-violet-600">
                                    <BookOpen size={12} />
                                    <span className="text-[10px] font-bold uppercase tracking-wider">Learned Facts</span>
                                </div>

                                <div className={cn(
                                    "text-[11px] leading-relaxed whitespace-pre-wrap",
                                    smartNotes ? "text-violet-900" : "text-violet-400 italic"
                                )}>
                                    {smartNotes || "Waiting for facts to remember..."}
                                </div>
                            </div>
                        )}

                        {/* ── Smart Notes UI ────────────────────────────────────── */}
                        <div className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100 mt-2">
                            <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                    <BookOpen size={14} className={isSmartNotesOn ? "text-violet-500" : "text-slate-400"} />
                                    <span className="text-[11px] font-bold text-slate-700">Remember Facts</span>
                                </div>

                                <span className="text-[10px] text-slate-400">
                                    {isSmartNotesOn ? "Agent remembers what you say" : "Toggle to enable memory"}
                                </span>

                            </div>
                            <div className="flex items-center gap-3">
                                <div className="flex items-center gap-1.5 min-w-[70px] justify-end">
                                    {memoryActivity === 'adding' && (
                                        <div className="flex items-center gap-1 px-1.5 py-0.5 bg-sky-100 rounded text-sky-600 animate-pulse">
                                            <Loader2 size={8} className="animate-spin" />
                                            <span className="text-[8px] font-bold uppercase tracking-tight">Saving</span>
                                        </div>
                                    )}
                                    {memoryActivity === 'recalling' && (
                                        <div className="flex items-center gap-1 px-1.5 py-0.5 bg-violet-100 rounded text-violet-600 animate-pulse">
                                            <Loader2 size={8} className="animate-spin" />
                                            <span className="text-[8px] font-bold uppercase tracking-tight">Recalling</span>
                                        </div>
                                    )}
                                    {isSmartNotesOn && memoryActivity === 'idle' && (
                                        <div className="flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 rounded text-emerald-600/60">
                                            <Activity size={8} />
                                            <span className="text-[8px] font-bold uppercase tracking-tight">Active</span>
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={() => {
                                        setIsSmartNotesOn(p => {
                                            isSmartNotesOnRef.current = !p;
                                            return !p;
                                        });
                                    }}
                                    className={cn(
                                        "w-10 h-5 rounded-full relative transition-all duration-300",
                                        isSmartNotesOn ? "bg-violet-500" : "bg-slate-200"
                                    )}
                                >
                                    <div className={cn(
                                        "w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all duration-300 shadow-sm",
                                        isSmartNotesOn ? "left-[22px]" : "left-[3px]"
                                    )} />
                                </button>
                            </div>
                        </div>

                        {/* ── Call buttons ──────────────────────────────────────── */}
                        {!isCallActive ? (
                            <Button
                                onClick={startCall}
                                disabled={isStarting}
                                className="w-full h-13 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm transition-all disabled:opacity-50 mt-1"
                            >
                                {isStarting ? (
                                    <span className="flex items-center gap-2">
                                        <div className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                                        Connecting...
                                    </span>
                                ) : 'Start Call'}
                            </Button>
                        ) : (
                            <div className="flex gap-2 w-full mt-1">
                                <Button
                                    onClick={toggleMute}
                                    variant="outline"
                                    className={cn(
                                        "flex-1 h-13 rounded-xl border transition-all",
                                        isMuted ? "bg-rose-50 border-rose-200 text-rose-500 hover:bg-rose-100" : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                                    )}
                                >
                                    {isMuted ? <MicOff size={16} className="mr-2" /> : <Mic size={16} className="mr-2" />}
                                    {isMuted ? 'Unmute' : 'Mute'}
                                </Button>
                                <Button
                                    onClick={endCall}
                                    className="flex-[2] h-13 rounded-xl bg-rose-500 hover:bg-rose-600 text-white font-semibold text-sm transition-all shadow-lg shadow-rose-200/50"
                                >
                                    <PhoneOff size={16} className="mr-2" /> End Call
                                </Button>
                            </div>
                        )}
                    </div>
                </div>



                {/* ── Cost Breakdown Table ────────────────────────────────────── */}
                {showCost && (
                    <div className="w-full mt-3 rounded-xl bg-slate-50 border border-slate-200 overflow-hidden text-[10px]">
                        <div className="bg-slate-100 px-3 py-2 border-b border-slate-200 font-semibold text-slate-700 flex justify-between">
                            <span>Cost Details</span>
                            <span className="text-emerald-600">${liveCost.toFixed(5)}</span>
                        </div>

                        <div className="flex flex-col">
                            <div className="flex justify-between px-3 py-1.5 border-b border-slate-100">
                                <span className="text-slate-500">Realtime Audio In</span>
                                <span className="font-mono text-slate-600">${((usageRef.current.audioInput * RT_AUDIO_IN) / 1000000).toFixed(5)}</span>
                            </div>
                            <div className="flex justify-between px-3 py-1.5 border-b border-slate-100">
                                <span className="text-slate-500">Realtime Audio Out</span>
                                <span className="font-mono text-slate-600">${((usageRef.current.audioOutput * RT_AUDIO_OUT) / 1000000).toFixed(5)}</span>
                            </div>
                            <div className="flex justify-between px-3 py-1.5 border-b border-slate-100">
                                <span className="text-slate-500">Realtime Text In/Out</span>
                                <span className="font-mono text-slate-600">${(((usageRef.current.textInput * RT_TEXT_IN) + (usageRef.current.textOutput * RT_TEXT_OUT)) / 1000000).toFixed(5)}</span>
                            </div>
                            {(usageRef.current.escalationPromptTokens > 0 || usageRef.current.escalationCompletionTokens > 0) && (
                                <div className="flex justify-between px-3 py-1.5 bg-violet-50/50">
                                    <span className="text-violet-600 font-medium flex items-center gap-1"><Brain size={10} /> Advanced Analysis</span>
                                    <span className="font-mono text-violet-700">${(((usageRef.current.escalationPromptTokens * GPT4O_TEXT_IN) + (usageRef.current.escalationCompletionTokens * GPT4O_TEXT_OUT)) / 1000000).toFixed(5)}</span>
                                </div>

                            )}
                            {(usageRef.current.escalationMiniPromptTokens > 0 || usageRef.current.escalationMiniCompletionTokens > 0) && (
                                <div className="flex justify-between px-3 py-1.5 bg-indigo-50/50">
                                    <span className="text-indigo-600 font-medium flex items-center gap-1"><Brain size={10} /> Standard Thinking</span>
                                    <span className="font-mono text-indigo-700">${(((usageRef.current.escalationMiniPromptTokens * MINI_TEXT_IN) + (usageRef.current.escalationMiniCompletionTokens * MINI_TEXT_OUT)) / 1000000).toFixed(5)}</span>
                                </div>

                            )}
                            {(usageRef.current.filterPromptTokens > 0 || usageRef.current.filterCompletionTokens > 0) && (
                                <div className="flex justify-between px-3 py-1.5 bg-sky-50/50 border-t border-sky-100">
                                    <span className="text-sky-600 font-medium flex items-center gap-1 text-[9px] uppercase tracking-tighter italic">Response Filter</span>
                                    <span className="font-mono text-sky-700 font-bold">${(((usageRef.current.filterPromptTokens * MINI_TEXT_IN) + (usageRef.current.filterCompletionTokens * MINI_TEXT_OUT)) / 1000000).toFixed(5)}</span>
                                </div>
                            )}
                            {usageRef.current.memoryTokens > 0 && (
                                <div className="flex justify-between px-3 py-1.5 bg-emerald-50/50 border-t border-emerald-100">
                                    <span className="text-emerald-600 font-medium flex items-center gap-1"><BookOpen size={10} /> Learned Knowledge</span>
                                    <span className="font-mono text-emerald-700">${((usageRef.current.memoryTokens * MINI_TEXT_OUT) / 1000000).toFixed(5)}</span>
                                </div>

                            )}
                        </div>
                    </div>
                )}

            </div> {/* End Left Column */}

            {/* ── Right Column: Transcripts & Guide ─────────────────────────────── */}
            <div className="w-full max-w-lg flex flex-col gap-5">

                {/* ── Testing Guide Panel ─────────────────────────────────── */}
                <div className="w-full rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700 shadow-xl overflow-hidden text-white">
                    <div className="px-5 py-4 border-b border-slate-700/50 bg-slate-900/50">
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-sky-500/20 flex items-center justify-center text-sky-400">
                                <Zap size={16} />
                            </div>
                            <div>
                                <h3 className="text-xs font-black uppercase tracking-[0.1em] text-sky-400">Quick Testing Guide</h3>
                                <p className="text-[10px] text-slate-400 font-medium">Click sections to expand testing instructions</p>
                            </div>
                        </div>
                    </div>

                    <div className="divide-y divide-slate-700/50">
                        {/* Section 01: Advanced Brain */}
                        <details className="group" open>
                            <summary className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-white/5 transition-colors list-none">
                                <div className="flex items-center gap-3">
                                    <span className="text-sky-400 text-[10px] font-black w-4">01</span>
                                    <span className="text-[11px] font-bold text-slate-100">Trigger Advanced Brain</span>
                                </div>
                                <div className="text-slate-500 group-open:rotate-180 transition-transform">
                                    <ArrowDown size={12} />
                                </div>
                            </summary>
                            <div className="px-5 pb-4 pt-1 ml-7 border-l border-sky-400/20">
                                <p className="text-[10px] text-slate-400 leading-relaxed italic mb-2">Forces the agent into "Deep Analysis" mode for complex math, comparisons, and logic.</p>
                                <div className="space-y-3 overflow-y-auto max-h-[250px] pr-2 custom-scrollbar">

                                    {/* Quick Logic & Analysis */}
                                    <div className="space-y-1.5">
                                        <p className="text-[9px] text-sky-400 font-bold uppercase tracking-widest pl-1">Logic & Analysis</p>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Compare the pros and cons of electric versus gas vehicles."
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Explain the difference between a Roth IRA and a traditional IRA in very simple terms."
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "I have a 5-liter jug and a 3-liter jug, and an unlimited supply of water. How do I measure exactly 4 liters?"
                                        </div>
                                    </div>

                                    {/* Business & Strategy */}
                                    <div className="space-y-1.5">
                                        <p className="text-[9px] text-sky-400 font-bold uppercase tracking-widest pl-1">Strategy & Professional</p>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Draft a polite but firm email to a client named Sarah who is two weeks late paying her invoice."
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "What are three unconventional go-to-market strategies for a B2B SaaS startup with zero marketing budget?"
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Help me prepare for an interview for a Senior Product Manager role. What are the hardest questions they will ask?"
                                        </div>
                                    </div>

                                    {/* Complex Math */}
                                    <div className="space-y-1.5">
                                        <p className="text-[9px] text-sky-400 font-bold uppercase tracking-widest pl-1">Math & Finance</p>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "What is 15% of 6,450?"
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "If I invest $500 a month at a 7% return over 10 years, roughly how much will I have?"
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Calculate the break-even point: Fixed costs are $10,000, product sells for $50, variable cost per unit is $30."
                                        </div>
                                    </div>

                                    {/* Nuance & Creative */}
                                    <div className="space-y-1.5">
                                        <p className="text-[9px] text-sky-400 font-bold uppercase tracking-widest pl-1">Creative Nuance</p>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Translate the concept of 'Schadenfreude' into a business context using a short analogy."
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Give me a recipe for a vegan chocolate cake, but explain it like you are a strict drill sergeant."
                                        </div>
                                    </div>

                                    {/* Extreme Edge Cases */}
                                    <div className="space-y-1.5">
                                        <p className="text-[9px] text-sky-400 font-bold uppercase tracking-widest pl-1">Extreme Edge Cases</p>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "If I have a cube made of 27 smaller cubes (3x3x3), and I paint the entire outside of the large cube red, how many of the small cubes have exactly two sides painted?"
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Explain quantum entanglement using only terms and concepts from medieval blacksmithing."
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Write a haiku where the first letter of each word spells out the word 'MACHINE'."
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "Perform a Fermi estimation to guess how many piano tuners there are in Chicago right now. Walk me through the math aloud."
                                        </div>
                                        <div className="text-[10px] bg-sky-500/10 text-sky-300 p-2 rounded-lg border border-sky-500/20">
                                            "I am traveling at 0.99c away from someone who is stationary. From my perspective, is their clock ticking faster or slower than mine, and why?"
                                        </div>
                                    </div>

                                    {/* Insane Complexity */}
                                    <div className="space-y-1.5">
                                        <p className="text-[9px] text-violet-400 font-bold uppercase tracking-widest pl-1">Insane Complexity (Forces GPT-4o)</p>
                                        <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                            "Analyze the geopolitical implications of a sudden ban on lithium exports from South America, and format your final prediction as a 3-part structured thesis."
                                        </div>
                                        <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                            "A train leaves New York at 60mph. Another leaves Boston at 80mph. The distance is 215 miles. A bird flies back and forth between the trains at 100mph until they crash. What total distance does the bird fly?"
                                        </div>
                                        <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                            "If x + 1/x = 3, calculate the value of x to the power of 7, plus 1 over x to the power of 7. Walk me through the recursive step."
                                        </div>
                                        <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                            "A number ending in 5 becomes 4 times larger if the 5 is moved to the front. What is the smallest such positive integer? This is a modular arithmetic puzzle."
                                        </div>
                                        <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                            "Derive the volume of the intersection of two identical cylinders of radius 1 that intersect at a right angle. Explain the integration method."
                                        </div>
                                        <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                            "Debate both sides of whether artificial general intelligence should be granted legal personhood, but argue the affirmative side in the style of Socrates."
                                        </div>
                                    </div>

                                </div>

                            </div>


                        </details>

                        {/* Section 02: Learned Memory */}
                        <details className="group">
                            <summary className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-white/5 transition-colors list-none">
                                <div className="flex items-center gap-3">
                                    <span className="text-violet-400 text-[10px] font-black w-4">02</span>
                                    <span className="text-[11px] font-bold text-slate-100">Test Learned Memory</span>
                                </div>
                                <div className="text-slate-500 group-open:rotate-180 transition-transform">
                                    <ArrowDown size={12} />
                                </div>
                            </summary>
                            <div className="px-5 pb-4 pt-1 ml-7 border-l border-violet-400/20">
                                <p className="text-[10px] text-amber-300/80 font-bold mb-2 uppercase tracking-tighter flex items-center gap-1"><Zap size={10} /> Requirement: "Remember Facts" must be ON</p>
                                <p className="text-[10px] text-slate-400 leading-relaxed italic mb-2">Teach the agent facts throughout the call and verify they stick.</p>
                                <div className="space-y-1.5 overflow-y-auto max-h-[160px] pr-2 custom-scrollbar">
                                    <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                        1. "Hey, my name is Alex and my favorite color is Blue."
                                    </div>
                                    <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                        2. "Also, I have a golden retriever named Buster."
                                    </div>
                                    <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                        3. "Please remind me to buy dog food later during this call."
                                    </div>
                                    <div className="text-[10px] bg-violet-500/10 text-violet-300 p-[1px] my-1" />
                                    <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest text-center mt-1 mb-1">Wait 2 minutes, then ask:</p>
                                    <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                        "What was that thing I needed to remember to buy?"
                                    </div>
                                    <div className="text-[10px] bg-violet-500/10 text-violet-300 p-2 rounded-lg border border-violet-500/20">
                                        "Do you remember my dog's name and my favorite color?"
                                    </div>
                                </div>
                            </div>

                        </details>

                        {/* Section 03: Natural Proactive Voice */}
                        <details className="group">
                            <summary className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-white/5 transition-colors list-none">
                                <div className="flex items-center gap-3">
                                    <span className="text-emerald-400 text-[10px] font-black w-4">03</span>
                                    <span className="text-[11px] font-bold text-slate-100">Natural Proactive Flow</span>
                                </div>
                                <div className="text-slate-500 group-open:rotate-180 transition-transform">
                                    <ArrowDown size={12} />
                                </div>
                            </summary>
                            <div className="px-5 pb-4 pt-1 ml-7 border-l border-emerald-400/20">
                                <p className="text-[10px] text-slate-400 leading-relaxed italic mb-3">Silent waiting simulates a real person checking in.</p>
                                <div className="text-[10px] bg-emerald-500/10 text-emerald-300 p-2 rounded-lg border border-emerald-500/20 flex items-center gap-2">
                                    <Activity size={10} /> Stay silent for 15 seconds.
                                </div>
                            </div>
                        </details>

                        {/* Section 04: Weather & Time Tools */}
                        <details className="group">
                            <summary className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-white/5 transition-colors list-none">
                                <div className="flex items-center gap-3">
                                    <span className="text-amber-400 text-[10px] font-black w-4">04</span>
                                    <span className="text-[11px] font-bold text-slate-100">Test Real-Time Tools</span>
                                </div>
                                <div className="text-slate-500 group-open:rotate-180 transition-transform">
                                    <ArrowDown size={12} />
                                </div>
                            </summary>
                            <div className="px-5 pb-4 pt-1 ml-7 border-l border-amber-400/20">
                                <p className="text-[10px] text-slate-400 leading-relaxed italic mb-2">Check how it grabs real-time data seamlessly.</p>
                                <div className="space-y-1.5">
                                    <div className="text-[10px] bg-amber-500/10 text-amber-300 p-2 rounded-lg border border-amber-500/20">
                                        "What time is it right now?"
                                    </div>
                                    <div className="text-[10px] bg-amber-500/10 text-amber-300 p-2 rounded-lg border border-amber-500/20">
                                        "What's the weather like in Tokyo?"
                                    </div>
                                </div>
                            </div>
                        </details>

                        {/* Section 05: Smart Interruptions */}
                        <details className="group">
                            <summary className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-white/5 transition-colors list-none">
                                <div className="flex items-center gap-3">
                                    <span className="text-pink-400 text-[10px] font-black w-4">05</span>
                                    <span className="text-[11px] font-bold text-slate-100">Smart Interruptions</span>
                                </div>
                                <div className="text-slate-500 group-open:rotate-180 transition-transform">
                                    <ArrowDown size={12} />
                                </div>
                            </summary>
                            <div className="px-5 pb-4 pt-1 ml-7 border-l border-pink-400/20">
                                <p className="text-[10px] text-slate-400 leading-relaxed italic mb-2">Notice how it handles you speaking while it thinks.</p>
                                <div className="text-[10px] bg-pink-500/10 text-pink-300 p-2 rounded-lg border border-pink-500/20">
                                    Ask a math question, then immediately say "Wait, add 50 to that" before it answers.
                                </div>
                            </div>
                        </details>

                    </div>
                </div>


                {/* Active Context Container */}

                <div className="w-full flex-1 max-h-[500px] overflow-y-auto rounded-2xl bg-white border border-slate-200 shadow-sm p-4 flex flex-col space-y-3">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest flex items-center gap-1.5">
                            <Activity size={12} className="text-emerald-500" />
                            Current Conversation
                        </h3>

                        <div className="flex items-center gap-3">
                            <span className="text-[10px] text-slate-400">{logs.filter(l => l.text && l.text !== '— call started —' && (l.pending || !l.id || activeItemIds.includes(l.id))).length} total</span>
                            {activeItemIds.length > KEEP_ITEMS && (
                                <span className="text-[10px] font-bold text-amber-500 animate-pulse bg-amber-50 px-2 py-0.5 rounded-full border border-amber-100 leading-none">
                                    -{activeItemIds.length - KEEP_ITEMS} Next Prune
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="space-y-2.5 flex-1 overflow-y-auto pr-1">
                        {(() => {
                            const activeLogs = logs.filter(l => l.text && l.text !== '— call started —' && (l.pending || !l.id || activeItemIds.includes(l.id)));
                            const pruneThreshold = activeItemIds.length - KEEP_ITEMS;

                            return activeLogs.length === 0 ? (
                                <div className="text-[11px] text-slate-400 italic py-2 text-center">No active context yet.</div>
                            ) : (
                                activeLogs.map((log, i) => {
                                    const isAboutToPrune = !log.pending && log.id && activeItemIds.indexOf(log.id) < pruneThreshold;
                                    return (
                                        <div key={i} className={cn(
                                            "flex justify-between items-start gap-2 w-full group relative",
                                            isAboutToPrune && "opacity-60"
                                        )}>
                                            <div className="flex gap-2 items-start flex-1 min-w-0">
                                                <span className={cn(
                                                    "text-[10px] font-bold mt-0.5 shrink-0 w-6 text-right",
                                                    log.role === 'model' ? "text-sky-500" : "text-slate-500"
                                                )}>
                                                    {log.role === 'model' ? 'AI' : 'You'}
                                                </span>
                                                <span className={cn(
                                                    "text-[12px] leading-relaxed transition-all break-words min-w-0",
                                                    log.pending ? "text-slate-400 italic" : "text-slate-700",
                                                    log.escalated && "text-violet-700",
                                                    log.interrupted && "line-through text-slate-400"
                                                )}>
                                                    {log.escalated && <span className="mr-1 text-violet-400">🧠</span>}
                                                    {log.text || '…'}
                                                </span>
                                            </div>
                                            {isAboutToPrune && (
                                                <span className="shrink-0 mt-0.5 text-[8px] text-amber-500 font-bold uppercase tracking-tighter bg-amber-50 px-1 rounded" title="This message will be removed in the next pruning cycle">Lining Up —&gt;</span>
                                            )}
                                        </div>
                                    );
                                })
                            );
                        })()}
                        <div className="h-1" />
                    </div>
                </div>

                {/* User-Only History Container */}
                <div className="w-full max-h-56 overflow-y-auto rounded-xl bg-slate-50 border border-slate-200 p-4 flex flex-col space-y-3">
                    <div className="flex flex-col pb-2 border-b border-slate-100 gap-1 mt-1">
                        <div className="flex items-center justify-between">
                            <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                                <Mic size={10} className="text-slate-400" />
                                My Message Journey
                            </h3>
                            <div className="flex items-center gap-2">
                                <span className="text-[9px] font-mono text-slate-400 bg-slate-200 px-1.5 py-0.5 rounded-full">
                                    {logs.filter(l => l.role === 'user' && l.text && !!l.id && !l.pending && !activeItemIds.includes(l.id)).length} Pruned
                                </span>
                                <span className="text-[9px] font-mono text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full border border-emerald-100">
                                    {logs.filter(l => l.role === 'user' && l.text && (l.pending || activeItemIds.includes(l.id))).length} Live
                                </span>
                            </div>
                        </div>
                        <p className="text-[9px] text-slate-400 italic">
                            * To keep the agent fast, older messages are <strong>"Pruned"</strong> (removed from active memory buffer), while new messages stay <strong>"Live"</strong>.
                        </p>
                    </div>

                    <div className="space-y-2 overflow-y-auto pr-1">
                        {(() => {
                            const userLogs = logs.filter(l => l.role === 'user' && l.text && l.text !== '— call started —');
                            return userLogs.length === 0 ? (
                                <div className="text-[11px] text-slate-400 italic py-2 text-center">Your speech history will appear here.</div>
                            ) : (
                                userLogs.map((log, i) => {
                                    const isPruned = !!log.id && !log.pending && !activeItemIds.includes(log.id);
                                    return (
                                        <div key={i} className={cn(
                                            "flex items-center gap-3 transition-opacity",
                                            isPruned ? "opacity-50" : "opacity-100"
                                        )}>
                                            <div className="flex flex-col items-center gap-1 shrink-0 w-8">
                                                {isPruned ? (
                                                    <span className="text-[8px] bg-slate-200 text-slate-500 px-1 rounded font-bold uppercase tracking-tighter">PRUNED</span>
                                                ) : (
                                                    <span className="text-[8px] bg-emerald-100 text-emerald-600 px-1 rounded font-bold uppercase tracking-tighter">LIVE</span>
                                                )}
                                            </div>
                                            <span className="text-[11px] text-slate-600 leading-relaxed break-words min-w-0 flex-1">
                                                {log.text}
                                            </span>
                                        </div>
                                    );
                                })
                            );
                        })()}
                    </div>
                </div>

            </div>


        </div>
    );
}