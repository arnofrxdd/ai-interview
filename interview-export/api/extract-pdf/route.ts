import { NextRequest, NextResponse } from 'next/server';
// Use require for CommonJS compatibility in Next.js API routes
const pdf = require('pdf-parse/lib/pdf-parse.js');

/**
 * AI Interview - PDF Extraction Route
 * Uses stable pdf-parse@1.1.1 for textual CV analysis.
 */
export async function POST(req: NextRequest) {
  console.log('PDF Extraction API: Received POST request');
  try {
    const formData = await req.formData();
    console.log('PDF Extraction API: Form data parsed');
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Standard pdf-parse v1.1.1 usage
    const data = await pdf(buffer);

    return NextResponse.json({ 
      text: data.text || 'No text content found in PDF.',
      numpages: data.numpages,
      info: data.info
    });

  } catch (error: any) {
    console.error('PDF extraction error:', error);
    return NextResponse.json({ 
      error: error.message || 'Failed to extract PDF text',
      details: 'Ensure pdf-parse@1.1.1 is installed in the root project folder.'
    }, { status: 500 });
  }
}
