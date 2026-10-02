/**
 * Drizzle schema.
 *
 * Tables are added stage by stage (regulations, chunks and their embeddings
 * arrive with the ingestion pipeline). The first migration only enables the
 * pgvector extension.
 */
export {};
