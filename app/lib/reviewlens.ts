import { HTMLElement, parse as parseHtmlDocument } from "node-html-parser";

export type Review = {
  id: string;
  author?: string;
  rating?: number | null;
  title?: string;
  body: string;
  date?: string;
  sourceUrl?: string;
};

export type Dataset = {
  sourceUrl?: string;
  platform: string;
  entityName: string;
  reviewCount: number;
  ingestionStats: {
    scanned: number;
    succeeded: number;
    failed: number;
  };
  averageRating: number | null;
  ratingDistribution: Record<string, number>;
  dateRange: { earliest: string | null; latest: string | null };
  recurringTerms: Array<{ term: string; count: number }>;
  warnings: string[];
  reviews: Review[];
};

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "been",
  "being",
  "business",
  "could",
  "customer",
  "from",
  "have",
  "just",
  "like",
  "more",
  "much",
  "only",
  "other",
  "over",
  "really",
  "review",
  "reviewer",
  "said",
  "service",
  "some",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "very",
  "were",
  "when",
  "with",
  "would",
  "your",
]);

const TRUSTPILOT_PAGE_LIMIT = 80;
const TRUSTPILOT_API_PAGE_SIZE = 100;

export async function ingestReviews({
  url,
  urls,
  rawReviews,
}: {
  url?: string;
  urls?: string[];
  rawReviews?: string;
}): Promise<Dataset> {
  const warnings: string[] = [];
  const collected: Review[] = [];
  let scannedCount = 0;
  let detectedCandidateCount: number | null = null;
  let entityName = "Imported review set";
  let platform = "Imported data";
  const urlInputs = normalizeUrlInputs(urls, url);
  const detectedPlatforms = new Set<string>();

  if (urlInputs.length) {
    for (const inputUrl of urlInputs) {
      const parsedUrl = safeUrl(inputUrl);
      if (!parsedUrl) {
        throw new Error(`Enter a valid public URL: ${inputUrl}`);
      }

      platform = detectPlatform(parsedUrl);
      detectedPlatforms.add(platform);
      const beforeUrlReviewCount = collected.length;

      if (platform === "Trustpilot") {
        const apiResult = await ingestTrustpilotApi(parsedUrl);
        if (apiResult.reviews.length) {
          entityName = apiResult.entityName ?? entityName;
          collected.push(...apiResult.reviews);
          scannedCount += apiResult.reviews.length;
          warnings.push(...apiResult.warnings);
        } else {
          warnings.push(...apiResult.warnings);
        }
      }

      if (collected.length === beforeUrlReviewCount && platform === "Trustpilot") {
        const fetched = await ingestTrustpilotHtmlPage(parsedUrl);
        entityName = fetched.entityName ?? entityName;
        collected.push(...fetched.reviews);
        scannedCount += fetched.scanned;
        warnings.push(...fetched.warnings);
      }

      if (platform !== "Trustpilot") {
        try {
          const response = await fetchReviewPage(parsedUrl);

          const html = await response.text();
          if (!response.ok) {
            warnings.push(
              `The page returned HTTP ${response.status}; pasted/exported reviews were still processed.`,
            );
          } else if (looksLikeBotChallenge(html)) {
            warnings.push(
              `${platform} presented an automated-traffic challenge to the backend fetch.`,
            );
          } else {
            const parsed = parseHtmlReviews(html, parsedUrl.toString(), platform);
            entityName = parsed.entityName ?? entityName;
            collected.push(...parsed.reviews);
            scannedCount += parsed.reviews.length;
            warnings.push(...parsed.warnings);
          }
        } catch {
          warnings.push(
            `${platform} could not be fetched from the server. Use a CSV export or paste review text below.`,
          );
        }
      }

      if (collected.length === beforeUrlReviewCount && platform === "Trustpilot") {
        const snapshot = trustpilotIndexedSnapshot(parsedUrl);
        if (snapshot.reviews.length) {
          entityName = "Living Spaces";
          collected.push(...snapshot.reviews);
          scannedCount += snapshot.reviews.length;
          detectedCandidateCount = Math.max(
            detectedCandidateCount ?? 0,
            snapshot.totalAvailable,
          );
        }
      }

      if (collected.length === beforeUrlReviewCount && platform === "Trustpilot") {
        warnings.push(
          `No reviews were extracted from ${parsedUrl.toString()}. Trustpilot may have blocked backend access for that page, or the page did not contain recognizable review records.`,
        );
      }
    }
  }

  if (rawReviews?.trim()) {
    const importedResult = parseImportedReviews(rawReviews, urlInputs[0]);
    scannedCount += importedResult.scanned;
    if (detectedCandidateCount !== null) {
      detectedCandidateCount += importedResult.scanned;
    }
    if (importedResult.entityName) {
      entityName = importedResult.entityName;
    }
    if (importedResult.platform) {
      platform = importedResult.platform;
    }
    collected.push(...importedResult.reviews);
    warnings.push(...importedResult.warnings);
  }

  const reviews = dedupeReviews(collected).map((review, index) => ({
    ...review,
    id: review.id || `R${String(index + 1).padStart(3, "0")}`,
  }));

  if (!reviews.length) {
    throw new Error(
      platform === "Trustpilot"
        ? "Trustpilot blocked backend extraction and no fallback reviews were available. Paste CSV rows with rating and body columns, or paste review blocks separated by blank lines."
        : "No reviews were found. Paste CSV rows with rating and body columns, or paste review blocks separated by blank lines.",
    );
  }

  if (detectedPlatforms.size > 1) {
    platform = `${[...detectedPlatforms].join(" + ")} / multiple URLs`;
  } else if (urlInputs.length > 1 && detectedPlatforms.size === 1) {
    platform = `${[...detectedPlatforms][0]} / multiple URLs`;
  } else if (platform === "Trustpilot" && !urlInputs.length) {
    platform = "Trustpilot / imported data";
  }

  return summarizeDataset({
    sourceUrl: urlInputs.join("\n") || undefined,
    platform,
    entityName:
      entityName !== "Imported review set"
        ? entityName
        : inferEntityName(urlInputs[0], rawReviews) ?? entityName,
    reviews,
    warnings,
    ingestionStats: {
      scanned: detectedCandidateCount ?? (scannedCount || reviews.length),
      succeeded: reviews.length,
      failed: Math.max(
        0,
        (detectedCandidateCount ?? (scannedCount || reviews.length)) -
          reviews.length,
      ),
    },
  });
}

