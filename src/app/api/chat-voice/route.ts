import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const { messages, systemInstruction } = await req.json();

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: `${systemInstruction}\n\nIMPORTANT: Keep all responses concise (1-3 sentences max). This is a voice call.`,
                    },
                    ...messages,
                ],
                max_tokens: 250,
                temperature: 0.7,
            }),
        });

        if (!res.ok) {
            const err = await res.json();
            return NextResponse.json({ error: err.message }, { status: res.status });
        }

        const data = await res.json();
        return NextResponse.json({ text: data.choices[0].message.content, usage: data.usage });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
