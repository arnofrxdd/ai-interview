import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const { previousNotes, recentMessages, systemInstruction } = await req.json();

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `You are a universal background memory manager for a live AI assistant.
Your ONLY responsibility is to maintain a running, persistent knowledge base of facts about the user and the ongoing conversation. You will receive the "Current Notes" and "Recent Messages".

UNIVERSAL LAWS OF MEMORY:
1. PRESERVE CORE FACTS STRICTLY. You are building a long-term file. NEVER delete established facts about the user (e.g., their name, preferences, context, project details, history) unless the new messages explicitly contradict or override them.
2. APPEND, DON'T OVERWRITE. When valuable new facts emerge in the "Recent Messages", add them to the existing notes. Do not blindly overwrite the old notes just because the new messages are about a different topic.
3. ADAPT CONTRADICTIONS ONLY. If a user explicitly corrects something (e.g. "Actually my name is John, not Mark"), update that specific detail while leaving the rest of the notes completely intact.
4. IGNORE SMALL TALK. Do not record pleasantries, thinking process, or irrelevant chatter. Only store actionable context.
5. STRICT OUTPUT FORMAT. Output ONLY the raw updated notes (using bullet points or concise sentences). No introductory text. Never start with "Here are the notes:".

If the Recent Messages contain nothing worth saving, output the EXACT PREVIOUS "Current Notes" without deleting anything.`,
                    },
                    {
                        role: 'user',
                        content: `Current Notes:\n${previousNotes || "None"}\n\nRecent Messages:\n${recentMessages.map((m: any) => `[${m.role}]: ${m.content}`).join('\n')}`,
                    }
                ],
                temperature: 0.1,
            }),
        });

        if (!res.ok) {
            const err = await res.json();
            return NextResponse.json({ error: err.message }, { status: res.status });
        }

        const data = await res.json();
        return NextResponse.json({
            notes: data.choices[0].message.content,
            usage: data.usage,
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