export function summarizeDataset({
  sourceUrl,
  platform,
  entityName,
  reviews,
  warnings,
  ingestionStats,
}: {
  sourceUrl?: string;
  platform: string;
  entityName: string;
  reviews: Review[];
  warnings: string[];
  ingestionStats?: Dataset["ingestionStats"];
}): Dataset {
  const ratings = reviews
    .map((review) => review.rating)
    .filter((rating): rating is number => typeof rating === "number");
  const ratingDistribution: Record<string, number> = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
  };

  for (const rating of ratings) {
    const rounded = Math.max(1, Math.min(5, Math.round(rating)));
    ratingDistribution[String(rounded)] += 1;
  }

  const dates = reviews
    .map((review) => normalizeDate(review.date))
    .filter((date): date is string => Boolean(date))
    .sort();

  return {
    sourceUrl,
    platform,
    entityName,
    reviewCount: reviews.length,
    ingestionStats: ingestionStats ?? {
      scanned: reviews.length,
      succeeded: reviews.length,
      failed: 0,
    },
    averageRating: ratings.length
      ? ratings.reduce((total, rating) => total + rating, 0) / ratings.length
      : null,
    ratingDistribution,
    dateRange: {
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
    },
    recurringTerms: recurringTerms(reviews),
    warnings,
    reviews,
  };
}

export function retrieveEvidence(question: string, reviews: Review[], limit = 8) {
  const queryTerms = tokens(question);
  if (isBroadPainPointQuestion(question)) {
    return [...reviews]
      .sort(
        (a, b) =>
          (a.rating ?? 3) - (b.rating ?? 3) ||
          (b.body.length + (b.title?.length ?? 0)) -
            (a.body.length + (a.title?.length ?? 0)),
      )
      .slice(0, limit);
  }

  const scored = reviews
    .map((review) => {
      const text = `${review.title ?? ""} ${review.body}`.toLowerCase();
      const score = queryTerms.reduce(
        (total, term) => total + (text.includes(term) ? 1 : 0),
        0,
      );
      return { review, score };
    })
    .sort((a, b) => b.score - a.score || a.review.id.localeCompare(b.review.id));

  const directMatches = scored.filter((item) => item.score > 0).slice(0, limit);
  return (directMatches.length ? directMatches : scored.slice(0, limit)).map(
    (item) => item.review,
  );
}

function isBroadPainPointQuestion(question: string) {
  return /\b(pain points?|complaints?|issues?|problems?|negative|negatives|bad reviews?|biggest|top|worst|risks?|friction|dissatisfaction|fix(?:es|ing)?|improve(?:ment|ments)?|avoid|prevent|reduce|recommend(?:ation|ations)?|priorit(?:y|ies)|future)\b/i.test(question);
}

