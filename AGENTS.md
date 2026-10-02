<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project rules

- The code is the source of truth. If docs and code disagree, fix the docs.
- Work in small, verifiable steps: `npm run lint`, `npm run typecheck`,
  `npm test` and `npm run build` must pass before a step is done.
- Never invent versions, commands or APIs: check `package.json` and the
  dependency's own documentation first.
- No secrets or real hosts in the repository. Configuration lives in `.env`.
- Design decisions are recorded in `docs/decisiones.md` (Spanish). Add an entry
  when a decision is made or reversed.
- User-facing strings go in `src/i18n/dictionaries/` (Spanish and English).
