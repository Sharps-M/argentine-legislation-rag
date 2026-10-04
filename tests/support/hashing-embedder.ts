import type { Embedder } from "@/ai/embedder";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";

const words = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];

// FNV-1a: a small, stable string hash.
const hash = (word: string) => {
  let value = 0x811c9dc5;
  for (let index = 0; index < word.length; index += 1) {
    value ^= word.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};

/** Bag-of-words vector: each word adds to one position, then L2-normalized. */
export function hashingVector(
  text: string,
  dimensions = EMBEDDING_DIMENSIONS,
): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of words(text)) {
    const position = hash(word) % dimensions;
    vector[position] = (vector[position] ?? 0) + 1;
  }

  const norm = Math.hypot(...vector);
  // A text without words still needs a valid (non-zero) vector.
  if (norm === 0) return vector.map((_, index) => (index === 0 ? 1 : 0));

  return vector.map((value) => value / norm);
}

/**
 * A deterministic stand-in for the embedding model: texts that share words get
 * similar vectors. It makes the tests independent of Ollama while keeping
 * "closest in meaning" something a test can reason about.
 */
export function createHashingEmbedder(model = "test-hashing"): Embedder & {
  calls: string[][];
} {
  const calls: string[][] = [];

  return {
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    calls,
    async embed(values) {
      calls.push(values);
      return values.map((value) => hashingVector(value));
    },
  };
}