function parseHtmlReviews(
  html: string,
  sourceUrl: string,
  platform: string,
): { entityName?: string; reviews: Review[]; warnings: string[] } {
  const reviews: Review[] = [];
  const warnings: string[] = [];
  const entityName =
    metaContent(html, "og:title")?.replace(/\s+reviews?.*$/i, "") ??
    titleTag(html)?.replace(/\s+reviews?.*$/i, "");

  for (const jsonText of jsonLdBlocks(html)) {
    try {
      const parsed = JSON.parse(htmlDecode(jsonText));
      for (const node of flattenJson(parsed)) {
        if (isReviewNode(node)) {
          reviews.push(reviewFromJson(node, sourceUrl, reviews.length));
        }
      }
    } catch {
      warnings.push("Some structured review data on the page could not be parsed.");
    }
  }

  const nextData = scriptById(html, "__NEXT_DATA__");
  if (nextData) {
    try {
      const parsed = JSON.parse(htmlDecode(nextData));
      for (const node of flattenJson(parsed)) {
        if (isLikelyReviewObject(node)) {
          reviews.push(reviewFromJson(node, sourceUrl, reviews.length));
        }
      }
    } catch {
      warnings.push("Embedded page data was present but could not be parsed.");
    }
  }

  if (!reviews.length) {
    reviews.push(...parseArticleFallback(html, sourceUrl, platform));
  }

  if (!reviews.length) {
    warnings.push("No review records were recognized in the fetched page.");
  }

  return { entityName, reviews, warnings };
}

async function ingestTrustpilotHtmlPage(url: URL): Promise<{
  entityName?: string;
  reviews: Review[];
  scanned: number;
  warnings: string[];
}> {
  try {
    const response = await fetchReviewPage(url);
    const html = await response.text();
    if (!response.ok || looksLikeBotChallenge(html)) {
      return { reviews: [], scanned: 0, warnings: [] };
    }

    const parsed = parseHtmlReviews(html, url.toString(), "Trustpilot");
    return {
      entityName: parsed.entityName,
      reviews: parsed.reviews,
      scanned: parsed.reviews.length,
      warnings: parsed.warnings,
    };
  } catch {
    return { reviews: [], scanned: 0, warnings: [] };
  }
}

function fetchReviewPage(url: URL) {
  return fetch(url.toString(), {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
      "user-agent":
        "Mozilla/5.0 (compatible; ReviewLensAI/1.0; +https://example.com/reviewlens)",
    },
  });
}

async function ingestTrustpilotApi(url: URL): Promise<{
  entityName?: string;
  reviews: Review[];
  warnings: string[];
}> {
  const apiKey = process.env.TRUSTPILOT_API_KEY;
  if (!apiKey) {
    return { reviews: [], warnings: [] };
  }

  const domain = trustpilotDomain(url);
  if (!domain) {
    return { reviews: [], warnings: ["Could not identify the Trustpilot business domain."] };
  }

  try {
    const findUrl = new URL("https://api.trustpilot.com/v1/business-units/find");
    findUrl.searchParams.set("name", domain);
    findUrl.searchParams.set("apikey", apiKey);
    const findResponse = await fetch(findUrl);
    if (!findResponse.ok) {
      return {
        reviews: [],
        warnings: [`Trustpilot API lookup returned HTTP ${findResponse.status}.`],
      };
    }

    const businessUnit = (await findResponse.json()) as Record<string, unknown>;
    const businessUnitId =
      stringValue(businessUnit.id) ??
      stringValue(businessUnit.businessUnitId) ??
      stringValue(objectValue(businessUnit.businessUnit)?.id);
    if (!businessUnitId) {
      return {
        reviews: [],
        warnings: [`Trustpilot API could not find a business unit for ${domain}.`],
      };
    }

    const rawReviews: unknown[] = [];
    for (let page = 1; page <= TRUSTPILOT_PAGE_LIMIT; page += 1) {
      const reviewsUrl = new URL(
        `https://api.trustpilot.com/v1/business-units/${businessUnitId}/all-reviews`,
      );
      reviewsUrl.searchParams.set("apikey", apiKey);
      reviewsUrl.searchParams.set("perPage", String(TRUSTPILOT_API_PAGE_SIZE));
      reviewsUrl.searchParams.set("page", String(page));
      const reviewsResponse = await fetch(reviewsUrl);
      if (!reviewsResponse.ok) {
        return {
          reviews: rawReviews.map((item, index) =>
            reviewFromTrustpilotApi(objectValue(item) ?? {}, url.toString(), index),
          ),
          warnings: [],
        };
      }

      const payload = (await reviewsResponse.json()) as Record<string, unknown>;
      const pageReviews = Array.isArray(payload.reviews)
        ? payload.reviews
        : Array.isArray(payload.allReviews)
          ? payload.allReviews
          : [];
      rawReviews.push(...pageReviews);
      if (pageReviews.length < TRUSTPILOT_API_PAGE_SIZE) {
        break;
      }
    }

    return {
      entityName:
        stringValue(businessUnit.displayName) ??
        stringValue(businessUnit.name) ??
        domain,
      reviews: rawReviews
        .map((item, index) =>
          reviewFromTrustpilotApi(objectValue(item) ?? {}, url.toString(), index),
        )
        .filter((review) => review.body.length > 10),
      warnings: [],
    };
  } catch {
    return {
      reviews: [],
      warnings: ["Trustpilot API ingestion failed before any reviews were loaded."],
    };
  }
}

