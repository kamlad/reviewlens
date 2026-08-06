import { NextRequest, NextResponse } from "next/server";
import {
  Dataset,
  fallbackAnswer,
  isOutOfScope,
  retrieveEvidence,
} from "@/app/lib/reviewlens";

export const runtime = "edge";

type EnvWithOpenAI = {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
};

export async function POST(request: NextRequest) {
  try {
    const { question, dataset } = (await request.json()) as {
      question?: string;
      dataset?: Dataset;
    };

    if (!question?.trim()) {
      return NextResponse.json(
        { error: "Ask a question about the ingested reviews." },
        { status: 400 },
      );
    }
    if (!dataset?.reviews?.length) {
      return NextResponse.json(
        { error: "Ingest reviews before asking questions." },
        { status: 400 },
      );
    }

    if (isOutOfScope(question, dataset)) {
      return NextResponse.json(fallbackAnswer(question, dataset));
    }

    const env = process.env as EnvWithOpenAI;
    if (!env.OPENAI_API_KEY) {
      return NextResponse.json(fallbackAnswer(question, dataset));
    }

    const evidence = retrieveEvidence(question, dataset.reviews, 10);
    const answer = await askOpenAI({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
      question,
      dataset,
      evidence,
    });

    return NextResponse.json({
      answer,
      citations: evidence.slice(0, 8).map((review) => review.id),
      declined: false,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to answer question.",
      },
      { status: 500 },
    );
  }
}

async function askOpenAI({
  apiKey,
  model,
  question,
  dataset,
  evidence,
}: {
  apiKey: string;
  model: string;
  question: string;
  dataset: Dataset;
  evidence: Dataset["reviews"];
}) {
  const system = `You are ReviewLens AI, an evidence-bound assistant for an ORM analyst.

Scope:
- Answer only about the currently ingested review dataset.
- Platform: ${dataset.platform}
- Product/entity: ${dataset.entityName}
- Source URL: ${dataset.sourceUrl ?? "imported review data"}
- Do not use general world knowledge, live web knowledge, competitor data, or reviews from any other platform.
- If the user asks about another platform, competitors, the weather, news, prices, current events, or facts outside the supplied reviews, explicitly decline in one sentence and redirect to the ingested reviews.
- If the supplied reviews do not contain enough evidence, say so plainly.

Answer style:
- Be concise and useful to a reputation-management analyst.
- Cite review ids in parentheses, for example (R003, R014).
- Separate observations from confidence or caveats.
- Never claim that you scraped, browsed, or verified anything beyond the supplied review records.`;

  const reviewContext = evidence
    .map(
      (review) =>
        `${review.id} | rating=${review.rating ?? "unknown"} | date=${review.date ?? "unknown"} | title=${review.title ?? ""} | body=${review.body}`,
    )
    .join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Question: ${question}\n\nReview evidence:\n${reviewContext}`,
        },
      ],
      temperature: 0.2,
      max_output_tokens: 700,
    }),
  });

  if (!response.ok) {
    return fallbackAnswer(question, dataset).answer;
  }

  const payload = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  return (
    payload.output_text ??
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter(Boolean)
      .join("\n")
      .trim() ??
    fallbackAnswer(question, dataset).answer
  );
}
