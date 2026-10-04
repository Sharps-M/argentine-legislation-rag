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

The AI provider sits behind one interface, so it can be swapped without touching
the rest of the code. Embeddings run locally with Ollama (`bge-m3`); nothing
leaves the machine.

## Tech stack

| Layer          | Technology                                          |
| -------------- | --------------------------------------------------- |
| Framework      | Next.js 16 (App Router), React 19                   |
| Language       | TypeScript (strict, `noUncheckedIndexedAccess`)     |
| Database       | PostgreSQL 17 with pgvector                         |
| Data access    | Drizzle ORM and SQL migrations                      |
| AI             | Vercel AI SDK, Ollama (`bge-m3` embeddings)         |
| Vector search  | pgvector HNSW index, cosine distance                |
| Validation     | Zod (environment and input)                         |
| Styling        | Tailwind CSS 4, light and dark themes               |
| i18n           | Spanish and English, locale-prefixed routes         |
| Testing        | Vitest (unit and integration against real Postgres) |
| Infrastructure | Docker Compose, GitHub Actions                      |

## Getting started

Requirements: Node.js 22+, Docker and, for the embeddings,
[Ollama](https://ollama.com) (pgvector 0.8 or newer comes with the Docker image).

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

### Full text and chunks

```bash
npm run texts -- --limit 20   # try it on a few regulations first
npm run texts                 # everything that is still pending
```

Each regulation's page is downloaded from InfoLEG, cleaned and split along its
legal structure: preamble, one chunk per article, closing and annexes.
Regulations without a published text get one chunk built from their title and
abstract, so they stay searchable.

The downloader is deliberately gentle: it identifies itself with a descriptive
`User-Agent`, sends one request per second, backs off on errors and stops if the
server starts refusing requests. Pages are cached under `data/infoleg/html/`, so
the command can be interrupted and resumed, and re-chunking never downloads
anything twice.

### Embeddings

```bash
ollama pull bge-m3              # once: the embedding model (about 1.2 GB)
npm run embed -- --limit 200    # try it on a few chunks first
npm run embed                   # everything that is still pending
```

Each chunk is embedded together with the name, topic and title of its
regulation, and the vector is stored next to it in PostgreSQL with the name of
the model that produced it. Batches are saved as they complete, so the command
can be stopped and resumed. Changing `EMBEDDING_MODEL` marks every chunk as
pending again: vectors from different models are never compared.

## Searching

```bash
npm run search -- "convenio de seguridad social con San Marino"
npm run search -- "impuesto a los combustibles" --type Decreto --from 2026 --limit 5
```

The same search is available over HTTP:

```
GET /api/search?q=impuesto a los combustibles&type=Decreto&from=2026&limit=5
```

| Parameter    | Meaning                                         |
| ------------ | ----------------------------------------------- |
| `q`          | The question, 3 to 500 characters (required)    |
| `limit`      | Chunks to return, 1 to 20 (default 8)           |
| `type`       | Regulation type; repeat or separate with commas |
| `from`, `to` | Range of enactment years                        |

It answers `200` with the chunks ordered by similarity, each with its
regulation and a link to the official text; `400` with the list of problems when
the request is invalid; and `503` when the embedding model cannot be reached.

The question is embedded with the same model and compared by cosine distance
through an HNSW index. Filters are part of the same SQL query, and iterative
index scans keep a selective filter from returning fewer results than asked.

### Measuring the retrieval

```bash
npm run eval
```

Runs a set of questions whose answer is known
([`src/eval/questions.ts`](src/eval/questions.ts)) and reports, overall and by
kind of question, **recall@k** (how often the right regulation is within the
first _k_ chunks) and **MRR** (how close to the top it lands). It is the
yardstick for every later change to chunking, the model or the search.
`--verbose` shows what was retrieved instead of the expected regulation, and
`--exact` bypasses the index to tell model misses from index misses.

Baseline on the full corpus (5,069 regulations, 41,275 chunks) with semantic
search alone:

| Questions            | n   | recall@1 | recall@5 | MRR  |
| -------------------- | --- | -------- | -------- | ---- |
| All                  | 18  | 44%      | 72%      | 0.56 |
| By topic             | 12  | 42%      | 83%      | 0.59 |
| By regulation number | 4   | 50%      | 50%      | 0.50 |
| In English           | 2   | 50%      | 50%      | 0.50 |

Asking for a regulation by its number is the weak spot: an embedding captures
meaning, not digits. Every measurement and what it led to is logged (in
Spanish) in [`docs/evaluacion.md`](docs/evaluacion.md).

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
| `npm run texts`            | Download, clean and chunk the full texts |
| `npm run embed`            | Generate the embedding of each chunk     |
| `npm run search`           | Semantic search from the command line    |
| `npm run eval`             | Measure the retrieval (recall@k, MRR)    |

The integration tests empty the tables they use, so they refuse to run against
a database that holds a real ingestion. Use a separate database for them:

```bash
docker compose exec db createdb -U normativa normativa_test
export DATABASE_URL=postgres://normativa:normativa@localhost:5432/normativa_test
npm run db:migrate && npm run test:integration
```

## Roadmap

- [x] **1. Project foundation** — Next.js, strict TypeScript, PostgreSQL + pgvector,
      Drizzle, bilingual routing, health check, tests and CI
- [x] **2. Metadata ingestion** — validated, idempotent load of laws and decrees from
      the InfoLEG open dataset
- [x] **3. Full text and chunking** — polite, resumable download of each regulation,
      split along its legal structure (preamble, articles, annexes)
- [x] **4. Embeddings and search** — local embeddings behind a provider interface,
      HNSW index, similarity search with filters and a retrieval evaluation
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

Design decisions are recorded (in Spanish) in [`docs/decisiones.md`](docs/decisiones.md),
and retrieval measurements in [`docs/evaluacion.md`](docs/evaluacion.md).

## License

[MIT](LICENSE)