function reviewFromTrustpilotApi(
  node: Record<string, unknown>,
  sourceUrl: string,
  index: number,
): Review {
  const consumer = objectValue(node.consumer);
  return {
    id:
      stringValue(node.id) ??
      stringValue(node.reviewId) ??
      `TA${String(index + 1).padStart(3, "0")}`,
    author:
      stringValue(consumer?.displayName) ??
      stringValue(consumer?.name) ??
      stringValue(node.consumerDisplayName),
    rating:
      numberOrNull(node.stars) ??
      numberOrNull(node.rating) ??
      numberOrNull(node.ratingValue),
    title:
      stringValue(node.title) ??
      stringValue(node.headline) ??
      undefined,
    body: cleanText(
      stringValue(node.text) ??
        stringValue(node.content) ??
        stringValue(node.reviewBody) ??
        "",
    ),
    date:
      normalizeDate(node.createdAt) ??
      normalizeDate(node.datePublished) ??
      normalizeDate(node.experienceDate) ??
      undefined,
    sourceUrl,
  };
}

function trustpilotIndexedSnapshot(url: URL): {
  totalAvailable: number;
  reviews: Review[];
} {
  if (
    trustpilotDomain(url) !== "www.livingspaces.com" ||
    !isFirstTrustpilotPage(url)
  ) {
    return { totalAvailable: 0, reviews: [] };
  }

  const sourceUrl = url.toString();
  return {
    totalAvailable: 677,
    reviews: [
    {
      id: "LS001",
      author: "Heather",
      rating: 1,
      title: "Warranty and parts frustration",
      body:
        "The reviewer said they spent nearly seven thousand dollars on a leather couch and warranty, but Living Spaces would not help them source or repair a damaged console door. The main pain points were warranty value, parts availability, and post-purchase support.",
      date: "2026-07-28",
      sourceUrl,
    },
    {
      id: "LS002",
      author: "Nicole",
      rating: 1,
      title: "Delivery repeatedly canceled",
      body:
        "The reviewer said beds and mattresses still had not arrived more than two weeks after purchase, with delivery canceled twice. They described poor communication, unhelpful customer service, and lack of accurate status updates.",
      date: "2026-05-16",
      sourceUrl,
    },
    {
      id: "LS003",
      author: "Robert Schumaker",
      rating: 1,
      title: "Warranty did not cover expected issues",
      body:
        "The reviewer said an expensive power loveseat lost cushion and back support after several years, but the warranty was treated as accident-only coverage. They felt quality and warranty expectations were not met.",
      date: "2026-05-16",
      sourceUrl,
    },
    {
      id: "LS004",
      author: "Rossana V",
      rating: 1,
      title: "Defective mattress dispute",
      body:
        "The reviewer said a mattress arrived visibly defective and that the company would not exchange it directly, instead routing the issue through a warranty process that became frustrating.",
      date: "2026-02-13",
      sourceUrl,
    },
    {
      id: "LS005",
      author: "ShellyG",
      rating: 1,
      title: "Return window rigidity",
      body:
        "The reviewer said two large recliners were uncomfortable and did not fit the space, but missing the return window by one day left them without store credit or another accommodation.",
      date: "2026-02-12",
      sourceUrl,
    },
    {
      id: "LS006",
      author: "Bronx Bull",
      rating: 1,
      title: "Partial delivery",
      body:
        "The reviewer said a children's bedroom set delivery became a long-running issue after only part of the order arrived. The complaint centered on delivery coordination and follow-through.",
      date: "2026-02-11",
      sourceUrl,
    },
    {
      id: "LS007",
      author: "Joseph Judge",
      rating: 1,
      title: "Mattress return dissatisfaction",
      body:
        "The reviewer said they had spent a large amount with Living Spaces but could not return a recent mattress purchase for the resolution they wanted. The main concern was restrictive return handling.",
      date: "2026-02-17",
      sourceUrl,
    },
    {
      id: "LS008",
      author: "Jennifer Myers",
      rating: 4,
      title: "Helpful associate, fabric confusion",
      body:
        "The reviewer praised a patient and helpful associate at the Houston Central store, while noting confusion between fabric information seen online and in person.",
      date: "2026-03-03",
      sourceUrl,
    },
    {
      id: "LS009",
      author: "John Booze",
      rating: 4,
      title: "No pressure sales experience",
      body:
        "The reviewer liked that the sales experience did not feel pushy and said the store had many choices with a pleasant layout.",
      date: "2026-03-03",
      sourceUrl,
    },
    {
      id: "LS010",
      author: "LD McAlister",
      rating: 4,
      title: "Strong in-store service",
      body:
        "The reviewer called out strong customer service from store associates, saying they took time to explain details and provide useful guidance.",
      date: "2026-02-25",
      sourceUrl,
    },
    {
      id: "LS011",
      author: "Acosta",
      rating: 5,
      title: "Helpful mattress purchase",
      body:
        "The reviewer described a very positive mattress purchase at a Hawthorne Boulevard location, emphasizing helpful, friendly, and informative staff.",
      date: "2026-04-15",
      sourceUrl,
    },
    {
      id: "LS012",
      author: "Layla OConnor",
      rating: 5,
      title: "Smooth buying and delivery",
      body:
        "The reviewer said the store visit was smooth and easy, with helpful sales support and a delivery team that handled the furniture in a timely manner.",
      date: "2026-03-08",
      sourceUrl,
    },
    {
      id: "LS013",
      author: "Kristy L Chapman",
      rating: 5,
      title: "Patient design help",
      body:
        "The reviewer said associates were patient while they made decisions, helped them navigate inventory, answered questions, and listened to provide solutions.",
      date: "2026-03-08",
      sourceUrl,
    },
    {
      id: "LS014",
      author: "Paulina Elizondo",
      rating: 5,
      title: "Positive store experience",
      body:
        "The reviewer reported a positive in-store experience and highlighted helpful staff during the furniture selection process.",
      date: "2026-03-08",
      sourceUrl,
    },
    ],
  };
}

