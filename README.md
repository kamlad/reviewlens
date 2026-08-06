# ReviewLens AI

ReviewLens AI is a rapid prototype of a review intelligence portal for Online Reputation Management analysts. It ingests a public review footprint or a pasted/exported review file, summarizes the evidence, and exposes a guarded Q&A interface that answers only from the ingested reviews.

## Live Flow

1. Paste one or more Trustpilot review URLs, a CSV export, JSON review export, or review blocks separated by blank lines.
2. Click **Ingest Reviews**.
3. Inspect the ingestion summary: review count, rating mix, date range, recurring terms, warnings, and evidence preview.
4. Ask questions in the Q&A panel.
5. Try a scope-guard prompt such as: `What do Amazon reviews say?` or `What is the weather today?`

## Platform Assumption

The primary live URL target is Trustpilot because its business pages are publicly browsable and review-centric. Some public platforms, including Trustpilot, can present traffic challenges to server-side fetches. ReviewLens detects that condition and keeps the workflow usable through multiple pasted page URLs, pasted review text, CSV/JSON exports, and an indexed fallback for the Living Spaces demo URL.

Accepted CSV columns include:

- `rating` or `stars`
- `body`, `review`, `text`, `content`, or `comment`
- optional `title`, `date`, and `author`

Accepted JSON imports can be either an array of review objects or an object shaped as `{ "reviews": [...] }`. Review objects may include `rating`, `stars`, `body`, `reviewBody`, `text`, `content`, `title`, `author`, `date`, and `sourceUrl`.

## Multi-URL Ingestion

Paste one URL per line in the Review URLs field:

```text
https://www.trustpilot.com/review/www.livingspaces.com
https://www.trustpilot.com/review/www.livingspaces.com?page=2
https://www.trustpilot.com/review/www.livingspaces.com?page=3
```

ReviewLens fetches each URL, extracts review data from every page it can access, deduplicates repeated reviews, and produces one combined summary/evidence set.

## Architecture

- `app/page.tsx`: client-side analyst workspace.
- `app/api/ingest/route.ts`: ingestion endpoint for URL fetches and review exports.
- `app/api/ask/route.ts`: guarded Q&A endpoint.
- `app/lib/reviewlens.ts`: review parsing, normalization, summarization, evidence retrieval, and scope helpers.

The app is built on Next/Vinext for Cloudflare Worker-compatible deployment through Sites. It has no user authentication and keeps the current dataset in browser state.

## Guardrails

Guardrails are enforced by the OpenAI system prompt. The prompt instructs the model to answer only from supplied review records, cite review IDs, make evidence-backed recommendations, and gracefully decline anything outside the dataset, such as other platforms, competitors, live facts, news, weather, or general web knowledge.

The Q&A endpoint requires `OPENAI_API_KEY`. If OpenAI is not configured or the OpenAI request fails, the app returns an error instead of generating a local answer.

## Environment

Create `.env.local` for local development:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

`OPENAI_API_KEY` is required for Q&A. `OPENAI_MODEL` defaults to `gpt-4.1-mini`.

## Setup

```bash
npm install
npm run dev
```

Open the local URL printed by the dev server.

Use `npm run dev:vercel` when testing the future Vercel-oriented Next runtime locally.

## Verification

```bash
npm run build
npm test
```

## Deployment

This repo includes `.openai/hosting.json` for Sites deployment. Hosted runtime variables should be configured in the Sites environment rather than committed.

## AI Transcripts

The assignment asks for full AI session transcripts in `ai-transcripts/`. Add the raw exported Codex/ChatGPT session transcript there before submission. This repository includes the directory and an index file so the deliverable is visible.
