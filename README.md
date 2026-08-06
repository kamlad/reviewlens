# ReviewLens AI

ReviewLens AI is a rapid prototype of a review intelligence portal for Online Reputation Management analysts. It ingests a public review footprint or a pasted/exported review file, summarizes the evidence, and exposes a guarded Q&A interface that answers only from the ingested reviews.

## Live Flow

1. Paste a Trustpilot review URL, a CSV export, or review blocks separated by blank lines.
2. Click **Ingest Reviews**.
3. Inspect the ingestion summary: review count, rating mix, date range, recurring terms, warnings, and evidence preview.
4. Ask questions in the Q&A panel.
5. Try a scope-guard prompt such as: `What do Amazon reviews say?` or `What is the weather today?`

## Platform Assumption

The primary live URL target is Trustpilot because its business pages are publicly browsable and review-centric. Some public platforms, including Trustpilot, can present bot or traffic challenges to server-side fetches. ReviewLens detects that condition and keeps the workflow usable through pasted review text or CSV exports.

Accepted CSV columns include:

- `rating` or `stars`
- `body`, `review`, `text`, `content`, or `comment`
- optional `title`, `date`, and `author`

## Architecture

- `app/page.tsx`: client-side analyst workspace.
- `app/api/ingest/route.ts`: ingestion endpoint for URL fetches and review exports.
- `app/api/ask/route.ts`: guarded Q&A endpoint.
- `app/lib/reviewlens.ts`: review parsing, normalization, summarization, retrieval, scope checks, and fallback answer generation.

The app is built on Next/Vinext for Cloudflare Worker-compatible deployment through Sites. It has no user authentication and keeps the current dataset in browser state.

## Guardrails

Guardrails are enforced in two places:

- deterministic server-side scope checks reject obvious requests about other platforms, competitors, live facts, news, weather, and general web knowledge;
- the OpenAI system prompt instructs the model to answer only from supplied review records, cite review IDs, and decline anything outside the dataset.

When `OPENAI_API_KEY` is absent, the app still returns an extractive evidence-bound answer so the prototype remains demoable without paid inference.

## Environment

Create `.env.local` for local development:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

`OPENAI_API_KEY` is optional. `OPENAI_MODEL` defaults to `gpt-4.1-mini`.

## Setup

```bash
npm install
npm run dev
```

Open the local URL printed by the dev server.

## Verification

```bash
npm run build
npm test
```

## Deployment

This repo includes `.openai/hosting.json` for Sites deployment. Hosted runtime variables should be configured in the Sites environment rather than committed.

## AI Transcripts

The assignment asks for full AI session transcripts in `ai-transcripts/`. Add the raw exported Codex/ChatGPT session transcript there before submission. This repository includes the directory and an index file so the deliverable is visible.