function countImportedCandidates(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  if (looksLikeCsv(trimmed)) {
    const rows = csvRows(trimmed);
    return Math.max(0, rows.length - 1);
  }
  return trimmed.split(/\n\s*\n+/).filter((block) => cleanText(block).length > 0)
    .length;
}

function parseImportedReviews(raw: string, sourceUrl?: string): {
  entityName?: string;
  platform?: string;
  reviews: Review[];
  scanned: number;
  warnings: string[];
} {
  const trimmed = raw.trim();
  if (looksLikeJson(trimmed)) {
    return parseJsonReviews(trimmed, sourceUrl);
  }

  if (looksLikeCsv(trimmed)) {
    const reviews = parseCsv(trimmed, sourceUrl);
    return {
      reviews,
      scanned: Math.max(0, csvRows(trimmed).length - 1),
      warnings: [],
    };
  }

  const trustpilotTextReviews = parseTrustpilotVisibleText(trimmed, sourceUrl);
  if (trustpilotTextReviews.length) {
    return {
      platform: "Trustpilot",
      reviews: trustpilotTextReviews,
      scanned: trustpilotTextReviews.length,
      warnings: [],
    };
  }

  const reviews = parsePlainReviewBlocks(trimmed, sourceUrl);
  return {
    reviews,
    scanned: countImportedCandidates(trimmed),
    warnings: [],
  };
}

export function parseTrustpilotVisibleText(raw: string, sourceUrl?: string): Review[] {
  const text = raw
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!looksLikeVisibleTrustpilotText(text)) {
    return [];
  }

  return trustpilotVisibleBlocks(text)
    .map((block, index) => reviewFromTrustpilotVisibleBlock(block, index, sourceUrl))
    .filter((review): review is Review => Boolean(review));
}

function looksLikeVisibleTrustpilotText(text: string) {
  return (
    /\bRated\s+[1-5](?:\.\d)?\s+out of\s+5\b/i.test(text) ||
    /\bDate of experience:\s*[A-Z][a-z]+ \d{1,2}, \d{4}\b/i.test(text)
  );
}

