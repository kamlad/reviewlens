import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function request(path, init) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the ReviewLens portal", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>ReviewLens AI<\/title>/i);
  assert.match(html, /Review Intelligence Portal/);
  assert.match(html, /Review URLs/);
  assert.match(html, /Reviews/);
  assert.match(html, /Ask/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("starter preview artifacts are removed", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /ReviewLens AI/);
  assert.match(page, /selectedRating/);
  assert.match(page, /selectedTerm/);
  assert.match(page, /No reviews match the selected filters/);
  assert.match(page, /Some URL pages failed to ingest/);
  assert.match(page, /URL ingestion warning/);
  assert.match(page, /anti-scraping protections/);
  assert.match(layout, /title:\s*"ReviewLens AI"/);
  assert.match(layout, /headers\(\)/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("public/_sites-preview", templateRoot)));
});

test("ingests JSON review exports", async () => {
  const response = await request("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rawReviews: JSON.stringify({
        platform: "Trustpilot",
        entityName: "Fixture Brand",
        ingestionStats: { scanned: 2, succeeded: 2, failed: 0 },
        reviews: [
          {
            rating: 5,
            title: "Great setup",
            body: "The delivery team was careful, fast, and helpful during setup.",
            date: "2026-01-02",
          },
          {
            rating: 2,
            title: "Late delivery",
            body: "Delivery was delayed and support gave unclear status updates.",
            date: "2026-01-03",
          },
        ],
      }),
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.entityName, "Fixture Brand");
  assert.equal(payload.reviewCount, 2);
  assert.deepEqual(payload.ingestionStats, {
    scanned: 2,
    succeeded: 2,
    failed: 0,
  });
});

test("ingests Trustpilot visible text exports", async () => {
  const response = await request("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rawReviews: [
        "Rated 1 out of 5 stars",
        "Delivery kept slipping",
        "The delivery appointment was missed twice and support gave unclear updates.",
        "Date of experience: July 28, 2026",
        "",
        "Rated 5 out of 5 stars",
        "Helpful showroom team",
        "The associate answered questions clearly and helped compare fabric options.",
        "Date of experience: July 29, 2026",
      ].join("\n"),
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.platform, "Trustpilot / imported data");
  assert.equal(payload.reviewCount, 2);
  assert.deepEqual(payload.ingestionStats, {
    scanned: 2,
    succeeded: 2,
    failed: 0,
  });
});

test("ingests visible text when Trustpilot stars are not recognized", async () => {
  const response = await request("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rawReviews: [
        "US",
        "3 reviews",
        "Delivery still has not arrived",
        "The reviewer said the delivery appointment was missed twice and support gave unclear updates about where the order was.",
        "Date of experience: July 28, 2026",
        "",
        "Helpful showroom team",
        "The associate answered questions clearly and helped compare fabric options before purchase.",
        "Date of experience: July 29, 2026",
      ].join("\n"),
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.reviewCount, 2);
  assert.equal(payload.ratingDistribution["1"], 0);
  assert.deepEqual(payload.ingestionStats, {
    scanned: 2,
    succeeded: 2,
    failed: 0,
  });
});

test("ingest endpoint accepts multiple URL fields", async () => {
  const response = await request("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      urls: ["not-a-url", "also-not-a-url"],
    }),
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(payload.error, /valid public URL/i);
});

test("ask endpoint requires OpenAI configuration", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const response = await request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "What are the top pain points?",
        dataset: {
          platform: "Imported data",
          entityName: "GE dishwasher",
          reviewCount: 1,
          ingestionStats: { scanned: 1, succeeded: 1, failed: 0 },
          averageRating: 1,
          ratingDistribution: { "1": 1, "2": 0, "3": 0, "4": 0, "5": 0 },
          dateRange: { earliest: null, latest: null },
          recurringTerms: [],
          warnings: [],
          reviews: [
            {
              rating: 1,
              body: "The heating element leaves dishes wet after the cycle ends.",
            },
          ],
        },
      }),
    });

    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.match(payload.error, /OPENAI_API_KEY/i);
  } finally {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  }
});

test("product improvement questions are answered by OpenAI with retrieved evidence", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  let capturedRequestBody;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/responses");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      capturedRequestBody = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          output_text:
            "Recommended fixes: Fix drying and heating reliability first by auditing heating-element failures and validating heated-dry performance before shipment (G002, G003).",
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}`;

  try {
    const response = await request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "What should we fix in our product to avoid bad reviews in future?",
        dataset: {
          platform: "Imported data",
          entityName: "GE dishwasher",
          reviewCount: 4,
          ingestionStats: { scanned: 4, succeeded: 4, failed: 0 },
          averageRating: 3,
          ratingDistribution: { "1": 1, "2": 1, "3": 0, "4": 0, "5": 2 },
          dateRange: { earliest: "2026-01-01", latest: "2026-01-04" },
          recurringTerms: [],
          warnings: [],
          reviews: [
            {
              id: "G001",
              rating: 5,
              title: "Quiet and dependable",
              body:
                "This GE dishwasher is quiet, attractive, and cleans plates and cups well.",
            },
            {
              id: "G002",
              rating: 1,
              title: "Heating element leaves dishes wet",
              body:
                "The bad heating element leaves dishes wet after the cycle ends, even on heated dry.",
            },
            {
              id: "G003",
              rating: 2,
              title: "Poor drying",
              body:
                "The dishwasher washes food off, but the heating element does not dry bowls, glasses, or silverware.",
            },
            {
              id: "G004",
              rating: 5,
              title: "Excellent cleaning",
              body:
                "The normal cycle cleans dinner plates, coffee mugs, and utensils very well.",
            },
          ],
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(capturedRequestBody.input[0].content, /Scope Guard Enforcement/);
    assert.match(capturedRequestBody.input[0].content, /Recommended fixes/);
    assert.match(capturedRequestBody.input[1].content, /G002/);
    assert.match(capturedRequestBody.input[1].content, /G003/);
    assert.doesNotMatch(capturedRequestBody.input[1].content, /G001/);
    assert.match(payload.answer, /Recommended fixes/i);
    assert.match(payload.answer, /heating|wet|dry/i);
    assert.deepEqual(payload.citations.slice(0, 2), ["G002", "G003"]);
  } finally {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalBaseUrl;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ask endpoint reports OpenAI 429 without local fallback", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/responses");
    request.resume();
    response.writeHead(429, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}`;

  try {
    const response = await request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "What are the top pain points?",
        dataset: {
          platform: "Imported data",
          entityName: "GE dishwasher",
          reviewCount: 1,
          ingestionStats: { scanned: 1, succeeded: 1, failed: 0 },
          averageRating: 1,
          ratingDistribution: { "1": 1, "2": 0, "3": 0, "4": 0, "5": 0 },
          dateRange: { earliest: null, latest: null },
          recurringTerms: [],
          warnings: [],
          reviews: [
            {
              id: "G001",
              rating: 1,
              body: "The heating element leaves dishes wet after the cycle ends.",
            },
          ],
        },
      }),
    });

    assert.equal(response.status, 429);
    const payload = await response.json();
    assert.match(payload.error, /rate limit|quota/i);
    assert.match(payload.error, /billing/i);
    assert.doesNotMatch(payload.error, /Based only on/i);
  } finally {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalBaseUrl;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
