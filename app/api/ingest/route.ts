import { NextRequest, NextResponse } from "next/server";
import { ingestReviews } from "@/app/lib/reviewlens";

export const runtime = "edge";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      url?: string;
      urls?: string[];
      rawReviews?: string;
    };

    const urls = normalizeUrls(body.urls, body.url);
    if (!urls.length && !body.rawReviews?.trim()) {
      return NextResponse.json(
        { error: "Provide one or more public review URLs or pasted review data." },
        { status: 400 },
      );
    }

    const dataset = await ingestReviews({
      urls,
      rawReviews: body.rawReviews,
    });

    return NextResponse.json(dataset);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to ingest reviews.",
      },
      { status: 400 },
    );
  }
}

function normalizeUrls(urls?: string[], url?: string) {
  return [...(urls ?? []), url ?? ""]
    .flatMap((item) => item.split(/[\n,]+/))
    .map((item) => item.trim())
    .filter(Boolean);
}
