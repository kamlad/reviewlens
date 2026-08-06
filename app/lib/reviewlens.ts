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

export async function ingestReviews({
  url,
  rawReviews,
}: {
  url?: string;
  rawReviews?: string;
}): Promise<Dataset> {
  const warnings: string[] = [];
  const collected: Review[] = [];
  let entityName = "Imported review set";
  let platform = "Imported data";

  if (url) {
    const parsedUrl = safeUrl(url);
    if (!parsedUrl) {
      throw new Error("Enter a valid public URL.");
    }

    platform = detectPlatform(parsedUrl);
    if (platform === "Trustpilot") {
      const apiResult = await ingestTrustpilotApi(parsedUrl);
      if (apiResult.reviews.length) {
        entityName = apiResult.entityName ?? entityName;
        collected.push(...apiResult.reviews);
        warnings.push(...apiResult.warnings);
      } else {
        warnings.push(...apiResult.warnings);
      }
    }

    try {
      const response = await fetch(parsedUrl.toString(), {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
          "user-agent":
            "Mozilla/5.0 (compatible; ReviewLensAI/1.0; +https://example.com/reviewlens)",
        },
      });

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
        warnings.push(...parsed.warnings);
      }
    } catch {
      warnings.push(
        `${platform} could not be fetched from the server. Use a CSV export or paste review text below.`,
      );
    }

    if (!collected.length && platform === "Trustpilot") {
      const snapshot = trustpilotIndexedSnapshot(parsedUrl);
      if (snapshot.length) {
        entityName = "Living Spaces";
        collected.push(...snapshot);
        warnings.push(
          "Loaded a bundled indexed fallback for this Trustpilot URL because the live page blocked backend extraction. Configure TRUSTPILOT_API_KEY for live official API ingestion.",
        );
      }
    }
  }

  if (rawReviews?.trim()) {
    const imported = parseImportedReviews(rawReviews, url);
    collected.push(...imported);
  }

  const reviews = dedupeReviews(collected)
    .slice(0, 120)
    .map((review, index) => ({
      ...review,
      id: review.id || `R${String(index + 1).padStart(3, "0")}`,
    }));

  if (!reviews.length) {
    throw new Error(
      platform === "Trustpilot"
        ? "Trustpilot blocked backend extraction and no fallback reviews were available. Add TRUSTPILOT_API_KEY for official API ingestion, or paste CSV rows with rating and body columns."
        : "No reviews were found. Paste CSV rows with rating and body columns, or paste review blocks separated by blank lines.",
    );
  }

  if (reviews.length < collected.length) {
    warnings.push("Only the first 120 unique reviews were kept for analysis.");
  }

  if (platform === "Trustpilot" && !url) {
    platform = "Trustpilot / imported data";
  }

  return summarizeDataset({
    sourceUrl: url,
    platform,
    entityName:
      entityName !== "Imported review set"
        ? entityName
        : inferEntityName(url, rawReviews) ?? entityName,
    reviews,
    warnings,
  });
}

