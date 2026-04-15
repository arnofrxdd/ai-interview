import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const { text, voice = 'thalia' } = await req.json();
        const apiKey = process.env.DEEPGRAM_API_KEY?.replace(/^["']|["']$/g, '');

        if (!apiKey) {
            return new Response('Deepgram API Key missing', { status: 500 });
        }

        const model = `aura-2-${voice}-en`;
        console.log(`[voice-preview] Requesting model: ${model}`);
        
        const dgRes = await fetch(`https://api.deepgram.com/v1/speak?model=${model}`, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text }),
        });

        if (!dgRes.ok) {
            const err = await dgRes.text();
            console.error(`[voice-preview] Deepgram error [Status: ${dgRes.status}]:`, err);
            return new Response(`Deepgram Error: ${err}`, { status: dgRes.status });
        }

        return new Response(dgRes.body, {
            headers: {
                'Content-Type': 'audio/mpeg',
            },
        });
    } catch (e: any) {
        return new Response(e.message, { status: 500 });
    }
}
