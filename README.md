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

Each AI provider sits behind an interface, so it can be swapped without touching
the rest of the code. Embeddings run locally with Ollama (`bge-m3`). Answers are
written by a chain of models: Gemini through its free tier, any other hosted
service, and a local model as the one that is always there.

## Tech stack

| Layer          | Technology                                          |
| -------------- | --------------------------------------------------- |
| Framework      | Next.js 16 (App Router), React 19                   |
| Language       | TypeScript (strict, `noUncheckedIndexedAccess`)     |
| Database       | PostgreSQL 17 with pgvector                         |
| Data access    | Drizzle ORM and SQL migrations                      |
| AI             | Vercel AI SDK, Ollama (`bge-m3`), Gemini or local   |
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

Recent is not the same as in force: a law from 1954 can still apply. The corpus
behind the measurements below adds every law and decree-law in the dataset,
whatever its date, to the default subset:

```bash
npm run ingest -- --file data/infoleg/base-infoleg-normativa-nacional.zip --types "Ley,Decreto/Ley" --all-dates
```

Loads add to what is already there, so subsets can be combined.

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
npm run search -- "¿qué dispone el Decreto 833/2026?"
```

The same search is available over HTTP:

```
GET /api/search?q=impuesto a los combustibles&type=Decreto&from=2026&limit=5
```

| Parameter        | Meaning                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `q`              | The question, 3 to 500 characters (required)                               |
| `limit`          | Chunks to return, 1 to 20 (default 8)                                      |
| `type`           | Regulation type; repeat or separate with commas                            |
| `from`, `to`     | Range of enactment years                                                   |
| `min_similarity` | How close a chunk must be to count, 0 to 1 (default 0.55)                  |
| `versions`       | How alike two texts must be to be listed together, or `off` (default 0.95) |

It answers `200` with the chunks, best first, each with its regulation and a
link to the official text; `400` with the list of problems when
the request is invalid; and `503` when the embedding model cannot be reached.

Two searches are combined, the way a legal clerk would work:

- **By citation.** If the question names a regulation ("Ley 27.818",
  "Decreto N° 833/2026", "DNU 70/23"), it is looked up by type, number and
  year, and its chunks go first. This is exact: it does not depend on the model
  or on the index.
- **By meaning.** The question is embedded with the same model and compared by
  cosine distance through an HNSW index. Filters are part of the same SQL
  query, and iterative index scans keep a selective filter from returning fewer
  results than asked.

Each result says why it is there (`"match": "reference"` or `"semantic"`). A
cited regulation takes at most half of the results, so the rest stay open to
what the question is about.

The search is strict about the question: a chunk found by meaning must reach a
minimum similarity, or it is left out. A similarity search always has a
"nearest" chunk, however far; asked about pets, it used to answer with
regulations on zoonoses and livestock. Now, when nothing is close enough, the
answer is an empty list and the command says so. A regulation cited by number
is never left out. The minimum, 0.55, was chosen by measuring: it keeps every
right answer of the evaluation and rejects its five questions about subjects
the corpus does not cover.

Some provisions are reissued every few months: each pay decree repeats the same
article with new amounts. To the model they are one text, so a search returned
them all a few thousandths apart, last year's often first. Chunks of different
regulations, enacted on different days, whose texts are nearly identical are
now listed together: the most recent leads and the others go under it
(`earlierVersions`), each with its date and link. Nothing is hidden, and nothing
is claimed beyond "nearly the same text": the dataset does not say which
regulation repealed which.

## Answering

```bash
npm run ask -- "¿Cuál es el tope de la retribución por servicios extraordinarios?"
```

`npm run ask` and `GET /api/answer` (same parameters as `/api/search`) answer a
question from the chunks the search finds. The model gets those chunks,
numbered, and a short set of rules: use only the sources, put the number of the
source after every statement (`[1]`), say so when the sources do not answer,
and never claim a regulation is still in force, which the data does not tell.

The answer comes in Spanish or in English. The page a question comes from says
which (`lang=es` or `lang=en`); when nobody says, it is guessed from the
question. That choice is made in code and not left to the model: the rules, the
labels around the sources and a last line after the question are all written in
the language of the answer. A small local model writes in the language it is
spoken to, whatever a rule tells it: asked in Spanish under English rules, it
answered in English.

The endpoint streams server-sent events, so a reader sees the answer as it is
written:

| Event     | When                        | Data                                                                                                                    |
| --------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `sources` | First, always               | The chunks, numbered, each with its regulation, date and link                                                           |
| `asking`  | Before the text             | The model that is being asked: what a wait is a wait for                                                                |
| `skipped` | Before the text, if any     | A model that could not answer, why, and how long it was waited for                                                      |
| `text`    | Many times                  | A piece of the answer                                                                                                   |
| `done`    | Last, when the answer ended | How it ended, who wrote it, the sources it cites, any citation of a source that does not exist, and where the time went |
| `error`   | Last, when the model failed | Why: no key, key rejected, usage limit, or model unreachable                                                            |

What makes the answer checkable is done in code, not asked of the model:

- **Nothing found, nothing asked.** When the search returns no chunk, the answer
  ends as `no_sources` and the model is never called. A model with no sources
  can only make things up.
- **Citations are verified.** Every `[n]` in the answer is checked against the
  sources. A number that points at no source is reported (`unknownCitations`),
  and an answer that cites nothing is marked `uncited`.
- **The sources go first.** They are sent before the model is asked, so they
  reach the reader even if the model then fails.

Who writes the answer is a chain, set up in `.env`:

| Setting                                       | Provider                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`, `GEMINI_MODEL`              | Gemini, with a free key from [Google AI Studio](https://aistudio.google.com/apikey) |
| `CHAT_BASE_URL`, `CHAT_API_KEY`, `CHAT_MODEL` | Any service that speaks OpenAI's API: Groq, OpenRouter, Cerebras...                 |
| `OLLAMA_CHAT_MODEL`                           | A model on the local Ollama (`ollama pull gemma3:4b`)                               |
| `CHAT_PROVIDER`                               | Which of them to use, and in what order; all of them by default                     |

A free tier comes with no promise of capacity: the first real question got
"this model is currently experiencing high demand". So no answer depends on one
model. Every provider that is configured is tried in order, each with its own
list of models: Gemini's lightest Flash first, then two bigger ones; then the
OpenAI-compatible service; and last the local model, which writes worse and is
always there. When a model cannot answer, a `skipped` event says which one and
why, and the next is asked.

The lightest Gemini goes first because of what was measured, not of what was
expected: on the free tier, the two bigger models did not answer once in
fourteen tries, and cost up to thirty-two seconds a question before the lightest
was asked.

Three rules keep the chain honest:

- **Only before the first word.** Half an answer from one model is never
  continued by another.
- **A rejected key rules out its provider**, not the others: the next model of
  the same provider would be refused too.
- **Silence is a failure.** A model that has not written anything in thirty
  seconds (three minutes for the local one, which has to be loaded first) is
  passed over, and so is one that ends without a word.

The answer says who wrote it and where the time went: the search, the first
word, the total. With Gemini's free tier, the question and the
chunks are sent to Google, which may use them to improve its products. The
chunks are public law; the question is whatever the reader types.
`CHAT_PROVIDER=ollama` keeps both on the machine.

### Measuring the retrieval

```bash
npm run eval
```

Runs a set of questions whose answer is known
([`src/eval/questions.ts`](src/eval/questions.ts)) and reports, overall and by
kind of question, **recall@k** (how often the right regulation is within the
first _k_ chunks) and **MRR** (how close to the top it lands). It is the
yardstick for every later change to chunking, the model or the search.
`--verbose` shows what was retrieved instead of the expected regulation,
`--exact` bypasses the index to tell model misses from index misses,
`--semantic-only` leaves the lookup by citation out, `--sweep` compares index
settings against the exact scan, in quality and time, and `--floors` compares
minimum similarities: answers kept against unrelated results rejected.
`--versions-sweep` compares ways of grouping reissued provisions: what the
latest issue gains against what an earlier one loses. The set includes
questions about subjects the corpus does not cover, which must come back empty,
and questions that ask for an issue that is not the latest of its series.

Measured on the full corpus (34,973 regulations, 211,770 chunks), 25
questions with a known answer, similarity search alone:

| Search                         | recall@1 | recall@5 | MRR  | Time per query |
| ------------------------------ | -------- | -------- | ---- | -------------- |
| Exact scan (no index)          | 56%      | 84%      | 0.70 | 622 ms         |
| HNSW index, pgvector's default | 52%      | 76%      | 0.64 | 5 ms           |
| HNSW index, `ef_search = 100`  | 56%      | 84%      | 0.70 | 8 ms           |

With its default settings the approximate index was skipping answers the model
does find; at `ef_search = 100` it finds the same ones as the exact scan, some
eighty times faster. That is the value the search uses. Five more questions,
about subjects the corpus does not cover, all come back empty.

The same measurements were taken on a corpus a fifth of this size. The index
setting held; the minimum similarity did not, and had to come down from 0.57 to
0.55.

The grouping of reissued provisions was measured on the whole search (lookup by
citation, minimum similarity). The first three columns are the 22 questions
that ask for the regulation in force; the last one, three questions that ask
for an issue that is not the latest of its series, which is what the grouping
could hurt:

| Grouping                                | recall@1 | recall@5 | MRR  | Earlier issues, recall@5 |
| --------------------------------------- | -------- | -------- | ---- | ------------------------ |
| Off                                     | 64%      | 86%      | 0.75 | 67%                      |
| 0.95, compared with the group's best    | 73%      | 95%      | 0.83 | 33%                      |
| 0.95, compared with any member (chosen) | 82%      | 95%      | 0.88 | 67%                      |

Comparing each chunk with the best one of its group cut a series into pieces
and buried one of the earlier answers; linking through any member keeps the
series whole. It is not free. One of the earlier answers goes from second place
to fourth, with its article listed under the first result; and a query takes
28 ms instead of 9, because a hundred chunks are fetched and compared with each
other.

What the search still gets wrong:

- **Very broad questions.** "Regulations about pets" finds animal-health laws
  before the pet laws, which never use that word.
- **One issue singled out by its date.** Asked for the agreement of 28 May, the
  decree that approves the one of 25 August scores 0.787 and the right one
  0.781.
- **A question the model simply misses**: the decree that removes a secretariat
  from the organisation chart is not among the first twenty, with or without
  the index.

Every measurement and what it led to is logged (in Spanish) in
[`docs/evaluacion.md`](docs/evaluacion.md).

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
| `npm run ask`              | Answer a question, citing its sources    |
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
