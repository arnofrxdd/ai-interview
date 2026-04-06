import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const { text, voice = 'alloy' } = await req.json();

        const res = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'mp3' }),
        });

        if (!res.ok) {
            const errBody = await res.text();
            console.error(`[speak] OpenAI TTS ${res.status}:`, errBody);
            return new Response(errBody, { status: res.status, headers: { 'Content-Type': 'text/plain' } });
        }
        return new Response(res.body, { headers: { 'Content-Type': 'audio/mpeg' } });
    } catch (e: any) {
        return new Response(e.message, { status: 500 });
    }
}
