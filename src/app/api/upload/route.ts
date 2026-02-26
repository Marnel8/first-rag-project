import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import mammoth from 'mammoth';

/* ============================================================
   ENV & CLIENTS
============================================================ */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const storage = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const OLLAMA_BASE_URL = 'https://ollama.mvsoftwares.space';
const OLLAMA_EMBED_MODEL = 'nomic-embed-text';

/* ============================================================
   TYPES
============================================================ */

// ---- pdf2json minimal types ----
interface PDFTextRun {
  T?: string;
}

interface PDFText {
  R?: PDFTextRun[];
}

interface PDFPage {
  Texts?: PDFText[];
}

interface PDFData {
  Pages?: PDFPage[];
}

// ---- Ollama embedding response ----
interface OllamaEmbeddingResponse {
  embedding: number[];
}

// ---- Document metadata ----
interface DocumentMetadata {
  document_id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  upload_date: string;
  chunk_index: number;
  total_chunks: number;
  file_path: string;
  file_url: string;
}

/* ============================================================
   HELPERS
============================================================ */

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    try {
      return decodeURIComponent(value.replace(/%/g, '%25'));
    } catch {
      return value;
    }
  }
}

/* ============================================================
   FILE TEXT EXTRACTION
============================================================ */

async function extractTextFromFile(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  // ---------- PDF ----------
  if (name.endsWith('.pdf')) {
    const { default: PDFParser } = await import('pdf2json');

    return new Promise<string>((resolve, reject) => {
      const parser = new PDFParser(null, true);

      parser.on(
        'pdfParser_dataError',
        (error: Error | { parserError: Error }) => {
          const parserError = 'parserError' in error ? error.parserError : error;
          reject(new Error(`PDF parsing error: ${parserError.message}`));
        }
      );

      parser.on(
        'pdfParser_dataReady',
        (data: PDFData) => {
          let text = '';

          data.Pages?.forEach((page) => {
            page.Texts?.forEach((t) => {
              t.R?.forEach((r) => {
                if (r.T) {
                  text += `${safeDecodeURIComponent(r.T)} `;
                }
              });
            });
          });

          resolve(text.trim());
        }
      );

      parser.parseBuffer(buffer);
    });
  }

  // ---------- DOCX ----------
  if (name.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // ---------- TXT ----------
  if (name.endsWith('.txt')) {
    return buffer.toString('utf-8');
  }

  throw new Error('Unsupported file type');
}

/* ============================================================
   OLLAMA EMBEDDINGS
============================================================ */

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_EMBED_MODEL,
      prompt: text,
    }),
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Ollama embedding failed: ${msg}`);
  }

  const data: OllamaEmbeddingResponse = await res.json();
  return data.embedding; // 768-dim
}

/* ============================================================
   API ROUTE
============================================================ */

export async function POST(req: Request): Promise<Response> {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    const documentId = crypto.randomUUID();
    const uploadDate = new Date().toISOString();
    const extension = file.name.split('.').pop() ?? 'bin';
    const filePath = `${documentId}.${extension}`;

    /* ----------------------------
       Upload file to Supabase
    ----------------------------- */
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await storage.storage
      .from('documents')
      .upload(filePath, buffer, {
        contentType: file.type || 'application/octet-stream',
      });

    if (uploadError) {
      throw new Error(uploadError.message);
    }

    const { data: publicUrlData } = storage.storage
      .from('documents')
      .getPublicUrl(filePath);

    /* ----------------------------
       Extract text
    ----------------------------- */
    const text = await extractTextFromFile(file);

    if (!text.trim()) {
      throw new Error('No text extracted from file');
    }

    /* ----------------------------
       Chunk text
    ----------------------------- */
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 800,
      chunkOverlap: 100,
    });

    const chunks = await splitter.splitText(text);

    /* ----------------------------
       Embed + store chunks
    ----------------------------- */
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await getEmbedding(chunks[i]);

      const metadata: DocumentMetadata = {
        document_id: documentId,
        file_name: file.name,
        file_type: file.type || extension,
        file_size: file.size,
        upload_date: uploadDate,
        chunk_index: i,
        total_chunks: chunks.length,
        file_path: filePath,
        file_url: publicUrlData.publicUrl,
      };

      const { error } = await supabase.from('documents').insert({
        content: chunks[i],
        embedding,
        metadata,
      });

      if (error) {
        throw new Error(error.message);
      }
    }

    return NextResponse.json({
      success: true,
      documentId,
      fileName: file.name,
      chunks: chunks.length,
      fileUrl: publicUrlData.publicUrl,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}