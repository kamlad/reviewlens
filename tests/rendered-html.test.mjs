import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
  assert.match(html, /Evidence Preview/);
  assert.match(html, /Evidence-bound Q&amp;A/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("starter preview artifacts are removed", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /ReviewLens AI/);
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
