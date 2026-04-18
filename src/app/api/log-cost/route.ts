import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(req: Request) {
  try {
    const { report, candidate } = await req.json();
    
    // Path to the backend logs directory
    // We navigate from src/app/api/log-cost to the project root
    const logDir = path.join(process.cwd(), 'livekit-agent-backend', 'logs');
    const logFile = path.join(logDir, 'interview_reports.md');

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toLocaleString();
    const entry = `\n--- [${timestamp}] [Candidate: ${candidate || 'Anonymous'}] ---\n${report}\n`;

    fs.appendFileSync(logFile, entry, 'utf8');

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to log cost:', error);
    return NextResponse.json({ ok: false, error: 'Internal Server Error' }, { status: 500 });
  }
}
