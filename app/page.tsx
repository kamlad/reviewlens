"use client";

import { FormEvent, useMemo, useState } from "react";

type Review = {
  id: string;
  author?: string;
  rating?: number | null;
  title?: string;
  body: string;
  date?: string;
  sourceUrl?: string;
};

type IngestionSummary = {
  sourceUrl?: string;
  platform: string;
  entityName: string;
  reviewCount: number;
  averageRating: number | null;
  ratingDistribution: Record<string, number>;
  dateRange: { earliest: string | null; latest: string | null };
  recurringTerms: Array<{ term: string; count: number }>;
  warnings: string[];
  reviews: Review[];
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: string[];
  declined?: boolean;
};

const sampleCsv = `rating,title,body,date,author
5,Fast support,"The onboarding specialist solved setup problems in one call.",2026-06-12,Avery
2,Billing confusion,"Invoices were hard to reconcile and support gave conflicting answers.",2026-06-19,Jordan
4,Useful dashboards,"Reporting is clear, but the export workflow takes too many clicks.",2026-07-02,Morgan`;

export default function Home() {
  const [url, setUrl] = useState("");
  const [rawReviews, setRawReviews] = useState("");
  const [dataset, setDataset] = useState<IngestionSummary | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Ingest a Trustpilot URL or review export, then ask about the evidence in that review set.",
    },
  ]);
  const [error, setError] = useState("");

  const ratingRows = useMemo(() => {
    if (!dataset) return [];
    return [5, 4, 3, 2, 1].map((rating) => ({
      rating,
      count: dataset.ratingDistribution[String(rating)] ?? 0,
      width:
        dataset.reviewCount > 0
          ? `${(((dataset.ratingDistribution[String(rating)] ?? 0) / dataset.reviewCount) * 100).toFixed(0)}%`
          : "0%",
    }));
  }, [dataset]);

  async function ingest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIngesting(true);
    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), rawReviews }),
      });
      const payload = (await response.json()) as
        | IngestionSummary
        | { error: string };
      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "Ingestion failed");
      }
      setDataset(payload);
      setMessages([
        {
          role: "assistant",
          content: `Ready: ${payload.reviewCount} reviews loaded for ${payload.entityName}.`,
        },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ingestion failed");
    } finally {
      setIngesting(false);
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dataset || !question.trim()) return;

    const nextQuestion = question.trim();
    setQuestion("");
    setMessages((current) => [
      ...current,
      { role: "user", content: nextQuestion },
    ]);
    setAsking(true);
    setError("");

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: nextQuestion, dataset }),
      });
      const payload = (await response.json()) as
        | { answer: string; citations?: string[]; declined?: boolean }
        | { error: string };
      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "Question failed");
      }
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: payload.answer,
          citations: payload.citations,
          declined: payload.declined,
        },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Question failed");
    } finally {
      setAsking(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f4ef] text-[#171614]">
      <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-5 px-4 py-4 lg:px-6">
        <header className="flex flex-col justify-between gap-3 border-b border-[#d7d1c4] pb-4 md:flex-row md:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#6e5840]">
              Review Intelligence Portal
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal text-[#171614] md:text-4xl">
              ReviewLens AI
            </h1>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="status-chip">Trustpilot-first</span>
            <span className="status-chip">Evidence-bound Q&amp;A</span>
            <span className="status-chip">No auth</span>
          </div>
        </header>

        <section className="grid flex-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)_420px]">
          <form
            onSubmit={ingest}
            className="panel flex flex-col gap-4"
            aria-label="Ingest reviews"
          >
            <div>
              <h2 className="section-title">Ingest</h2>
              <label className="field-label" htmlFor="url">
                Trustpilot URL
              </label>
              <input
                id="url"
                className="text-input"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://www.trustpilot.com/review/example.com"
              />
            </div>

            <div>
              <label className="field-label" htmlFor="rawReviews">
                Review export
              </label>
              <textarea
                id="rawReviews"
                className="text-area h-56"
                value={rawReviews}
                onChange={(event) => setRawReviews(event.target.value)}
                placeholder={sampleCsv}
              />
            </div>

            <button className="primary-button" disabled={ingesting}>
              {ingesting ? "Ingesting" : "Ingest Reviews"}
            </button>

            {error ? <p className="alert">{error}</p> : null}

            <div className="quiet-box">
              <p className="metric-label">Accepted input</p>
              <p className="mt-1 text-sm text-[#4d4a43]">
                Public Trustpilot review page, CSV with rating/body columns, or
                pasted review blocks.
              </p>
            </div>
          </form>

          <section className="panel min-w-0" aria-label="Ingestion summary">
            <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
              <div>
                <h2 className="section-title">Summary</h2>
                <p className="text-2xl font-semibold text-[#171614]">
                  {dataset?.entityName ?? "No dataset loaded"}
                </p>
              </div>
              <div className="rounded-md border border-[#d7d1c4] bg-white px-3 py-2 text-right">
                <p className="metric-label">Avg rating</p>
                <p className="text-2xl font-semibold">
                  {dataset?.averageRating?.toFixed(1) ?? "-"}
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <Metric label="Reviews" value={dataset?.reviewCount ?? 0} />
              <Metric
                label="Earliest"
                value={dataset?.dateRange.earliest ?? "-"}
              />
              <Metric label="Latest" value={dataset?.dateRange.latest ?? "-"} />
            </div>

            <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div>
                <h3 className="subhead">Rating Mix</h3>
                <div className="mt-3 space-y-2">
                  {ratingRows.map((row) => (
                    <div key={row.rating} className="rating-row">
                      <span>{row.rating}</span>
                      <div className="bar-track">
                        <div
                          className="bar-fill"
                          style={{ width: row.width }}
                        />
                      </div>
                      <span>{row.count}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="subhead">Recurring Terms</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(dataset?.recurringTerms ?? []).length ? (
                    dataset?.recurringTerms.slice(0, 12).map((term) => (
                      <span key={term.term} className="term-chip">
                        {term.term} <b>{term.count}</b>
                      </span>
                    ))
                  ) : (
                    <span className="empty-text">Waiting for reviews</span>
                  )}
                </div>
              </div>
            </div>

            {dataset?.warnings.length ? (
              <div className="mt-5 rounded-md border border-[#e2ba70] bg-[#fff7e4] p-3 text-sm text-[#6d4d13]">
                {dataset.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}

            <div className="mt-6">
              <h3 className="subhead">Evidence Preview</h3>
              <div className="mt-3 grid max-h-[390px] gap-3 overflow-auto pr-1">
                {(dataset?.reviews ?? []).slice(0, 10).map((review) => (
                  <article key={review.id} className="review-row">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="review-id">{review.id}</span>
                      <span className="rating-pill">
                        {review.rating ? `${review.rating}/5` : "No rating"}
                      </span>
                      {review.date ? (
                        <span className="text-xs text-[#68635a]">
                          {review.date}
                        </span>
                      ) : null}
                    </div>
                    {review.title ? (
                      <h4 className="mt-2 font-semibold text-[#24211c]">
                        {review.title}
                      </h4>
                    ) : null}
                    <p className="mt-1 text-sm leading-6 text-[#4b463d]">
                      {review.body}
                    </p>
                  </article>
                ))}
                {!dataset ? (
                  <div className="empty-state">
                    <p>Paste review data or load a public review URL.</p>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="panel flex min-h-[620px] flex-col" aria-label="Q and A">
            <h2 className="section-title">Ask</h2>
            <div className="chat-log">
              {messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={message.role === "user" ? "bubble user" : "bubble"}
                >
                  <p>{message.content}</p>
                  {message.citations?.length ? (
                    <p className="mt-2 text-xs text-[#6d665c]">
                      Evidence: {message.citations.join(", ")}
                    </p>
                  ) : null}
                  {message.declined ? (
                    <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#8a2d2a]">
                      Scope guard
                    </p>
                  ) : null}
                </div>
              ))}
            </div>

            <form onSubmit={ask} className="mt-4 flex gap-2">
              <input
                className="text-input"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="What are the top pain points?"
                disabled={!dataset || asking}
              />
              <button
                className="icon-button"
                disabled={!dataset || asking || !question.trim()}
                aria-label="Ask question"
              >
                {asking ? "..." : "Ask"}
              </button>
            </form>
          </section>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric-box">
      <p className="metric-label">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
