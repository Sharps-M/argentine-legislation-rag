# Normativa AR — Argentine Legislation RAG Search

[![CI](https://github.com/Sharps-M/argentine-legislation-rag/actions/workflows/ci.yml/badge.svg)](https://github.com/Sharps-M/argentine-legislation-rag/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Next.js](https://img.shields.io/badge/Next.js-16-black)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Normativa AR** is a semantic search engine over Argentine national legislation.
Ask a question in plain language and get an answer that **cites the regulation it
comes from**. If the retrieved regulations do not support an answer, it says so
instead of making one up.

It is built end to end in TypeScript as a retrieval-augmented generation (RAG)
system on open government data, with a swappable AI provider so it runs at zero
cost: local models for development, a free API tier for the demo.

> **Status: under construction.** The project is built in short, verifiable
> stages. See the [roadmap](#roadmap) for what works today.

![Home page](docs/screenshots/home-es.png)

## How it works

```
INGESTION (once, by command)
InfoLEG open data ─► validate & load ─► full text & chunks ─► embeddings ─┐
                                                                          ▼
                                                            PostgreSQL + pgvector
                                                                          │
QUERY (every question)                                                    ▼
question ─► embed question ─► nearest chunks ─► build context ─► cited answer
```

The AI provider (embeddings and chat) sits behind one interface: Ollama for local
development, the Gemini API free tier for the public demo.

## Tech stack

| Layer          | Technology                                          |
| -------------- | --------------------------------------------------- |
| Framework      | Next.js 16 (App Router), React 19                   |
| Language       | TypeScript (strict, `noUncheckedIndexedAccess`)     |
| Database       | PostgreSQL 17 with pgvector                         |
| Data access    | Drizzle ORM and SQL migrations                      |
| Validation     | Zod (environment and input)                         |
| Styling        | Tailwind CSS 4, light and dark themes               |
| i18n           | Spanish and English, locale-prefixed routes         |
| Testing        | Vitest (unit and integration against real Postgres) |
| Infrastructure | Docker Compose, GitHub Actions                      |

## Getting started

Requirements: Node.js 22+ and Docker.

```bash
git clone https://github.com/Sharps-M/argentine-legislation-rag.git
cd argentine-legislation-rag
cp .env.example .env

docker compose up -d      # PostgreSQL with pgvector
npm install
npm run db:migrate        # creates the schema and enables pgvector
npm run dev
```

Open <http://localhost:3000>. The home page shows whether the database and
vector search are available; `GET /api/health` returns the same report as JSON
(`200` when healthy, `503` otherwise).

## Loading the data

Regulations come from the InfoLEG open dataset. The ingestion command downloads
it, validates every row and loads the chosen subset (by default, laws and decrees
from the last five years). It can be re-run at any time: rows are updated in
place.

```bash
npm run ingest -- --download --dry-run   # validate and report, write nothing
npm run ingest -- --download             # load into PostgreSQL
npm run ingest -- --file data/infoleg/base-infoleg-normativa-nacional.zip --types Ley --since 2020-01-01
```

The report lists how many rows were read, rejected (with the reason and line of
the first ones) and loaded, broken down by type and year. Run
`npm run ingest -- --help` for every option.

## Scripts

| Command                    | What it does                             |
| -------------------------- | ---------------------------------------- |
| `npm run dev`              | Start the development server             |
| `npm run build`            | Production build                         |
| `npm run lint`             | ESLint                                   |
| `npm run typecheck`        | Generate route types and run `tsc`       |
| `npm run format:check`     | Prettier check                           |
| `npm test`                 | Unit tests                               |
| `npm run test:integration` | Integration tests (needs `DATABASE_URL`) |
| `npm run db:migrate`       | Apply SQL migrations                     |
| `npm run ingest`           | Load regulations from the InfoLEG data   |

## Roadmap

- [x] **1. Project foundation** — Next.js, strict TypeScript, PostgreSQL + pgvector,
      Drizzle, bilingual routing, health check, tests and CI
- [x] **2. Metadata ingestion** — validated, idempotent load of laws and decrees from
      the InfoLEG open dataset
- [ ] **3. Full text and chunking** — fetch each regulation and split it by article
- [ ] **4. Embeddings and search** — provider layer (Ollama, Gemini) and similarity search
- [ ] **5. Cited answers** — streamed answers grounded in the retrieved chunks
- [ ] **6. Interface** — search screen with linked citations and filters
- [ ] **7. Release** — screenshots, architecture notes and a public demo

## Data source and disclaimer

Regulations come from the
[InfoLEG national legislation database](https://datos.jus.gob.ar/dataset/base-de-datos-legislativos-infoleg),
published as open data by Argentina's Ministry of Justice under a Creative Commons
Attribution 4.0 license.

This project is **not legal advice** and is not affiliated with any government
agency. Always check the official text.

## Documentation

Design decisions are recorded (in Spanish) in [`docs/decisiones.md`](docs/decisiones.md).

## License

[MIT](LICENSE)
