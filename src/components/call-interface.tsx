'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Phone, PhoneOff, Mic, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import hark from 'hark';

type Agent = {
    id: string;
    name: string;
    systemInstruction: string;
    voiceId?: string | null;
};

export type TokenUsage = {
    textInput: number;
    audioInput: number;
    textOutput: number;
    audioOutput: number;
};

export type CallSummary = {
    id: string;
    durationSeconds: number;
    tokens: TokenUsage;
    cost: number;
    date: string;
};

export default function CallInterface({
    agent,
    autoStart = false,
    isInbound = false,
    scriptContent,
    onCallEnd,
}: {
    agent: Agent;
    autoStart?: boolean;
    isInbound?: boolean;
    scriptContent?: string;
    onCallEnd?: (summary: CallSummary) => void;
}) {
    // UI State (REMOVED: Socket, Session)
    const [isCallActive, setIsCallActive] = useState(false);
    const [isStarting, setIsStarting] = useState(false);
    const [status, setStatus] = useState('Off');
    const [logs, setLogs] = useState<{ id: string; role: 'user' | 'model'; text: string; isFinal: boolean }[]>([]);
    const [isAiSpeaking, setIsAiSpeaking] = useState(false);
    const [volume, setVolume] = useState(0);

    // Engine Refs
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const dcRef = useRef<RTCDataChannel | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioElRef = useRef<HTMLAudioElement | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const logsRef = useRef<{ id: string; role: 'user' | 'model'; text: string; isFinal: boolean }[]>([]);
    const startTimeRef = useRef<number | null>(null);

    // Control Refs
    const usageRef = useRef<TokenUsage>({
        textInput: 0,
        audioInput: 0,
        textOutput: 0,
        audioOutput: 0
    });
    const isCallEndingRef = useRef(false);
    const hasSavedRef = useRef(false);
    const isStartingRef = useRef(false);
    const abortControllerRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (autoStart || isInbound) {
            startCall();
        }
        return () => {
            if (isStartingRef.current) {
                abortControllerRef.current?.abort();
            }
            endCall();
        };
    }, []);

    const startCall = async () => {
        if (isStartingRef.current || isStarting || isCallActive) return;

        console.log(`[CallInterface-TEST] Starting call for ${agent.name}... `);
        isStartingRef.current = true;
        setIsStarting(true);
        isCallEndingRef.current = false;
        hasSavedRef.current = false;

        abortControllerRef.current = new AbortController();
        const { signal } = abortControllerRef.current;
        startTimeRef.current = Date.now();
        usageRef.current = { textInput: 0, audioInput: 0, textOutput: 0, audioOutput: 0 };

        try {
            setStatus('Initializing...');

            // 1. Get Ephemeral Token
            const tokenResponse = await fetch('/api/realtime-token', {
                method: 'POST',
                signal,
                body: JSON.stringify({ voice: agent.voiceId || 'alloy', model: 'gpt-4o-realtime-preview-2024-12-17' }),
                headers: { 'Content-Type': 'application/json' }
            });
            if (signal.aborted) throw new Error('Aborted');

            const tokenData = await tokenResponse.json();
            if (tokenData.error) throw new Error(tokenData.error);
            const EPHEMERAL_KEY = tokenData.client_secret.value;

            // 2. Setup Peer Connection
            const pc = new RTCPeerConnection();
            pcRef.current = pc;

            const audioEl = document.createElement('audio');
            audioEl.autoplay = true;
            audioElRef.current = audioEl;
            pc.ontrack = (e) => audioEl.srcObject = e.streams[0];

            // 3. Microphone
            const ms = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000,
                    channelCount: 1
                }
            });
            if (signal.aborted) {
                ms.getTracks().forEach(t => t.stop());
                throw new Error('Aborted');
            }
            streamRef.current = ms;
            pc.addTrack(ms.getTracks()[0]);

            // 4. Data Channel
            const dc = pc.createDataChannel('oai-events');
            dcRef.current = dc;

            dc.addEventListener('message', (e) => {
                const event = JSON.parse(e.data);
                handleRealtimeEvent(event);
            });

            dc.addEventListener('open', () => {
                console.log('Realtime Data Channel Open');
                setStatus('Connected');

                // Session Config
                const sessionConfig = {
                    type: 'session.update',
                    session: {
                        instructions: agent.systemInstruction,
                        input_audio_transcription: { model: 'whisper-1' },
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.5,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 800
                        },
                        modalities: ["text", "audio"],
                        voice: agent.voiceId || 'alloy'
                    }
                };
                dc.send(JSON.stringify(sessionConfig));

                // Greeting
                setTimeout(() => {
                    const instructions = scriptContent 
                        ? `Start by reading this script: ${scriptContent}` 
                        : `Start the conversation by introducing yourself as ${agent.name}.`;

                    dc.send(JSON.stringify({
                        type: "response.create",
                        response: { instructions }
                    }));

                    setLogs([{ id: 'call-start', role: 'user', text: `(Call Started)`, isFinal: true }]);
                }, 50);
            });

            // 5. Connect via WebRTC
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            const baseUrl = "https://api.openai.com/v1/realtime";
            const model = "gpt-4o-realtime-preview-2024-12-17";
            const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
                method: "POST",
                body: offer.sdp,
                signal,
                headers: {
                    Authorization: `Bearer ${EPHEMERAL_KEY}`,
                    "Content-Type": "application/sdp",
                },
            });
            if (signal.aborted) throw new Error('Aborted');

            const answer = { type: "answer" as const, sdp: await sdpResponse.text() };
            await pc.setRemoteDescription(answer);

            // 6. Visualizer
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(ms);
            const analyser = audioCtx.createAnalyser();
            source.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const updateVolume = () => {
                if (isCallEndingRef.current) return;
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < 50; i++) sum += dataArray[i];
                setVolume(sum / 50);
                animationFrameRef.current = requestAnimationFrame(updateVolume);
            };
            updateVolume();

            setStatus('Listening...');
            setIsCallActive(true);
            setIsStarting(false);
            isStartingRef.current = false;

        } catch (err: any) {
            console.error("[CallInterface-TEST] Connection Failed:", err);
            setStatus('Connection Failed');
            endCall();
            setIsStarting(false);
            isStartingRef.current = false;
        }
    };

    const handleRealtimeEvent = (event: any) => {
        switch (event.type) {
            case 'session.created': setStatus('Active'); break;
            case 'input_audio_buffer.speech_started':
                setIsAiSpeaking(false);
                setStatus('Listening...');
                break;
            case 'conversation.item.created':
                if (event.item.type === 'message') {
                    const id = event.item.id;
                    const role = event.item.role === 'assistant' ? 'model' : 'user';
                    setLogs(prev => [...prev, { id, role, text: '', isFinal: false }]);
                }
                break;
            case 'response.audio_transcript.delta':
                if (event.delta && event.item_id) {
                    setLogs(prev => prev.map(l => l.id === event.item_id ? { ...l, text: l.text + event.delta } : l));
                }
                break;
            case 'response.audio_transcript.done':
                if (event.transcript) {
                    setLogs(prev => prev.map(l => l.id === event.item_id ? { ...l, text: event.transcript, isFinal: true } : l));
                }
                break;
            case 'conversation.item.input_audio_transcription.completed':
                if (event.transcript) {
                    setLogs(prev => {
                        const existing = prev.find(l => l.id === event.item_id);
                        if (existing) {
                            return prev.map(l => l.id === event.item_id ? { ...l, text: event.transcript, isFinal: true } : l);
                        } else {
                            return [...prev, { id: event.item_id, role: 'user', text: event.transcript, isFinal: true }];
                        }
                    });
                }
                break;
            case 'response.output_item.added':
                setStatus('AI Speaking...');
                setIsAiSpeaking(true);
                break;
            case 'response.done':
                // Usage Tracking
                if (event.response?.usage) {
                    const usage = event.response.usage;
                    const inputDetails = usage.input_token_details || {};
                    const outputDetails = usage.output_token_details || {};

                    usageRef.current.textInput += (inputDetails.text_tokens || 0);
                    usageRef.current.audioInput += (inputDetails.audio_tokens || 0);
                    usageRef.current.textOutput += (outputDetails.text_tokens || 0);
                    usageRef.current.audioOutput += (outputDetails.audio_tokens || 0);
                }
                
                setIsAiSpeaking(false);
                setStatus('Listening...');
                break;
        }
    };

    const endCall = () => {
        console.log("[CallInterface-TEST] Ending call...");
        isCallEndingRef.current = true;
        setIsCallActive(false);
        const callDuration = startTimeRef.current ? Math.floor((Date.now() - startTimeRef.current) / 1000) : 0;
        
        // Calculate Cost
        const { textInput, audioInput, textOutput, audioOutput } = usageRef.current;
        const totalCost = 
            (textInput * 0.000005) +  // $5 / 1M
            (audioInput * 0.000040) + // $40 / 1M (was $100)
            (textOutput * 0.000020) + // $20 / 1M
            (audioOutput * 0.000080); // $80 / 1M (was $200)

        if (onCallEnd && pcRef.current) {
            onCallEnd({
                id: Math.random().toString(36).substring(7),
                durationSeconds: callDuration,
                tokens: usageRef.current,
                cost: totalCost,
                date: new Date().toLocaleString()
            });
        }

        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        if (pcRef.current) pcRef.current.close();
        if (dcRef.current) dcRef.current.close();
        if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
        setStatus('Ended');
        setTimeout(() => setStatus('Off'), 2000);
    };

    const [duration, setDuration] = useState(0);
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isCallActive) {
            setDuration(0);
            interval = setInterval(() => setDuration(prev => prev + 1), 1000);
        } else setDuration(0);
        return () => clearInterval(interval);
    }, [isCallActive]);

    const formatTime = (secs: number) => {
        const mins = Math.floor(secs / 60);
        const remainingSecs = secs % 60;
        return `${mins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
    };

    return (
        <div className="relative flex flex-col items-center justify-between w-full max-w-md h-[600px] px-8 py-10 bg-white shadow-2xl rounded-[2.5rem] overflow-hidden border border-slate-100">
            {/* Minimal UI - Exact same logic as original */}
            <div className={cn(
                "absolute top-0 left-1/2 -translate-x-1/2 w-[300px] h-[300px] bg-rose-200/30 rounded-full blur-[100px] transition-all duration-1000 pointer-events-none",
                isCallActive ? "opacity-100 scale-100" : "opacity-0 scale-50"
            )} />

            <div className="w-full flex justify-center z-10">
                <div className={cn(
                    "px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-colors duration-500 flex items-center gap-2",
                    isCallActive ? "bg-rose-50 text-rose-600" : "bg-slate-50 text-slate-400"
                )}>
                    <div className={cn("w-2 h-2 rounded-full", isCallActive ? "bg-rose-500 animate-pulse" : "bg-slate-300")} />
                    {isCallActive ? "Live (Realtime)" : "Ready to Test"}
                </div>
            </div>

            <div className="flex flex-col items-center space-y-8 z-10 mt-8">
                <div className="relative">
                    <div className="relative w-32 h-32 rounded-full bg-gradient-to-br from-slate-50 to-white border border-slate-100 shadow-xl flex items-center justify-center overflow-hidden z-20">
                        <div className="text-4xl">🤖</div>
                    </div>
                </div>
                <div className="text-center space-y-2">
                    <h2 className="text-2xl font-bold text-slate-900">{agent.name}</h2>
                    <p className="text-sm font-medium text-slate-500">{status}</p>
                    {isCallActive && (
                        <div className="text-3xl font-light text-slate-700 font-mono tracking-tight pt-2">
                            {formatTime(duration)}
                        </div>
                    )}
                </div>
            </div>

            <div className="w-full z-10 pb-6">
                {!isCallActive ? (
                    <Button
                        onClick={startCall}
                        disabled={isStarting}
                        className="w-full h-16 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-lg"
                    >
                        {isStarting ? "Connecting..." : "Start Call"}
                    </Button>
                ) : (
                    <Button
                        onClick={endCall}
                        className="w-full h-16 rounded-2xl bg-rose-500 hover:bg-rose-600 text-white font-bold text-lg"
                    >
                        <PhoneOff size={24} className="mr-2" /> End Call
                    </Button>
                )}
            </div>

            {/* Logs Preview for Testing */}
            <div className="w-full max-h-24 overflow-y-auto text-[10px] text-slate-400 font-mono z-10 bg-slate-50 p-2 rounded">
                {logs.slice(-3).map((log, i) => (
                    <div key={i}>{log.role === 'model' ? 'AI: ' : 'You: '}{log.text}</div>
                ))}
            </div>
        </div>
    );
}
