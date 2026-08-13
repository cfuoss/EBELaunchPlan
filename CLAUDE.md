# LaunchPlan CPG Hub — Claude Project Handoff

Last updated: August 6, 2026

## Purpose

This is a secure Cloudflare-based CPG operating hub for company teams. The long-term goal is to combine secure reports, custom tools, downloadable AI skills, workshops/training, integrations, company data, and AI-assisted workflows. The commercial model is intended to support LaunchPlan acting as a part-time CRO for client companies.

Long-term direction: eventually migrate/extend into Cloudflare OS (Cloudflare's open-source agent workspace, `github.com/cloudflare/cloudflare-os`), using Gatekeepers for governed data access once the hub outgrows a single Worker. Current work is deliberately built to be Gatekeeper-ready (data-access logic kept in separate helper functions from route handlers) without requiring Cloudflare OS today.

## How to work with Chris

- Chris is working in Windows PowerShell and prefers exact, step-by-step commands.
- Give one checkpoint at a time when troubleshooting.
- Inspect existing files before editing them.
- Preserve backups and unrelated work.
- Do not delete, rename, or overwrite files unless the exact target has been confirmed.
- Do not expose secrets, API keys, Cloudflare Access tokens, or company data.
- After changes, verify locally and then give the exact `npm run deploy` command.
- Chris prefers to move fast — don't over-explain tradeoffs unless asked; confirm state, then act.

## Primary project location

```text
C:\Users\cfuos\secure-cpg-demo
```

Claude Code should be started from this directory so it can see the project and this `CLAUDE.md` file.

## Live Cloudflare URLs

```text
Hub:
https://secure-cpg-demo.launchplan-ai.workers.dev/

Amazon Review Sentiment Report:
https://secure-cpg-demo.launchplan-ai.workers.dev/amazon-review-sentiment.html

Review JSON validator/uploader:
https://secure-cpg-demo.launchplan-ai.workers.dev/upload.html

Item Tracing Decomposition:
https://secure-cpg-demo.launchplan-ai.workers.dev/item-tracing-decomposition.html
```

The Worker is protected by Cloudflare Access using email one-time PIN login. Do not remove or bypass Cloudflare Access.

## Cloudflare project

Worker name:

```text
secure-cpg-demo
```

## Confirmed status as of this update

**Item Tracing Decomposition** — confirmed installed at `public/item-tracing-decomposition.html`, correctly linked from Operations Analytics in nav (4 places in `index.html`). No action needed.

**Amazon Review Sentiment Report** — confirmed installed at `public/amazon-review-sentiment.html`, hash matches expected restyled version (`F13C22E...638567`, 368,829 bytes). Brand theme present, old password gate (`ebe-gate`) correctly absent. No action needed.

**Known unresolved data issue:** the sentiment report's embedded review array contains 436 reviews, and the review browser says "Showing all 436 reviews," but the introductory subtitle says "Written reviews analyzed: 435." Not yet recalculated/fixed.

**No sensitive files leaked into `public/`** — confirmed via scan. Everything sensitive lives under `private-inputs/`, which is outside the Worker's asset directory (`wrangler.jsonc` only serves `./public`).

## Current `wrangler.jsonc` (actual, confirmed via Get-Content)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "secure-cpg-demo",
  "main": "./src/index.js",
  "compatibility_date": "2026-08-06",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "preview_urls": false,
  "assets": {
    "directory": "./public",
    "binding": "ASSETS"
  },
  "r2_buckets": [
    {
      "binding": "CPG_DATA",
      "bucket_name": "secure-cpg-data"
    }
  ],
  "vars": {
    "AI_GATEWAY_URL": "https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/ebe-marketing-ai/anthropic"
  },
  "observability": {
    "enabled": true
  },
  "upload_source_maps": true
}
```

**IMPORTANT:** `<ACCOUNT_ID>` and the gateway name `ebe-marketing-ai` may still be placeholders — verify the real values are filled in before relying on this. Read the real file first; do not overwrite from this snapshot.

## Marketing: Promotional Calendar (D1 + R2)

Added 2026-08-09. Live at `/ebe-promo-calendar.html`, linked as a third card under Dashboards → Marketing Analytics.

- New D1 database `secure-cpg-marketing` (binding `secure_cpg_marketing` in `wrangler.jsonc`, **not** `remote: true` — see caveat below). Schema in `migrations/0001_marketing_init.sql` (`promotions`, `campaigns` tables), seed data in `migrations/0002_marketing_seed.sql` (the tool's original 24 default promotions). Both already applied to the remote database; re-run with `--local` after a fresh `.wrangler/state` wipe if local dev data disappears.
- Campaign asset files (briefs/images, ≤5MB each) go to the existing `secure-cpg-data` R2 bucket under `marketing/campaigns/{campaignId}/{filename}` — no more base64-in-storage.
- New routes in `src/index.js`: `GET/PUT /api/marketing/promotions` (whole-list replace, matches the tool's original single-array save model), `GET/PUT /api/marketing/campaigns`, `DELETE /api/marketing/campaigns/:id` (also purges its R2 assets), `POST/GET/DELETE /api/marketing/campaigns/:id/assets/:filename`.
- **Caveat:** the D1 binding was briefly set to `remote: true` (Wrangler's default suggestion) — this broke `npm run dev` entirely, because a remote-mode binding makes Wrangler open a proxy through the Worker's own Cloudflare Access-gated domain, which fails with no Access Service Token in a non-interactive session. Fixed by using local-mode D1 for dev (matching how `CPG_DATA` R2 already works: local for `dev`, `--remote` only for direct one-off production commands). Don't re-add `remote: true` to `d1_databases` without also setting up an Access Service Token.

## In-progress: Claude AI integration (current priority)

Goal: connect Claude (via Cloudflare AI Gateway) to analyze review and item-trace data already stored in the hub. Direct Worker + AI Gateway integration was chosen over Cloudflare OS/Gatekeepers for now, since the hub's current needs (analyze existing data, two tools) don't yet require a full agent platform. See "Purpose" section above for the staged path to Cloudflare OS later.

### Completed steps

- [x] Created R2 bucket `secure-cpg-data`
- [x] Added `r2_buckets` binding (`CPG_DATA`) to `wrangler.jsonc`
- [x] Added `vars.AI_GATEWAY_URL` to `wrangler.jsonc` — **verify placeholders are filled in**
- [x] Uploaded `ebe_review_data_updated.json` to **local** R2 (`wrangler r2 object put ... reviews/ebe_review_data_updated.json`) — no `--remote` flag used
- [x] Created AI Gateway in Cloudflare dashboard (name should match `vars.AI_GATEWAY_URL` — verify)
- [x] Added Anthropic API key as Worker secret via `wrangler secret put ANTHROPIC_API_KEY` — **verify this was actually completed, not just discussed**
- [x] Created `.dev.vars` for local dev testing — **verify actual key was pasted in, not left as placeholder**
- [x] Confirmed `.dev.vars*` is covered by `.gitignore`

### Remaining steps

- [ ] **Verify** the R2 upload also happened with `--remote` (local upload alone won't be present after deploy):
  ```powershell
  npx wrangler r2 object put secure-cpg-data/reviews/ebe_review_data_updated.json --file .\private-inputs\ebe_review_data_updated.json --remote
  ```
- [ ] **Verify** `ANTHROPIC_API_KEY` Worker secret is actually set (not just planned):
  ```powershell
  npx wrangler secret list
  ```
- [ ] Add `/api/analyze-reviews` route and `getReviewData()` / `analyzeWithClaude()` helper functions to `src/index.js`. Data-access logic must stay separate from the HTTP route handler (Gatekeeper-ready pattern). Draft code below.
- [ ] Test locally: `npm run dev`, then hit `http://localhost:8787/api/analyze-reviews`
- [ ] Deploy: `npm run deploy`
- [ ] Test live (behind Cloudflare Access): `https://secure-cpg-demo.launchplan-ai.workers.dev/api/analyze-reviews`
- [ ] Once basic flow works with 5-review test batch, expand to full 436-review dataset with chunking (avoid one large/expensive/risky request)

