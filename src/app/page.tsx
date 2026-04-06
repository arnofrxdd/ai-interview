'use client';

import { useState } from 'react';
import CallInterface, { CallSummary } from '@/components/call-interface';
// import CallInterfaceHybrid, { HybridCallSummary } from '@/components/call-interface-hybrid';

import CallInterfaceSmart, { SmartCallSummary } from '@/components/call-interface-smart';

type Tab = 'realtime' | 'smart' | 'compare'; // 'hybrid' | 


const testAgent = {
    id: 'test-agent',
    name: 'Nova',
    systemInstruction: 'You are a helpful AI assistant named Nova. Be warm, concise, and conversational.',
    voiceId: 'alloy',
};

/* ── Cost helpers ──────────────────────────────────────────────────── */

/* 
function hybridCostBreakdown(s: HybridCallSummary) {
    return {
        whisper: s.usage.whisperMinutes * 0.006,
        llm: (s.usage.promptTokens * 5 + s.usage.completionTokens * 15) / 1_000_000,
        tts: s.usage.ttsCharacters * 15 / 1_000_000,
    };
}
*/


function smartCostBreakdown(s: SmartCallSummary) {
    const u = s.usage;
    // Realtime GPT-4o-mini pricing (User provided)
    const miniCost = (
        (u.textInput * 0.60 / 1_000_000) +
        (u.audioInput * 10.00 / 1_000_000) +
        (u.textOutput * 2.40 / 1_000_000) +
        (u.audioOutput * 20.00 / 1_000_000)
    );
    // Standard GPT-4o pricing (User provided)
    const gptCost = (
        ((u.escalationPromptTokens || 0) * 2.50 / 1_000_000) +
        ((u.escalationCompletionTokens || 0) * 10.00 / 1_000_000)
    );
    // Standard GPT-4o-mini pricing
    const gptMiniCost = (
        ((u.escalationMiniPromptTokens || 0) * 0.15 / 1_000_000) +
        ((u.escalationMiniCompletionTokens || 0) * 0.60 / 1_000_000)
    );
    // Memory and Filter use Standard GPT-4o-mini
    const memoryCost = (
        ((u.memoryTokens || 0) * 0.60 / 1_000_000)
    );
    const filterCost = (
        ((u.filterPromptTokens || 0) * 0.15 / 1_000_000) +
        ((u.filterCompletionTokens || 0) * 0.60 / 1_000_000)
    );
    return { miniCost, gptCost, gptMiniCost, memoryCost, filterCost };
}

