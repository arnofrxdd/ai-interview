import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const audio = formData.get('audio') as Blob;
        if (!audio) return NextResponse.json({ error: 'No audio' }, { status: 400 });

        const oaiForm = new FormData();
        oaiForm.append('file', audio, 'recording.webm');
        oaiForm.append('model', 'whisper-1');
        oaiForm.append('response_format', 'verbose_json');

        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: oaiForm,
        });

        if (!res.ok) {
            const err = await res.json();
            return NextResponse.json({ error: err.message }, { status: res.status });
        }

        const data = await res.json();
        return NextResponse.json({ text: data.text, duration: data.duration ?? 3 });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
