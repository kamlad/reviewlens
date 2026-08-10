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

The production deployment target is Vercel running the Next.js app. The app has no user authentication and keeps the current dataset in browser state.

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
npm run dev:vercel
```

Open the local URL printed by the dev server.

`npm run dev` is reserved for the Vinext/Sites runtime. Use `npm run dev:vercel` for the production-oriented Vercel/Next.js runtime.

## Verification

```bash
npm run lint
npm test
npm run build:vercel
npm run build
```

`npm run build:vercel` runs `next build` and is the command Vercel should use. `npm run build` runs the Vinext build and is kept only for local compatibility with the original Sites scaffold.

## Deployment

This project is intended to be deployed to Vercel as a Next.js app.

The repo includes `vercel.json` so Vercel uses the correct production build:

```json
{
  "installCommand": "npm ci",
  "buildCommand": "npm run build:vercel"
}
```

Vercel project settings:

- Framework Preset: Next.js
- Install Command: `npm ci`
- Build Command: `npm run build:vercel`
- Output Directory: leave blank
- Production Branch: `main`

Required Vercel environment variables:

```text
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

Do not commit `.env.local` or API keys. Configure runtime variables in Vercel Project Settings.

## AI Transcripts

The assignment asks for full AI session transcripts in `ai-transcripts/`. Add the raw exported Codex/ChatGPT session transcript there before submission. This repository includes the directory and an index file so the deliverable is visible.
