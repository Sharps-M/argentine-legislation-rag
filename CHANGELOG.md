# Changelog

## 1.0.0 — 2026-10-28

The first complete version: the seven stages of the [roadmap](README.md#roadmap).

- **Data**: validated, idempotent load of the InfoLEG open dataset. Every
  national law and decree-law since 1853 and the decrees of the last five
  years, their full text downloaded politely and cut along their legal
  structure.
- **Search**: local embeddings (`bge-m3`) in PostgreSQL with pgvector and an
  HNSW index; regulations cited by number looked up directly; a similarity
  floor that says when nothing is close; reissues of a provision grouped, the
  latest first; dates in the question bring out the edition asked for.
- **Answers**: streamed from a chain of models (Gemini, any OpenAI-compatible
  service, a local model on Ollama), with every citation and amount checked in
  code, a second search in the words of the law when the sources do not
  answer, and limits per minute.
- **Screen**: the answer as it is written, with linked citations, filters,
  shareable links, in Spanish and English, light and dark.
- **Upkeep**: a daily check and a weekly update of what changed in the dataset,
  with its status on the page.
- **Quality**: unit, integration and browser tests in CI; a retrieval and an
  answer evaluation, with every round in `docs/evaluacion.md`; 54 design
  decisions in `docs/decisiones.md`.
- **Security**: requires the Node.js releases of October 2026 (22.23.4, 24.22.1
  or 26.12.1) and Next.js 16.4.3.