function fmt(s: number) {
    return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

/* ── Tab button ────────────────────────────────────────────────────── */

function TabBtn({ active, onClick, children, color }: { active: boolean; onClick: () => void; children: React.ReactNode; color: string }) {
    return (
        <button
            onClick={onClick}
            className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 ${active ? color : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
        >
            {children}
        </button>
    );
}

/* ── Info card ─────────────────────────────────────────────────────── */

function ArchInfoCard({ type }: { type: 'realtime' | 'smart' }) { // | 'hybrid'

    const cfg = {
        realtime: {
            border: 'border-rose-100 bg-rose-50/50',
            badge: 'bg-rose-100 text-rose-700',
            label: 'Option 1',
            title: 'Standard Voice Mode',
            desc: 'A fast, helpful voice assistant that responds instantly to your questions.',

            chips: [
                { label: 'Listening Cost',  val: 'Very Low',   color: 'rose'  },
                { label: 'Speaking Cost', val: 'Low',   color: 'rose'  },
                { label: 'Text Data',   val: 'Minimal', color: 'slate' },
                { label: 'Response Speed',   val: 'Instant',           color: 'slate' },
            ],

        },
        hybrid: {
            border: 'border-emerald-100 bg-emerald-50/50',
            badge: 'bg-emerald-100 text-emerald-700',
            label: '🟢 Architecture 2',
            title: 'Whisper → GPT-4o → TTS-1',
            desc: 'Text pipeline. Audio captured → transcribed → text LLM → synthesized. Turn-based.',
            chips: [
                { label: 'Whisper STT', val: '$0.006/min',    color: 'emerald' },
                { label: 'GPT-4o In',  val: '$5/1M tokens',  color: 'emerald' },
                { label: 'GPT-4o Out', val: '$15/1M tokens', color: 'emerald' },
                { label: 'TTS-1',      val: '$15/1M chars',  color: 'emerald' },
            ],
        },
        smart: {
            border: 'border-sky-100 bg-sky-50/50',
            badge: 'bg-sky-100 text-sky-700',
            label: 'Option 2',
            title: 'Smart Thinking Mode',
            desc: 'Sounds fast and natural, but uses a "second brain" for complex analysis whenever needed.',

            chips: [
                { label: 'Basic Chat Cost',  val: 'Low',  color: 'sky'    },
                { label: 'Data Sync',   val: 'Efficient',   color: 'sky'    },
                { label: 'Advanced Thinking In',  val: 'Premium', color: 'violet' },
                { label: 'Advanced Thinking Out', val: 'High Value',color: 'violet' },
            ],

        },
    }[type as 'realtime' | 'smart'];


    return (
        <div className={`rounded-2xl border p-5 text-sm ${cfg.border}`}>
            <div className="flex items-center gap-2 mb-3">
                <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${cfg.badge}`}>{cfg.label}</span>
            </div>
            <h3 className="font-bold text-slate-800 text-base mb-1">{cfg.title}</h3>
            <p className="text-slate-500 text-xs mb-3">{cfg.desc}</p>
            <div className="grid grid-cols-2 gap-2">
                {cfg.chips.map(c => <Chip key={c.label} {...c} />)}
            </div>
        </div>
    );
}

function Chip({ label, val, color }: { label: string; val: string; color: string }) {
    const cls: Record<string, string> = {
        rose:    'bg-rose-100 text-rose-700',
        emerald: 'bg-emerald-100 text-emerald-700',
        slate:   'bg-slate-100 text-slate-600',
        sky:     'bg-sky-100 text-sky-700',
        violet:  'bg-violet-100 text-violet-700',
    };
    return (
        <div className={`rounded-lg px-2.5 py-1.5 ${cls[color]}`}>
            <div className="text-[10px] font-medium opacity-70">{label}</div>
            <div className="text-xs font-bold">{val}</div>
        </div>
    );
}

/* ── Realtime Ledger ───────────────────────────────────────────────── */

function RealtimeLedger({ logs }: { logs: CallSummary[] }) {
    return (
        <div className="w-full bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-rose-50/40 flex justify-between items-center">
                <div>
                    <h3 className="font-semibold text-slate-800 text-sm">Standard Mode — Usage &amp; Activity Log</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Basic voice model · Measures words and time · Regular chat</p>
                </div>
                <span className="text-xs font-medium text-rose-700 bg-rose-100 px-2.5 py-1 rounded-lg">{logs.length} calls</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                    <thead className="text-[11px] uppercase text-slate-400 bg-slate-50 border-b border-slate-100">
                        <tr>
                            <th className="px-4 py-3 font-medium">Session</th>
                            <th className="px-4 py-3 font-medium">Date &amp; Time</th>
                            <th className="px-4 py-3 font-medium text-right">Duration</th>
                            <th className="px-4 py-3 font-medium text-right">Text In</th>
                            <th className="px-4 py-3 font-medium text-right">Audio In</th>
                            <th className="px-4 py-3 font-medium text-right">Text Out</th>
                            <th className="px-4 py-3 font-medium text-right">Audio Out</th>
                            <th className="px-4 py-3 font-medium text-right text-rose-600">Total Activity Cost</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {logs.length === 0 ? (
                            <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-300">No calls yet. Start a call above.</td></tr>
                        ) : logs.map(l => (
                            <tr key={l.id} className="hover:bg-slate-50/60 transition-colors">
                                <td className="px-4 py-3 font-mono text-slate-500">{l.id}</td>
                                <td className="px-4 py-3 text-slate-500">{l.date}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.durationSeconds}s</td>
                                <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.tokens.textInput.toLocaleString()}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.tokens.audioInput.toLocaleString()}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.tokens.textOutput.toLocaleString()}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.tokens.audioOutput.toLocaleString()}</td>
                                <td className="px-4 py-3 text-right tabular-nums font-bold text-rose-700">${l.cost.toFixed(5)}</td>
                            </tr>
                        ))}
                    </tbody>
                    {logs.length > 0 && (
                        <tfoot className="bg-rose-50/30 border-t border-rose-100">
                            <tr>
                                <td colSpan={7} className="px-4 py-3 text-xs font-semibold text-slate-600">Total ({logs.length} calls)</td>
                                <td className="px-4 py-3 text-right font-bold text-rose-700">${logs.reduce((s, l) => s + l.cost, 0).toFixed(5)}</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </div>
    );
}

/* ── Hybrid Ledger ─────────────────────────────────────────────────── */

/*
function HybridLedger({ logs }: { logs: HybridCallSummary[] }) {
    return (
        <div className="w-full bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-emerald-50/40 flex justify-between items-center">
                <div>
                    <h3 className="font-semibold text-slate-800 text-sm">🟢 Hybrid — Usage &amp; Cost Ledger</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Whisper STT · GPT-4o text · TTS-1 · Text pipeline</p>
                </div>
                <span className="text-xs font-medium text-emerald-700 bg-emerald-100 px-2.5 py-1 rounded-lg">{logs.length} calls</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                    <thead className="text-[11px] uppercase text-slate-400 bg-slate-50 border-b border-slate-100">
                        <tr>
                            <th className="px-4 py-3 font-medium">Session</th>
                            <th className="px-4 py-3 font-medium">Date &amp; Time</th>
                            <th className="px-4 py-3 font-medium text-right">Duration</th>
                            <th className="px-4 py-3 font-medium text-right">Turns</th>
                            <th className="px-4 py-3 font-medium text-right">Whisper (min)</th>
                            <th className="px-4 py-3 font-medium text-right">Prompt Toks</th>
                            <th className="px-4 py-3 font-medium text-right">Completion Toks</th>
                            <th className="px-4 py-3 font-medium text-right">TTS Chars</th>
                            <th className="px-4 py-3 font-medium text-right text-emerald-600">Total Cost</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {logs.length === 0 ? (
                            <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-300">No calls yet. Start a call above.</td></tr>
                        ) : logs.map(l => {
                            const { whisper, llm, tts } = hybridCostBreakdown(l);
                            return (
                                <tr key={l.id} className="hover:bg-slate-50/60 transition-colors">
                                    <td className="px-4 py-3 font-mono text-slate-500">{l.id}</td>
                                    <td className="px-4 py-3 text-slate-500">{l.date}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.durationSeconds}s</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.turns}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.usage.whisperMinutes.toFixed(3)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.usage.promptTokens.toLocaleString()}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.usage.completionTokens.toLocaleString()}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.usage.ttsCharacters.toLocaleString()}</td>
                                    <td className="px-4 py-3 text-right font-bold text-emerald-700">
                                        <span title={`Whisper: $${whisper.toFixed(5)} | LLM: $${llm.toFixed(5)} | TTS: $${tts.toFixed(5)}`}>
                                            ${l.cost.toFixed(5)}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                    {logs.length > 0 && (
                        <tfoot className="bg-emerald-50/30 border-t border-emerald-100">
                            <tr>
                                <td colSpan={8} className="px-4 py-3 text-xs font-semibold text-slate-600">Total ({logs.length} calls)</td>
                                <td className="px-4 py-3 text-right font-bold text-emerald-700">${logs.reduce((s, l) => s + l.cost, 0).toFixed(5)}</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </div>
    );
}
*/


/* ── Smart Ledger ──────────────────────────────────────────────────── */

function SmartLedger({ logs }: { logs: SmartCallSummary[] }) {
    return (
        <div className="w-full bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-sky-50/40 flex justify-between items-center">
                <div>
                    <h3 className="font-semibold text-slate-800 text-sm">Smart Mode — Usage &amp; Activity Log</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Advanced voice model · Intelligent thinking · Remembers facts</p>
                </div>
                <span className="text-xs font-medium text-sky-700 bg-sky-100 px-2.5 py-1 rounded-lg">{logs.length} calls</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                    <thead className="text-[11px] uppercase text-slate-400 bg-slate-50 border-b border-slate-100">
                        <tr>
                            <th className="px-4 py-3 font-medium">Session</th>
                            <th className="px-4 py-3 font-medium">Date &amp; Time</th>
                            <th className="px-4 py-3 font-medium text-right">Duration</th>
                            <th className="px-4 py-3 font-medium text-right">User Speech</th>
                            <th className="px-4 py-3 font-medium text-right">AI Speech</th>
                            <th className="px-4 py-3 font-medium text-right text-sky-600">Voice Cost</th>
                            <th className="px-4 py-3 font-medium text-right text-violet-600">Deep Thoughts</th>

                            <th className="px-4 py-3 font-medium text-right text-violet-600">Thought Size</th>
                            <th className="px-4 py-3 font-medium text-right text-indigo-600">Thinking Cost</th>
                            <th className="px-4 py-3 font-medium text-right text-violet-600">Analysis Cost</th>
                            <th className="px-4 py-3 font-medium text-right text-sky-600/70">Memory Cost</th>
                            <th className="px-4 py-3 font-medium text-right text-emerald-600">Filter Cost</th>
                            <th className="px-4 py-3 font-medium text-right text-sky-600">Total Activity Cost</th>

                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {logs.length === 0 ? (
                            <tr><td colSpan={13} className="px-4 py-10 text-center text-slate-300">No calls yet. Start a call above.</td></tr>
                        ) : logs.map(l => {
                            const { miniCost, gptCost, gptMiniCost, memoryCost, filterCost } = smartCostBreakdown(l);
                            return (
                                <tr key={l.id} className="hover:bg-slate-50/60 transition-colors">
                                    <td className="px-4 py-3 font-mono text-slate-500">{l.id}</td>
                                    <td className="px-4 py-3 text-slate-500">{l.date}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.durationSeconds}s</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.usage.audioInput.toLocaleString()}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{l.usage.audioOutput.toLocaleString()}</td>
                                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-sky-600">${miniCost.toFixed(5)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-violet-700 font-semibold">{l.usage.escalationCount}×</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-violet-600">{((l.usage.escalationPromptTokens || 0) + (l.usage.escalationCompletionTokens || 0) + (l.usage.escalationMiniPromptTokens || 0) + (l.usage.escalationMiniCompletionTokens || 0)).toLocaleString()}</td>
                                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-indigo-600">${gptMiniCost.toFixed(5)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-violet-600">${gptCost.toFixed(5)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-sky-600/70">${memoryCost.toFixed(5)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-emerald-600">${filterCost.toFixed(5)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums font-bold text-sky-700">${l.cost.toFixed(5)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                    {logs.length > 0 && (
                        <tfoot className="bg-sky-50/30 border-t border-sky-100">
                            <tr>
                                <td colSpan={12} className="px-4 py-3 text-xs font-semibold text-slate-600">Total ({logs.length} calls)</td>
                                <td className="px-4 py-3 text-right font-bold text-sky-700">${logs.reduce((s, l) => s + l.cost, 0).toFixed(5)}</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </div>
    );
}

/* ── Compare view ──────────────────────────────────────────────────── */

function CompareView({ rtLogs, smartLogs }: { rtLogs: CallSummary[]; smartLogs: SmartCallSummary[] }) { // hybLogs, 
    const rtTotal    = rtLogs.reduce((s, l) => s + l.cost, 0);
    // const hybTotal   = hybLogs.reduce((s, l) => s + l.cost, 0);
    const smartTotal = smartLogs.reduce((s, l) => s + l.cost, 0);
    const rtDur      = rtLogs.reduce((s, l) => s + l.durationSeconds, 0);
    // const hybDur     = hybLogs.reduce((s, l) => s + l.durationSeconds, 0);
    const smartDur   = smartLogs.reduce((s, l) => s + l.durationSeconds, 0);
    const rtAvg      = rtLogs.length ? rtTotal / rtLogs.length : 0;
    // const hybAvg     = hybLogs.length ? hybTotal / hybLogs.length : 0;
    const smartAvg   = smartLogs.length ? smartTotal / smartLogs.length : 0;
    const savings    = null; // rtTotal > 0 && hybTotal > 0 ? ((rtTotal - hybTotal) / rtTotal) * 100 : null;

    const smartSavings = rtTotal > 0 && smartTotal > 0 ? ((rtTotal - smartTotal) / rtTotal) * 100 : null;

    return (
        <div className="w-full space-y-6">
            {/* Summary cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                <SummaryCard title="Standard Mode" calls={rtLogs.length} total={rtTotal} avg={rtAvg} dur={rtDur} color="rose" />
                {/* <SummaryCard title="🟢 Hybrid STT+LLM+TTS" calls={hybLogs.length} total={hybTotal} avg={hybAvg} dur={hybDur} color="emerald" /> */}
                <SummaryCard title="Smart Thinking Mode" calls={smartLogs.length} total={smartTotal} avg={smartAvg} dur={smartDur} color="sky" />


            </div>

            {/* Savings banners */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* {savings !== null && (
                    <div className="rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-600 p-5 text-white text-center shadow-lg">
                        <p className="text-emerald-100 text-sm mb-1">Hybrid vs Realtime</p>
                        <p className="text-4xl font-black">{savings.toFixed(1)}% cheaper</p>
                        <p className="text-emerald-100 text-xs mt-1">based on your actual call data</p>
                    </div>
                )} */}

                {smartSavings !== null && (
                    <div className="rounded-2xl bg-gradient-to-r from-sky-500 to-violet-600 p-5 text-white text-center shadow-lg">
                        <p className="text-sky-100 text-sm mb-1">Smart vs Realtime</p>
                        <p className="text-4xl font-black">{smartSavings.toFixed(1)}% cheaper</p>
                        <p className="text-sky-100 text-xs mt-1">with escalation intelligence</p>
                    </div>
                )}
            </div>

            {/* Static pricing comparison table */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                    <h3 className="font-semibold text-slate-800 text-sm">⚖️ Simple Pricing Comparison</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Estimated savings based on model complexity</p>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="text-[11px] uppercase text-slate-400 bg-slate-50 border-b border-slate-100">
                            <tr>
                                <th className="px-5 py-3 font-medium">Feature</th>
                                <th className="px-5 py-3 font-medium text-rose-600">🔴 Realtime</th>
                                {/* <th className="px-5 py-3 font-medium text-emerald-600">🟢 Hybrid</th> */}
                                <th className="px-5 py-3 font-medium text-violet-600">Smart Savings</th>

                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 text-slate-600">
                            <tr className="hover:bg-slate-50/60">
                                <td className="px-5 py-3 font-medium text-slate-700">Listening to User</td>
                                <td className="px-5 py-3 text-rose-600 font-semibold">$40 / 1M audio tokens</td>
                                <td className="px-5 py-3 text-violet-600 font-bold">Smart handles via Mini RT</td>
                            </tr>
                            <tr className="hover:bg-slate-50/60">
                                <td className="px-5 py-3 font-medium text-slate-700">Processing &amp; Logic</td>
                                <td className="px-5 py-3 text-rose-600 font-semibold">$5 text + $40 audio / 1M</td>
                                <td className="px-5 py-3 text-violet-600 font-bold">Smart uses Mini + 4o</td>
                            </tr>
                            <tr className="hover:bg-slate-50/60">
                                <td className="px-5 py-3 font-medium text-slate-700">AI Speaking</td>
                                <td className="px-5 py-3 text-rose-600 font-semibold">$80 / 1M audio tokens</td>
                                <td className="px-5 py-3 text-violet-600 font-bold">Smart uses Mini RT</td>
                            </tr>
                            <tr className="hover:bg-slate-50/60">
                                <td className="px-5 py-3 font-medium text-slate-700">Latency</td>
                                <td className="px-5 py-3 font-semibold text-slate-700">~50ms</td>
                                <td className="px-5 py-3 font-semibold text-slate-700">~1–2s per turn</td>
                                <td className="px-5 py-3 text-slate-400">Realtime wins</td>
                            </tr>
                            <tr className="hover:bg-slate-50/60">
                                <td className="px-5 py-3 font-medium text-slate-700">Flow &amp; Interruptions</td>
                                <td className="px-5 py-3 font-semibold text-slate-700">Native</td>
                                <td className="px-5 py-3 font-semibold text-slate-700">Turn-based</td>
                                <td className="px-5 py-3 text-slate-400">Realtime wins</td>
                            </tr>
                            <tr className="bg-slate-50 font-bold">
                                <td className="px-5 py-3 text-slate-800">Est. Cost / 3 minute call</td>
                                <td className="px-5 py-3 text-rose-600">$0.40 – $1.20</td>
                                {/* <td className="px-5 py-3 text-emerald-600">$0.02 – $0.07</td> */}
                                <td className="px-5 py-3 text-violet-600">~60-80% cheaper</td>

                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

function SummaryCard({ title, calls, total, avg, dur, color }: { title: string; calls: number; total: number; avg: number; dur: number; color: string }) {
    const cls: Record<string, { border: string; badge: string; val: string }> = {
        rose:    { border: 'border-rose-100 bg-rose-50/30',    badge: 'bg-rose-100 text-rose-700',    val: 'text-rose-700' },
        emerald: { border: 'border-emerald-100 bg-emerald-50/30', badge: 'bg-emerald-100 text-emerald-700', val: 'text-emerald-700' },
        sky:     { border: 'border-sky-100 bg-sky-50/30',       badge: 'bg-sky-100 text-sky-700',       val: 'text-sky-700'     },
    };
    const c = cls[color];
    return (
        <div className={`rounded-2xl border ${c.border} p-5`}>
            <p className={`text-xs font-bold px-2.5 py-1 rounded-full inline-block mb-3 ${c.badge}`}>{title}</p>
            {calls === 0 ? (
                <p className="text-slate-400 text-sm">No calls recorded yet.</p>
            ) : (
                <div className="grid grid-cols-2 gap-3 mt-1">
                    <div><p className="text-[10px] text-slate-400">Total Calls</p><p className={`text-xl font-black ${c.val}`}>{calls}</p></div>
                    <div><p className="text-[10px] text-slate-400">Total Cost</p><p className={`text-xl font-black ${c.val}`}>${total.toFixed(4)}</p></div>
                    <div><p className="text-[10px] text-slate-400">Avg / Call</p><p className="text-base font-bold text-slate-700">${avg.toFixed(5)}</p></div>
                    <div><p className="text-[10px] text-slate-400">Total Duration</p><p className="text-base font-bold text-slate-700">{fmt(dur)}</p></div>
                </div>
            )}
        </div>
    );
}

/* ── Main page ─────────────────────────────────────────────────────── */

export default function Home() {
    const [tab, setTab]             = useState<Tab>('realtime');
    const [rtLogs, setRtLogs]       = useState<CallSummary[]>([]);
    const [hybLogs, setHybLogs]     = useState<any[]>([]); // Using any for commented out type
    const [smartLogs, setSmartLogs] = useState<SmartCallSummary[]>([]);


    return (
        <main className="min-h-screen bg-slate-50 pb-20">
            {/* Header */}
            <div className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
                <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
                    <div>
                        <h1 className="text-lg font-bold text-slate-900 tracking-tight">🤖 AI Voice Agent Comparison Hub</h1>
                        <p className="text-xs text-slate-400">Test different AI models side-by-side to find the best fit</p>
                    </div>

                    <div className="flex gap-2 flex-wrap">
                        <span className="text-[10px] bg-rose-100 text-rose-700 font-semibold px-2 py-1 rounded-full">{rtLogs.length} Standard calls</span>
                        {/* <span className="text-[10px] bg-emerald-100 text-emerald-700 font-semibold px-2 py-1 rounded-full">{hybLogs.length} Hybrid calls</span> */}
                        <span className="text-[10px] bg-sky-100 text-sky-700 font-semibold px-2 py-1 rounded-full">{smartLogs.length} Smart calls</span>

                    </div>
                </div>
            </div>

            <div className="max-w-5xl mx-auto px-6 pt-8 space-y-8">
                {/* Tabs */}
                <div className="flex gap-2 bg-white border border-slate-200 p-1.5 rounded-2xl w-fit shadow-sm flex-wrap">
                    <TabBtn active={tab === 'realtime'} onClick={() => setTab('realtime')} color="bg-rose-500 text-white shadow-sm">
                        Standard Mode
                    </TabBtn>

                    {/* <TabBtn active={tab === 'hybrid'} onClick={() => setTab('hybrid')} color="bg-emerald-500 text-white shadow-sm">
                        🟢 Hybrid
                    </TabBtn> */}

                    <TabBtn active={tab === 'smart'} onClick={() => setTab('smart')} color="bg-sky-500 text-white shadow-sm">
                        Smart Mode
                    </TabBtn>

                    <TabBtn active={tab === 'compare'} onClick={() => setTab('compare')} color="bg-violet-500 text-white shadow-sm">
                        Performance Review
                    </TabBtn>

                </div>

                {/* Realtime tab */}
                {tab === 'realtime' && (
                    <div className="space-y-8">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                            <ArchInfoCard type="realtime" />
                            <div className="flex justify-center">
                                <CallInterface agent={testAgent} onCallEnd={s => setRtLogs(p => [s, ...p])} />
                            </div>
                        </div>
                        <RealtimeLedger logs={rtLogs} />
                    </div>
                )}

                {/* Hybrid tab - Commented out
                {tab === 'hybrid' && (
                    <div className="space-y-8">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                            <ArchInfoCard type="hybrid" />
                            <div className="flex justify-center">
                                <CallInterfaceHybrid agent={testAgent} onCallEnd={s => setHybLogs(p => [s, ...p])} />
                            </div>
                        </div>
                        <HybridLedger logs={hybLogs} />
                    </div>
                )} */}


                {/* Smart tab */}
                {tab === 'smart' && (
                    <div className="space-y-8">
                        <div className="flex flex-col items-start gap-6">
                            <div className="w-full">
                                <ArchInfoCard type="smart" />
                            </div>
                            <div className="w-full flex justify-center">
                                <CallInterfaceSmart agent={testAgent} onCallEnd={s => setSmartLogs(p => [s, ...p])} />
                            </div>
                        </div>
                        <SmartLedger logs={smartLogs} />
                    </div>
                )}

                {/* Compare tab */}
                {tab === 'compare' && (
                    <CompareView rtLogs={rtLogs} smartLogs={smartLogs} />
                )}

            </div>
        </main>
    );
}