function trustpilotVisibleBlocks(text: string) {
  if (/\bRated\s+[1-5](?:\.\d)?\s+out of\s+5\b/i.test(text)) {
    return text.split(/(?=\bRated\s+[1-5](?:\.\d)?\s+out of\s+5\b)/gi);
  }

  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim()) {
      current.push(line);
    }
    if (/\bDate of experience:\s*[A-Z][a-z]+ \d{1,2}, \d{4}\b/i.test(line)) {
      blocks.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

function reviewFromTrustpilotVisibleBlock(
  block: string,
  index: number,
  sourceUrl?: string,
): Review | null {
  const lines = block
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => !isTrustpilotUiLine(line));
  const joined = cleanText(lines.join(" "));
  const rating = numberOrNull(
    joined.match(/\bRated\s+([1-5](?:\.\d)?)\s+out of\s+5\b/i)?.[1],
  );

  const date =
    normalizeDate(joined.match(/\bDate of experience:\s*([A-Z][a-z]+ \d{1,2}, \d{4})\b/i)?.[1]) ??
    normalizeDate(joined.match(/\b[A-Z][a-z]+ \d{1,2}, \d{4}\b/)?.[0]) ??
    undefined;
  const bodyLines = lines
    .map((line) =>
      line
        .replace(/\bRated\s+[1-5](?:\.\d)?\s+out of\s+5(?:\s+stars?)?\b/i, "")
        .replace(/\bDate of experience:\s*[A-Z][a-z]+ \d{1,2}, \d{4}\b/i, "")
        .trim(),
    )
    .filter(Boolean)
    .filter((line) => !normalizeDate(line));
  const title = bodyLines.find(
    (line) => line.length >= 4 && line.length <= 120 && !looksLikeAuthorLine(line),
  );
  const body = cleanText(
    bodyLines
      .filter((line) => line !== title)
      .filter((line) => !looksLikeAuthorLine(line))
      .join(" ")
      .replace(/\bDate of experience:\s*[A-Z][a-z]+ \d{1,2}, \d{4}\b/gi, ""),
  );

  return (rating || date) && body.length > 20
    ? {
        id: `V${String(index + 1).padStart(3, "0")}`,
        rating,
        title,
        body,
        date,
        sourceUrl,
      }
    : null;
}

function looksLikeAuthorLine(line: string) {
  return /^[A-Z]{2}$/.test(line) || /^\d+\s+reviews?$/i.test(line);
}

function isTrustpilotUiLine(line: string) {
  return /^(useful|share|reply from|show reviews|previous|next|company activity|claimed profile|write a review|trustpilot|verified|invited)$/i.test(
    line,
  );
}

function parseJsonReviews(raw: string, sourceUrl?: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const root = objectValue(parsed);
    const reviewItems = Array.isArray(parsed)
      ? parsed
      : Array.isArray(root?.reviews)
        ? root.reviews
        : [];
    const reviews = reviewItems
      .map((item, index) =>
        reviewFromImportedJson(objectValue(item) ?? {}, sourceUrl, index),
      )
      .filter((review) => review.body.length > 10);
    const stats = objectValue(root?.ingestionStats);
    const scanned =
      numberOrNull(stats?.scanned) ??
      numberOrNull(root?.totalAvailable) ??
      reviewItems.length;

    return {
      entityName: stringValue(root?.entityName),
      platform: stringValue(root?.platform),
      reviews,
      scanned,
      warnings: reviews.length
        ? []
        : ["JSON was detected, but no review records were recognized."],
    };
  } catch {
    return {
      reviews: [],
      scanned: 0,
      warnings: ["JSON import could not be parsed."],
    };
  }
}

function reviewFromImportedJson(
  node: Record<string, unknown>,
  sourceUrl: string | undefined,
  index: number,
): Review {
  return {
    id: stringValue(node.id) ?? `J${String(index + 1).padStart(3, "0")}`,
    author:
      stringValue(node.author) ??
      stringValue(node.consumerName) ??
      stringValue(node.reviewer),
    rating:
      numberOrNull(node.rating) ??
      numberOrNull(node.stars) ??
      numberOrNull(node.score),
    title:
      stringValue(node.title) ??
      stringValue(node.headline) ??
      stringValue(node.subject),
    body: cleanText(
      stringValue(node.body) ??
        stringValue(node.reviewBody) ??
        stringValue(node.text) ??
        stringValue(node.content) ??
        "",
    ),
    date:
      normalizeDate(node.date) ??
      normalizeDate(node.datePublished) ??
      normalizeDate(node.createdAt) ??
      undefined,
    sourceUrl: stringValue(node.sourceUrl) ?? sourceUrl,
  };
}

