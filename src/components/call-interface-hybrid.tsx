'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { PhoneOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import hark from 'hark';

type Agent = { id: string; name: string; systemInstruction: string; voiceId?: string | null };
type Phase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export type HybridUsage = {
    whisperMinutes: number;
    promptTokens: number;
    completionTokens: number;
    ttsCharacters: number;
};

export type HybridCallSummary = {
    id: string;
    durationSeconds: number;
    usage: HybridUsage;
    cost: number;
    date: string;
    turns: number;
};

const WHISPER_PER_MIN = 0.006;
const GPT4O_IN_PER_1M = 5.0;
const GPT4O_OUT_PER_1M = 15.0;
const TTS1_PER_1M_CHARS = 15.0;

const PHASE_LABEL: Record<Phase, string> = {
    idle: 'Ready',
    listening: 'Listening...',
    transcribing: 'Transcribing...',
    thinking: 'Thinking...',
    speaking: 'Speaking...',
};

const PHASE_DOT: Record<Phase, string> = {
    idle: 'bg-slate-300',
    listening: 'bg-emerald-500 animate-pulse',
    transcribing: 'bg-blue-500 animate-pulse',
    thinking: 'bg-violet-500 animate-pulse',
    speaking: 'bg-amber-500 animate-pulse',
};

const PHASE_BADGE: Record<Phase, string> = {
    idle: 'bg-slate-50 text-slate-400',
    listening: 'bg-emerald-50 text-emerald-700',
    transcribing: 'bg-blue-50 text-blue-700',
    thinking: 'bg-violet-50 text-violet-700',
    speaking: 'bg-amber-50 text-amber-700',
};

const PIPELINE_STEPS = [
    { key: 'listening', label: 'Whisper', sub: 'STT' },
    { key: 'thinking',  label: 'GPT-4o',  sub: 'LLM' },
    { key: 'speaking',  label: 'TTS-1',   sub: 'Voice' },
] as const;

