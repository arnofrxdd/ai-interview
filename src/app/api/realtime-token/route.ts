import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const voice = body.voice || "alloy";
        const model = body.model || "gpt-4o-mini-realtime-preview-2024-12-17";

        const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: model,
                voice: voice,
            }),
        });

        if (!response.ok) {
            const error = await response.json();
            console.error("OpenAI Realtime Token Error:", error);
            return NextResponse.json({ error: error.message }, { status: response.status });
        }

        const data = await response.json();
        return NextResponse.json(data);
    } catch (error: any) {
        console.error("Realtime token route error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
