import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

/* ============================================================
   ENV & CLIENT
============================================================ */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

/* ============================================================
   OLLAMA CONFIG
============================================================ */

const OLLAMA_BASE_URL = 'https://ollama.mvsoftwares.space';
const OLLAMA_EMBED_MODEL = 'nomic-embed-text';
const OLLAMA_CHAT_MODEL = 'gemma:2b'; // or llama3:8b if you want better answers

/* ============================================================
   TYPES
============================================================ */

interface MatchDocumentRow {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

interface OllamaEmbeddingResponse {
  embedding: number[];
}

interface OllamaGenerateResponse {
  response: string;
}

/* ============================================================
   OLLAMA HELPERS
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
  return data.embedding; // vector(768)
}

async function generateAnswer(
  prompt: string
): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_CHAT_MODEL,
      prompt,
      stream: false,
    }),
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Ollama generation failed: ${msg}`);
  }

  const data: OllamaGenerateResponse = await res.json();
  return data.response;
}

/* ============================================================
   API ROUTE
============================================================ */

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const query = body?.query;

    if (typeof query !== 'string' || !query.trim()) {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      );
    }

    /* ----------------------------
       Embed user query
    ----------------------------- */
    const queryEmbedding = await getEmbedding(query);

    /* ----------------------------
       Retrieve similar chunks
    ----------------------------- */
    const { data, error } = await supabase.rpc(
      'match_documents',
      {
        query_embedding: queryEmbedding,
        match_threshold: 0.2,
        match_count: 5,
      }
    );

    if (error) {
      throw new Error(error.message);
    }

    const results = (data ?? []) as MatchDocumentRow[];

    /* ----------------------------
       Build context
    ----------------------------- */
    const context = results
      .map((r) => r.content)
      .join('\n---\n');

    /* ----------------------------
       Guardrail prompt (IMPORTANT)
    ----------------------------- */
    const prompt = `
You are a helpful assistant.

Use ONLY the context below to answer the question.
If the answer is not contained in the context, say:
"I don't know based on the provided documents."

Context:
${context || 'No relevant context found.'}

Question:
${query}
`.trim();

    /* ----------------------------
       Generate answer
    ----------------------------- */
    const answer = await generateAnswer(prompt);

    return NextResponse.json({
      answer,
      sources: results,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}