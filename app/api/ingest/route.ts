import { NextRequest, NextResponse } from "next/server";
import { ingestReviews } from "@/app/lib/reviewlens";

export const runtime = "edge";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      url?: string;
      rawReviews?: string;
    };

    if (!body.url?.trim() && !body.rawReviews?.trim()) {
      return NextResponse.json(
        { error: "Provide a public review URL or pasted review data." },
        { status: 400 },
      );
    }

    const dataset = await ingestReviews({
      url: body.url?.trim(),
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