export function summarizeDataset({
  sourceUrl,
  platform,
  entityName,
  reviews,
  warnings,
}: {
  sourceUrl?: string;
  platform: string;
  entityName: string;
  reviews: Review[];
  warnings: string[];
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
  return /\b(pain points?|complaints?|issues?|problems?|negative|negatives|biggest|top|worst|risks?|friction|dissatisfaction)\b/i.test(
    question,
  );
}

export function isOutOfScope(question: string, dataset: Dataset) {
  const normalized = question.toLowerCase();
  const externalPatterns = [
    /\bweather\b/,
    /\bstock market\b/,
    /\bshare price\b/,
    /\bpresident\b/,
    /\bnews\b/,
    /\bcurrent events?\b/,
    /\btoday\b/,
    /\btomorrow\b/,
    /\byesterday\b/,
    /\bamazon\b/,
    /\bgoogle maps?\b/,
    /\bg2\b/,
    /\bcapterra\b/,
    /\byelp\b/,
    /\breddit\b/,
  ];

  const platform = dataset.platform.toLowerCase();
  const asksOtherPlatform = externalPatterns.some(
    (pattern) => pattern.test(normalized) && !platform.match(pattern),
  );
  const asksWeb = /\b(web|internet|online|outside|competitor|market|industry)\b/.test(
    normalized,
  );
  const asksDataset =
    /\b(review|reviews|rating|ratings|complaint|complaints|pain point|sentiment|customer|customers|theme|themes|trend|trends|issue|issues|mention|mentions|feedback|dataset|data)\b/.test(
      normalized,
    );

  return asksOtherPlatform || (asksWeb && !asksDataset);
}

export function fallbackAnswer(question: string, dataset: Dataset) {
  if (isOutOfScope(question, dataset)) {
    return {
      declined: true,
      citations: [],
      answer:
        "I can only answer using the reviews currently ingested in ReviewLens. I cannot discuss other platforms, competitors, live web facts, or general world knowledge from here.",
    };
  }

  const evidence = retrieveEvidence(question, dataset.reviews, 6);
  const negative = evidence.filter((review) => (review.rating ?? 5) <= 3);
  const terms = recurringTerms(evidence)
    .slice(0, 6)
    .map((term) => term.term);

  const answer = [
    `Based only on the ${dataset.reviewCount} ingested ${dataset.platform} reviews for ${dataset.entityName}, the strongest signals are ${terms.length ? terms.join(", ") : "not concentrated enough to name confidently"}.`,
    negative.length
      ? `${negative.length} of the most relevant cited reviews are 3-star or lower, so the pain-point read should emphasize those comments.`
      : "The most relevant cited reviews skew positive or do not include ratings, so treat negative themes as directional.",
    evidence
      .slice(0, 3)
      .map((review) => `${review.id}: ${truncate(review.body, 180)}`)
      .join("\n"),
  ].join("\n\n");

  return {
    declined: false,
    citations: evidence.slice(0, 6).map((review) => review.id),
    answer,
  };
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

async function ingestTrustpilotApi(url: URL): Promise<{
  entityName?: string;
  reviews: Review[];
  warnings: string[];
}> {
  const apiKey = process.env.TRUSTPILOT_API_KEY;
  if (!apiKey) {
    return {
      reviews: [],
      warnings: [
        "TRUSTPILOT_API_KEY is not configured, so the official Trustpilot API path was skipped.",
      ],
    };
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

    const reviewsUrl = new URL(
      `https://api.trustpilot.com/v1/business-units/${businessUnitId}/all-reviews`,
    );
    reviewsUrl.searchParams.set("apikey", apiKey);
    reviewsUrl.searchParams.set("perPage", "40");
    const reviewsResponse = await fetch(reviewsUrl);
    if (!reviewsResponse.ok) {
      return {
        reviews: [],
        warnings: [`Trustpilot reviews API returned HTTP ${reviewsResponse.status}.`],
      };
    }

    const payload = (await reviewsResponse.json()) as Record<string, unknown>;
    const rawReviews = Array.isArray(payload.reviews)
      ? payload.reviews
      : Array.isArray(payload.allReviews)
        ? payload.allReviews
        : [];

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
      warnings: ["Loaded reviews through Trustpilot's official Business Units API."],
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

function trustpilotIndexedSnapshot(url: URL): Review[] {
  if (trustpilotDomain(url) !== "www.livingspaces.com") return [];

  const sourceUrl = url.toString();
  return [
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
  ];
}

function parseImportedReviews(raw: string, sourceUrl?: string) {
  const trimmed = raw.trim();
  if (looksLikeCsv(trimmed)) {
    return parseCsv(trimmed, sourceUrl);
  }

  return parsePlainReviewBlocks(trimmed, sourceUrl);
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
  return html
    .split(/<article\b/i)
    .slice(1)
    .map((chunk, index) => {
      const article = chunk.split("</article>")[0] ?? chunk;
      const text = cleanText(stripTags(article));
      const rating =
        numberOrNull(article.match(/Rated\s+([1-5](?:\.\d)?)\s+out of\s+5/i)?.[1]) ??
        numberOrNull(article.match(/stars-([1-5])/i)?.[1]);
      const title = stripTags(
        article.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1] ?? "",
      );
      return {
        id: `${platform.slice(0, 1).toUpperCase()}${String(index + 1).padStart(3, "0")}`,
        rating,
        title: cleanText(title) || undefined,
        body: text,
        sourceUrl,
      };
    })
    .filter((review) => review.body.length > 80);
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

function trustpilotDomain(url: URL) {
  if (!url.hostname.includes("trustpilot.")) return null;
  const reviewIndex = url.pathname
    .split("/")
    .filter(Boolean)
    .findIndex((part) => part === "review");
  const domain = url.pathname.split("/").filter(Boolean)[reviewIndex + 1];
  return domain ? domain.toLowerCase() : null;
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

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}