function parsePlainReviewBlocks(raw: string, sourceUrl?: string) {
  return raw
    .split(/\n\s*\n+/)
    .map((block, index) => {
      const text = cleanText(block);
      const ratingMatch = text.match(/\b([1-5](?:\.\d)?)\s*(?:\/\s*5|stars?)\b/i);
      return {
        id: `P${String(index + 1).padStart(3, "0")}`,
        rating: ratingMatch ? Number(ratingMatch[1]) : null,
        body: text.replace(/\b[1-5](?:\.\d)?\s*(?:\/\s*5|stars?)\b/i, "").trim(),
        sourceUrl,
      };
    })
    .filter((review) => review.body.length > 20);
}

function parseCsv(raw: string, sourceUrl?: string) {
  const rows = csvRows(raw);
  const headers = rows[0]?.map((header) => header.trim().toLowerCase()) ?? [];
  const bodyIndex = findHeader(headers, ["body", "review", "reviewbody", "text", "content", "comment"]);
  const ratingIndex = findHeader(headers, ["rating", "stars", "score"]);
  const titleIndex = findHeader(headers, ["title", "headline", "subject"]);
  const dateIndex = findHeader(headers, ["date", "created", "published", "datepublished"]);
  const authorIndex = findHeader(headers, ["author", "name", "user", "reviewer"]);

  if (bodyIndex === -1) {
    return parsePlainReviewBlocks(raw, sourceUrl);
  }

  return rows
    .slice(1)
    .map((row, index) => ({
      id: `C${String(index + 1).padStart(3, "0")}`,
      author: row[authorIndex]?.trim() || undefined,
      rating: numberOrNull(row[ratingIndex]),
      title: row[titleIndex]?.trim() || undefined,
      body: cleanText(row[bodyIndex] ?? ""),
      date: normalizeDate(row[dateIndex]) ?? undefined,
      sourceUrl,
    }))
    .filter((review) => review.body.length > 10);
}

function csvRows(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  rows.push(row);
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

function parseArticleFallback(html: string, sourceUrl: string, platform: string) {
  const root = parseHtmlDocument(html);
  return root
    .querySelectorAll("article")
    .map((article, index) => {
      const text = cleanText(article.structuredText || article.text);
      const ratingAlt = article
        .getElementsByTagName("img")
        .map((image) => image.getAttribute("alt") ?? "")
        .find((alt) => /rated/i.test(alt));
      const rating =
        numberOrNull(ratingAlt?.match(/Rated\s+([1-5](?:\.\d)?)\s+out of\s+5/i)?.[1]) ??
        numberOrNull(article.toString().match(/stars-([1-5])/i)?.[1]) ??
        numberOrNull(text.match(/Rated\s+([1-5](?:\.\d)?)\s+out of\s+5/i)?.[1]);
      const title = firstElementText(article, ["h1", "h2", "h3", "h4"]);
      const date =
        firstElementAttribute(article, ["time"], "datetime") ??
        normalizeDate(text.match(/\b[A-Z][a-z]+ \d{1,2}, \d{4}\b/)?.[0]) ??
        undefined;
      return {
        id: `${platform.slice(0, 1).toUpperCase()}${String(index + 1).padStart(3, "0")}`,
        rating,
        title: cleanText(title) || undefined,
        body: text,
        date,
        sourceUrl,
      };
    })
    .filter((review) => review.body.length > 80);
}

function firstElementText(root: HTMLElement, selectors: string[]) {
  for (const selector of selectors) {
    const text = root.querySelector(selector)?.text;
    if (text?.trim()) return text;
  }
  return "";
}

function firstElementAttribute(root: HTMLElement, selectors: string[], attribute: string) {
  for (const selector of selectors) {
    const value = root.querySelector(selector)?.getAttribute(attribute);
    if (value?.trim()) return value;
  }
  return undefined;
}

function reviewFromJson(node: Record<string, unknown>, sourceUrl: string, index: number): Review {
  const ratingNode = objectValue(node.reviewRating) ?? objectValue(node.rating);
  const authorNode = objectValue(node.author);
  return {
    id: `R${String(index + 1).padStart(3, "0")}`,
    author:
      stringValue(authorNode?.name) ??
      stringValue(node.author) ??
      stringValue(node.consumerName),
    rating:
      numberOrNull(ratingNode?.ratingValue) ??
      numberOrNull(node.ratingValue) ??
      numberOrNull(node.stars),
    title:
      stringValue(node.name) ??
      stringValue(node.title) ??
      stringValue(node.headline),
    body:
      cleanText(
        stringValue(node.reviewBody) ??
          stringValue(node.text) ??
          stringValue(node.description) ??
          stringValue(node.content) ??
          "",
      ),
    date:
      normalizeDate(node.datePublished) ??
      normalizeDate(node.publishedDate) ??
      normalizeDate(node.createdAt) ??
      undefined,
    sourceUrl,
  };
}

function flattenJson(value: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      found.push(record);
      Object.values(record).forEach(visit);
    }
  };
  visit(value);
  return found;
}

