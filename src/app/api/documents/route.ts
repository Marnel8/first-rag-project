import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

/* ============================================================
   ENV & CLIENTS
============================================================ */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getSupabaseClients() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY), SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const supabaseAdmin = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  );

  return { supabase, supabaseAdmin };
}

/* ============================================================
   TYPES
============================================================ */

interface DocumentMetadata {
  document_id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  upload_date: string;
  total_chunks: number;
  file_url?: string;
  file_path?: string;
}

interface DocumentRow {
  content: string | null;
  metadata: DocumentMetadata;
}

interface DocumentMetadataRow {
  metadata: DocumentMetadata;
}

/* ============================================================
   GET
============================================================ */

export async function GET(req: Request): Promise<Response> {
  try {
    const { supabase, supabaseAdmin } = getSupabaseClients();
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const file = url.searchParams.get('file') === 'true';
    const view = url.searchParams.get('view') === 'true';

    /* ---------------- FILE DOWNLOAD ---------------- */
    if (id && file) {
      const { data, error } = await supabase
        .from('documents')
        .select('metadata')
        .eq('metadata->>document_id', id)
        .limit(1);

      if (error || !data || data.length === 0) {
        return NextResponse.json(
          { error: 'Document not found' },
          { status: 404 }
        );
      }

      const meta = data[0].metadata;

      const fileName = meta.file_name;
      const fileType = meta.file_type;
      const filePath = meta.file_path!;

      const { data: fileData, error: downloadError } =
        await supabaseAdmin.storage
          .from('documents')
          .download(filePath);

      if (downloadError || !fileData) {
        return NextResponse.json(
          { error: 'File not found in storage' },
          { status: 404 }
        );
      }

      const buffer = Buffer.from(await fileData.arrayBuffer());
      const isPDF = fileType === 'application/pdf';

      return new NextResponse(buffer, {
        headers: {
          'Content-Type': fileType,
          'Content-Disposition':
            view && isPDF
              ? `inline; filename="${fileName}"`
              : `attachment; filename="${fileName}"`,
        },
      });
    }

    /* ---------------- SINGLE DOCUMENT ---------------- */
    if (id) {
      const { data, error } = await supabase
        .from('documents')
        .select('content, metadata')
        .eq('metadata->>document_id', id)
        .order('metadata->>chunk_index', { ascending: true });

      if (error || !data || data.length === 0) {
        return NextResponse.json(
          { error: 'Document not found' },
          { status: 404 }
        );
      }

      const meta = data[0].metadata;

      return NextResponse.json({
        id,
        file_name: meta.file_name,
        file_type: meta.file_type,
        file_size: meta.file_size,
        upload_date: meta.upload_date,
        total_chunks: data.length,
        fullText: data
          .map((row: DocumentRow) => row.content ?? '')
          .join('\n\n'),
        file_url: meta.file_url,
        file_path: meta.file_path,
      });
    }

    /* ---------------- LIST DOCUMENTS ---------------- */
    const { data, error } = await supabase
      .from('documents')
      .select('metadata');

    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? 'Failed to fetch documents' },
        { status: 500 }
      );
    }

    const map = new Map<string, DocumentMetadata>();

    const rows = (data ?? []) as DocumentMetadataRow[];
    rows.forEach((row) => {
      const m = row.metadata;
      if (!map.has(m.document_id)) {
        map.set(m.document_id, m);
      }
    });

    return NextResponse.json({
      documents: Array.from(map.values()),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/* ============================================================
   DELETE
============================================================ */

export async function DELETE(req: Request): Promise<Response> {
  try {
    const { supabase, supabaseAdmin } = getSupabaseClients();
    const id = new URL(req.url).searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'Document ID required' },
        { status: 400 }
      );
    }

    const { data } = await supabase
      .from('documents')
      .select('metadata')
      .eq('metadata->>document_id', id)
      .limit(1);

    const meta = data?.[0]?.metadata;

    if (meta?.file_path) {
      await supabaseAdmin.storage
        .from('documents')
        .remove([meta.file_path]);
    }

    const { error } = await supabaseAdmin
      .from('documents')
      .delete()
      .eq('metadata->>document_id', id);

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      success: true,
      fileDeleted: Boolean(meta?.file_path),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
