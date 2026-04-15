import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const { query, conversationHistory, systemInstruction, complexity, responseFormat } = await req.json();

        // Route to GPT-4o ONLY for explicitly complex queries.
        // Internally mapping GPT-5 strings to working GPT-4o models for availability.
        const modelToUse = complexity === 'complex' ? 'gpt-4o' : 'gpt-4o-mini';

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: modelToUse,
                messages: [
                    {
                        role: 'system',
                        content: responseFormat === 'json_object' 
                            ? `${systemInstruction}\n\nReturn the result as a raw JSON object. Do not add markdown backticks or any preamble.`
                            : `${systemInstruction}

CONTEXT: You are the silent reasoning brain powering a conversational voice AI. The user is on a phone call. Your ONLY job is to return the final answer that the voice AI will speak aloud.

UNIVERSAL VOICE RULES - STRICT ENFORCEMENT:
1. MAX 2-3 SHORT SENTENCES. You MUST synthesize complex information into extreme brevity.
2. NO MARKDOWN. NO BULLET POINTS. NO NUMBERED LISTS. NO BOLD TEXT. Write exactly as a human speaks casually over the phone.
3. CONVERSATIONAL TONE. If comparing things (like SQL vs NoSQL), do NOT list pros and cons. Just give the bottom-line takeaway in a couple of sentences.
4. DO ALL WORK INVISIBLY. Calculate math silently. Never output equations. Just say the final number plainly.
5. VIOLATING THESE RULES BREAKS THE TEXT-TO-SPEECH ENGINE. Be brief, natural, and concise.`,
                    },
                    ...(conversationHistory || []),
                    { role: 'user', content: query },
                ],
                temperature: responseFormat === 'json_object' ? 0 : 0.2,
                max_tokens: responseFormat === 'json_object' ? 800 : 120,
                response_format: responseFormat === 'json_object' ? { type: 'json_object' } : undefined,
            }),
        });

        if (!res.ok) {
            const err = await res.json();
            return NextResponse.json({ error: err.message }, { status: res.status });
        }

        const data = await res.json();
        let answer = data.choices[0].message.content;
        let usage = data.usage;
        let wasSanitized = false;
        let filterUsage = { prompt_tokens: 0, completion_tokens: 0 };

        // ── PROGRAMMATIC SANITIZATION DETECTOR ──
        // If the model leaked its internal scratching (LaTeX, math equations, markdown, or just too long),
        // we fire a rapid second pass with gpt-5-mini to extract and sanitize the final voice-friendly answer.
        const containsMathOrMarkdown = 
            answer.includes('\\(') || 
            answer.includes('\\[') || 
            answer.includes('\\text') || 
            answer.includes('\\frac') || 
            answer.includes('**') || 
            answer.includes('###') || 
            answer.match(/[\d]+\. /) || // Numbered lists
            answer.match(/[\d]+[\s\w]*[\+\=\/\-\*][\s\w]*[\d]+/) || // Improved math regex: catches "60 mph + 80 mph"
            answer.match(/= /); // Catches "= 140"
            
        const wordCount = answer.split(/\s+/).filter(Boolean).length;
        const isTooLong = answer.length > 200 || wordCount > 35;

        if (responseFormat !== 'json_object' && (containsMathOrMarkdown || isTooLong)) {
            console.log(`[FILTER] 🧼 Response needs sanitization — math/md: ${containsMathOrMarkdown}, long: ${isTooLong}`);
            const sanitizeRes = await fetch('https://api.openai.com/v1/chat/completions', {
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
                            content: `Convert this into 1-2 short casual spoken sentences for a phone call. No markdown, no bullet points, no numbered steps, no equations. Just the plain bottom-line answer a human would say out loud.`
                        },
                        { role: 'user', content: answer },
                    ],
                    temperature: 0.1,
                    max_tokens: 60,
                }),
            });

            if (sanitizeRes.ok) {
                const sanitizeData = await sanitizeRes.json();
                answer = sanitizeData.choices[0].message.content;
                wasSanitized = true;
                if (sanitizeData.usage) {
                    filterUsage = {
                        prompt_tokens: sanitizeData.usage.prompt_tokens || 0,
                        completion_tokens: sanitizeData.usage.completion_tokens || 0,
                    };
                }
            }
        }

        return NextResponse.json({
            answer: answer,
            usage: usage,
            filterUsage: filterUsage, // New: track separately
            modelUsed: modelToUse,
            wasSanitized: wasSanitized,
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