export default function CallInterfaceHybrid({
    agent,
    onCallEnd,
}: {
    agent: Agent;
    onCallEnd?: (s: HybridCallSummary) => void;
}) {
    const [isCallActive, setIsCallActive]   = useState(false);
    const [isStarting, setIsStarting]       = useState(false);
    const [phase, setPhase]                 = useState<Phase>('idle');
    const [logs, setLogs]                   = useState<{ role: 'user' | 'ai'; text: string }[]>([]);
    const [duration, setDuration]           = useState(0);

    const streamRef        = useRef<MediaStream | null>(null);
    const mediaRecRef      = useRef<MediaRecorder | null>(null);
    const chunksRef        = useRef<Blob[]>([]);
    const harkRef          = useRef<ReturnType<typeof hark> | null>(null);
    const audioRef         = useRef<HTMLAudioElement | null>(null);
    const convRef          = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);
    const usageRef         = useRef<HybridUsage>({ whisperMinutes: 0, promptTokens: 0, completionTokens: 0, ttsCharacters: 0 });
    const startTimeRef     = useRef<number | null>(null);
    const turnsRef         = useRef(0);
    const endingRef        = useRef(false);
    const recordingRef     = useRef(false);
    const speakingRef      = useRef(false);

    useEffect(() => () => { endCall(); }, []);

    useEffect(() => {
        let t: NodeJS.Timeout;
        if (isCallActive) { setDuration(0); t = setInterval(() => setDuration(p => p + 1), 1000); }
        return () => clearInterval(t);
    }, [isCallActive]);

    /* ── start / end ─────────────────────────────── */

    const startCall = async () => {
        if (isStarting || isCallActive) return;
        setIsStarting(true);
        endingRef.current   = false;
        recordingRef.current = false;
        speakingRef.current = false;
        convRef.current     = [];
        turnsRef.current    = 0;
        usageRef.current    = { whisperMinutes: 0, promptTokens: 0, completionTokens: 0, ttsCharacters: 0 };
        startTimeRef.current = Date.now();

        try {
            const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
            streamRef.current = ms;
            setIsCallActive(true);
            setIsStarting(false);
            await doGreeting();
        } catch (e) {
            console.error('Mic error:', e);
            setIsStarting(false);
        }
    };

    const endCall = () => {
        endingRef.current   = true;
        speakingRef.current = false;
        recordingRef.current = false;

        harkRef.current?.stop();      harkRef.current = null;
        audioRef.current?.pause();    audioRef.current = null;

        if (mediaRecRef.current?.state !== 'inactive') mediaRecRef.current?.stop();
        streamRef.current?.getTracks().forEach(t => t.stop());

        const dur = startTimeRef.current ? Math.floor((Date.now() - startTimeRef.current) / 1000) : 0;
        const { whisperMinutes, promptTokens, completionTokens, ttsCharacters } = usageRef.current;
        const cost =
            whisperMinutes * WHISPER_PER_MIN +
            (promptTokens * GPT4O_IN_PER_1M + completionTokens * GPT4O_OUT_PER_1M) / 1_000_000 +
            ttsCharacters * TTS1_PER_1M_CHARS / 1_000_000;

        if (onCallEnd && dur > 0) {
            onCallEnd({ id: Math.random().toString(36).slice(2, 9), durationSeconds: dur, usage: { ...usageRef.current }, cost, date: new Date().toLocaleString(), turns: turnsRef.current });
        }

        setIsCallActive(false);
        setPhase('idle');
        setLogs([]);
    };

    /* ── greeting ────────────────────────────────── */

    const doGreeting = async () => {
        const greetMsg = [{ role: 'user' as const, content: `Greet the user and introduce yourself as ${agent.name}. Ask how you can help.` }];
        await callLLM(greetMsg, true);
    };

    /* ── listening (hark VAD) ────────────────────── */

    const startListening = () => {
        if (endingRef.current || !streamRef.current) return;
        setPhase('listening');

        const harker = hark(streamRef.current, { threshold: -65, interval: 80 });
        harkRef.current = harker;

        harker.on('speaking', () => {
            if (endingRef.current || speakingRef.current || recordingRef.current) return;
            startRecording();
        });

        harker.on('stopped_speaking', () => {
            if (endingRef.current || !recordingRef.current) return;
            stopAndProcess();
        });
    };

    /* ── recording ───────────────────────────────── */

    const startRecording = () => {
        if (!streamRef.current || recordingRef.current) return;
        recordingRef.current = true;
        chunksRef.current = [];

        try {
            // Let the browser pick its own supported codec — avoids NotSupportedError
            const rec = new MediaRecorder(streamRef.current);
            mediaRecRef.current = rec;
            rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
            rec.start(100);
        } catch (e) {
            console.error('MediaRecorder failed to start:', e);
            recordingRef.current = false;
            startListening();
        }
    };

    const stopAndProcess = async () => {
        if (!mediaRecRef.current || !recordingRef.current) return;
        recordingRef.current = false;

        await new Promise<void>(res => { mediaRecRef.current!.onstop = () => res(); mediaRecRef.current!.stop(); });
        harkRef.current?.stop(); harkRef.current = null;

        const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || 'audio/webm' });
        if (blob.size < 2000) { startListening(); return; } // too short = silence/noise

        await transcribeAndRespond(blob);
    };

    /* ── STT ─────────────────────────────────────── */

    const transcribeAndRespond = async (blob: Blob) => {
        if (endingRef.current) return;
        setPhase('transcribing');

        try {
            const fd = new FormData();
            fd.append('audio', blob, 'rec.webm');
            const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
            const data = await res.json();

            if (!data.text?.trim()) { startListening(); return; }

            usageRef.current.whisperMinutes += (data.duration ?? 3) / 60;
            turnsRef.current++;
            setLogs(p => [...p, { role: 'user', text: data.text.trim() }]);
            convRef.current = [...convRef.current, { role: 'user', content: data.text.trim() }];

            await callLLM(convRef.current, false);
        } catch (e) {
            console.error('Whisper error:', e);
            startListening();
        }
    };

    /* ── LLM ─────────────────────────────────────── */

    const callLLM = async (messages: { role: 'user' | 'assistant'; content: string }[], isGreeting: boolean) => {
        if (endingRef.current) return;
        setPhase('thinking');

        try {
            const res = await fetch('/api/chat-voice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages, systemInstruction: agent.systemInstruction }),
            });
            const data = await res.json();
            if (data.error) { startListening(); return; }

            usageRef.current.promptTokens     += data.usage?.prompt_tokens ?? 0;
            usageRef.current.completionTokens += data.usage?.completion_tokens ?? 0;

            const aiText = data.text;
            setLogs(p => [...p, { role: 'ai', text: aiText }]);

            // For real turns (not greeting), store in conversation history
            if (!isGreeting) {
                convRef.current = [...convRef.current, { role: 'assistant', content: aiText }];
            } else {
                convRef.current = [{ role: 'assistant', content: aiText }];
            }

            await playTTS(aiText);
        } catch (e) {
            console.error('LLM error:', e);
            startListening();
        }
    };

    /* ── TTS ─────────────────────────────────────── */

    const playTTS = async (text: string) => {
        if (endingRef.current) return;
        setPhase('speaking');
        speakingRef.current = true;
        usageRef.current.ttsCharacters += text.length;

        try {
            const res = await fetch('/api/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice: agent.voiceId || 'alloy' }),
            });

            if (!res.ok) {
                console.error('TTS API error:', res.status, await res.text());
                return;
            }

            const rawBlob = await res.blob();
            // Explicitly set MIME type so the Audio element can decode it
            const audioBlob = new Blob([rawBlob], { type: 'audio/mpeg' });
            const url = URL.createObjectURL(audioBlob);
            const audio = new Audio(url);
            audioRef.current = audio;

            await new Promise<void>(resolve => {
                audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
                audio.onerror = (e) => {
                    console.error('Audio playback error:', e);
                    URL.revokeObjectURL(url);
                    resolve();
                };
                audio.play().catch(err => {
                    console.error('audio.play() rejected:', err);
                    resolve();
                });
            });
        } catch (e) {
            console.error('TTS error:', e);
        } finally {
            speakingRef.current = false;
            if (!endingRef.current) startListening();
        }
    };

    /* ── helpers ─────────────────────────────────── */

    const fmt = (s: number) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

    /* ── render ──────────────────────────────────── */

    return (
        <div className="relative flex flex-col items-center justify-between w-full max-w-md h-[600px] px-8 py-10 bg-white shadow-2xl rounded-[2.5rem] overflow-hidden border border-slate-100">
            {/* Glow */}
            <div className={cn(
                "absolute top-0 left-1/2 -translate-x-1/2 w-[300px] h-[300px] rounded-full blur-[100px] transition-all duration-1000 pointer-events-none",
                phase === 'listening'    ? "bg-emerald-200/40 opacity-100 scale-100" :
                phase === 'speaking'    ? "bg-amber-200/40 opacity-100 scale-100" :
                phase === 'thinking'    ? "bg-violet-200/40 opacity-100 scale-100" :
                phase === 'transcribing'? "bg-blue-200/40 opacity-100 scale-100" :
                "opacity-0 scale-50"
            )} />

            {/* Status badge */}
            <div className="w-full flex justify-center z-10">
                <div className={cn("px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide flex items-center gap-2 transition-colors duration-300", isCallActive ? PHASE_BADGE[phase] : "bg-slate-50 text-slate-400")}>
                    <div className={cn("w-2 h-2 rounded-full", isCallActive ? PHASE_DOT[phase] : "bg-slate-300")} />
                    {isCallActive ? PHASE_LABEL[phase] : 'Ready to Test'}
                </div>
            </div>

            {/* Avatar */}
            <div className="flex flex-col items-center space-y-6 z-10 mt-4">
                <div className="relative w-28 h-28 rounded-full bg-gradient-to-br from-emerald-50 to-white border border-emerald-100 shadow-xl flex items-center justify-center">
                    <div className="text-4xl">🤖</div>
                </div>
                <div className="text-center space-y-2">
                    <h2 className="text-2xl font-bold text-slate-900">{agent.name}</h2>
                    {isCallActive && <div className="text-2xl font-light text-slate-700 font-mono">{fmt(duration)}</div>}
                </div>

                {/* Pipeline indicator */}
                <div className="flex items-center gap-1 mt-1">
                    {PIPELINE_STEPS.map((step, i) => {
                        const active = (step.key === 'listening' && (phase === 'listening' || phase === 'transcribing')) ||
                                       (step.key === 'thinking'  && phase === 'thinking') ||
                                       (step.key === 'speaking'  && phase === 'speaking');
                        return (
                            <div key={step.key} className="flex items-center gap-1">
                                <div className={cn("flex flex-col items-center px-3 py-1.5 rounded-lg text-center transition-all duration-300", active ? "bg-emerald-100 text-emerald-700 scale-105 shadow-sm" : "bg-slate-50 text-slate-400")}>
                                    <span className="text-[10px] font-bold">{step.label}</span>
                                    <span className="text-[9px]">{step.sub}</span>
                                </div>
                                {i < PIPELINE_STEPS.length - 1 && <span className="text-slate-300 text-xs">→</span>}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Button */}
            <div className="w-full z-10 pb-4">
                {!isCallActive ? (
                    <Button onClick={startCall} disabled={isStarting} className="w-full h-14 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-base">
                        {isStarting ? 'Connecting...' : 'Start Hybrid Call'}
                    </Button>
                ) : (
                    <Button onClick={endCall} className="w-full h-14 rounded-2xl bg-rose-500 hover:bg-rose-600 text-white font-bold text-base">
                        <PhoneOff size={20} className="mr-2" /> End Call
                    </Button>
                )}
            </div>

            {/* Logs */}
            <div className="w-full max-h-20 overflow-y-auto text-[10px] text-slate-400 font-mono z-10 bg-slate-50 p-2 rounded">
                {logs.slice(-3).map((l, i) => <div key={i}>{l.role === 'ai' ? 'AI: ' : 'You: '}{l.text}</div>)}
            </div>
        </div>
    );
}
