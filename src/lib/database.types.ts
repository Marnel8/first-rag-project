// lib/database.types.ts
export interface Database {
    public: {
      Tables: {
        documents: {
          Row: {
            id: number;
            content: string | null;
            metadata: {
              document_id: string;
              file_name: string;
              file_type: string;
              file_size: number;
              upload_date: string;
              total_chunks: number;
              file_url?: string;
              file_path?: string;
            };
            embedding: number[] | null;
          };
          Insert: {
            content: string;
            metadata: {
              document_id: string;
              file_name: string;
              file_type: string;
              file_size: number;
              upload_date: string;
              chunk_index: number;
              total_chunks: number;
              file_url?: string;
              file_path?: string;
            };
            embedding: number[];
          };
          Update: Partial<Database['public']['Tables']['documents']['Insert']>;
        };
      };
      Functions: {
        match_documents: {
          Args: {
            query_embedding: number[];
            match_threshold: number;
            match_count: number;
          };
        };
      };
    };
  }