### Draft route code (not yet added to src/index.js)

```javascript
// --- Data access helper (Gatekeeper-ready: no HTTP/req logic inside) ---
async function getReviewData(env, limit = null) {
  const object = await env.CPG_DATA.get("reviews/ebe_review_data_updated.json");
  if (!object) return null;

  const data = await object.json();
  const reviews = Array.isArray(data) ? data : data.reviews;

  if (limit) {
    return reviews.slice(0, limit);
  }
  return reviews;
}

// --- Claude call via AI Gateway ---
async function analyzeWithClaude(env, reviews) {
  const reviewText = reviews
    .map((r, i) => `Review ${i + 1} (${r.rating}★): ${r.text || r.reviewText || ""}`)
    .join("\n\n");

  const response = await fetch(env.AI_GATEWAY_URL + "/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: `You analyze CPG customer reviews. Summarize the key themes, sentiment, and any recurring complaints or praise in these reviews:\n\n${reviewText}`
        }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${errText}`);
  }

  const result = await response.json();
  return result.content?.[0]?.text || "No response text returned.";
}

// --- Route: test with a small batch first ---
if (url.pathname === "/api/analyze-reviews" && request.method === "GET") {
  try {
    const reviews = await getReviewData(env, 5); // small test batch first

    if (!reviews || reviews.length === 0) {
      return new Response(JSON.stringify({ error: "No review data found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const analysis = await analyzeWithClaude(env, reviews);

    return new Response(JSON.stringify({
      reviewsAnalyzed: reviews.length,
      analysis
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
```

Place before the catch-all `env.ASSETS.fetch(request)` line, alongside existing `/api/validate-reviews` route.

**IMPORTANT:** verify the actual field names in `ebe_review_data_updated.json` match `r.rating` / `r.text` / `r.reviewText` used above — inspect the real file before assuming this shape is correct.

## Known root files and folders

```text
C:\Users\cfuos\secure-cpg-demo\
├── .vscode\
├── .wrangler\
├── node_modules\
├── private-inputs\                 # non-public data/skills
├── public\                         # everything here is a web asset
├── src\
│   └── index.js
├── .dev.vars                       # local-only, gitignored — Anthropic key for local dev
├── .gitignore
├── AGENTS.md
├── package-lock.json
├── package.json
└── wrangler.jsonc
```

## Worker behavior

`src\index.js` responsibilities:

1. Handle `POST /api/validate-reviews` (existing — accepts multipart/JSON uploads, 5MB max, validates ratings/text, does not persist files, does not call AI).
2. Handle `GET /api/analyze-reviews` (new, in progress — see above).
3. Pass all other requests to `env.ASSETS.fetch(request)`.

## Public site structure

```text
C:\Users\cfuos\secure-cpg-demo\public\
├── index.html
├── amazon-review-sentiment.html
├── upload.html
├── item-tracing-decomposition.html
└── vendor\
    ├── xlsx.full.min.js
    └── xlsx.LICENSE
```

Do not serve sensitive JSON, CSV, `.skill` files, source exports, or company data from `public`.

## Review data and skill source files

Located in `private-inputs/`:

```text
amazon-review-sentiment-report.skill
ebe_review_data_updated.json          # preferred, 435 reviews (423 original + 12 added)
reviews_data.json                     # older, 423 reviews, redundant — superseded by above
amazon-review-sentiment-report\
.claude\
```

The `.skill` archive's `build_report.py` was previously found truncated mid-line around line 633 — inspect/repair before assuming runnable.

## Security architecture decisions (roadmap, not yet built)

- Cloudflare Access authentication alone is not sufficient for fine-grained authorization inside a multi-department application.
- For strict isolation, use separate Workers and separate data resources (D1/R2) per department (Marketing, Sales, Operations, Finance) when the hub grows beyond current scope.
- Validate the Cloudflare Access JWT inside sensitive Workers when built.
- Keep R2 buckets private always.

## AI Gateway / Claude connection notes

- Workers AI (Cloudflare-hosted models) does NOT include Claude — Claude requires routing through AI Gateway to Anthropic, using a stored Provider Key (BYOK) or a Worker secret.
- Never place an Anthropic API key in: `index.html`, `upload.html`, browser JavaScript, `wrangler.jsonc`, D1, or any R2-stored file. Only in Worker secrets (`wrangler secret put`) or AI Gateway's encrypted Provider Key store.
- Recommended naming pattern for future department-scoped gateways: `ebe-marketing-ai`, `ebe-sales-ai`, `ebe-operations-ai`, `ebe-finance-ai` — one gateway per department for separate usage reporting, rate limits, and audit boundaries.
- Disable AI Gateway logging/caching for confidential data.

## Recommended next inspection when starting a new Claude Code session

```powershell
cd C:\Users\cfuos\secure-cpg-demo
pwd
Get-ChildItem .\src
Get-Content .\wrangler.jsonc
Get-Content .\src\index.js
npx wrangler secret list
Get-ChildItem .\private-inputs
```

Then confirm against the "Remaining steps" checklist above before making changes.

## Immediate priority

Finish the Claude AI integration (see "In-progress" section): verify secrets/R2 remote upload are actually complete, add the `/api/analyze-reviews` route code to `src/index.js`, test locally, deploy, and confirm the live endpoint works with a small test batch before scaling to the full review set.