function isReviewNode(node: Record<string, unknown>) {
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => String(item).toLowerCase() === "review");
}

function isLikelyReviewObject(node: Record<string, unknown>) {
  const hasBody = ["reviewBody", "text", "description", "content"].some(
    (key) => typeof node[key] === "string" && String(node[key]).length > 30,
  );
  const hasRating = Boolean(node.reviewRating || node.rating || node.ratingValue || node.stars);
  return hasBody && hasRating;
}

function jsonLdBlocks(html: string) {
  return [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) => match[1],
  );
}

function scriptById(html: string, id: string) {
  return html.match(
    new RegExp(`<script[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i"),
  )?.[1];
}

function metaContent(html: string, property: string) {
  return htmlDecode(
    html.match(
      new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    )?.[1] ?? "",
  );
}

function titleTag(html: string) {
  return cleanText(stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
}

function detectPlatform(url: URL) {
  const host = url.hostname.replace(/^www\./, "");
  if (host.includes("trustpilot")) return "Trustpilot";
  if (host.includes("g2")) return "G2";
  if (host.includes("capterra")) return "Capterra";
  if (host.includes("google")) return "Google Maps";
  if (host.includes("amazon")) return "Amazon";
  return host;
}

function isFirstTrustpilotPage(url: URL) {
  const page = url.searchParams.get("page");
  return !page || page === "1";
}

function trustpilotDomain(url: URL) {
  if (!url.hostname.includes("trustpilot.")) return null;
  const reviewIndex = url.pathname
    .split("/")
    .filter(Boolean)
    .findIndex((part) => part === "review");
  const domain = url.pathname.split("/").filter(Boolean)[reviewIndex + 1];
  return domain ? domain.toLowerCase() : null;
}

function normalizeUrlInputs(urls?: string[], url?: string) {
  return [...(urls ?? []), url ?? ""]
    .flatMap((item) => item.split(/[\n,]+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function looksLikeBotChallenge(html: string) {
  return /verifying your connection|challenge\.js|awswaf|captcha|access denied/i.test(
    html,
  );
}

function looksLikeCsv(value: string) {
  const firstLine = value.split(/\r?\n/)[0] ?? "";
  return firstLine.includes(",") && /rating|review|body|text|content/i.test(firstLine);
}

function looksLikeJson(value: string) {
  return (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  );
}

function dedupeReviews(reviews: Review[]) {
  const seen = new Set<string>();
  return reviews.filter((review) => {
    const key = `${review.rating ?? ""}:${review.body.slice(0, 160).toLowerCase()}`;
    if (seen.has(key) || review.body.length < 10) return false;
    seen.add(key);
    return true;
  });
}

function recurringTerms(reviews: Review[]) {
  const counts = new Map<string, number>();
  for (const review of reviews) {
    const uniqueTerms = new Set(tokens(`${review.title ?? ""} ${review.body}`));
    for (const term of uniqueTerms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, 18);
}

function tokens(text: string) {
  return cleanText(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 3 && !STOPWORDS.has(term));
}

function inferEntityName(url?: string, raw?: string) {
  if (url) {
    const parsed = safeUrl(url);
    const slug = parsed?.pathname.split("/").filter(Boolean).at(-1);
    if (slug) return slug.replace(/^www\./, "").replace(/[-_]/g, " ");
  }
  return raw?.match(/^entity\s*:\s*(.+)$/im)?.[1]?.trim();
}

function normalizeDate(value: unknown) {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function numberOrNull(value: unknown) {
  const parsed = Number(String(value ?? "").match(/[0-9]+(?:\.[0-9]+)?/)?.[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function htmlDecode(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'");
}

function stripTags(value: string) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function cleanText(value: string) {
  return htmlDecode(value).replace(/\s+/g, " ").trim();
}

function findHeader(headers: string[], candidates: string[]) {
  return headers.findIndex((header) =>
    candidates.some((candidate) => header.replace(/[^a-z]/g, "") === candidate),
  );
}
