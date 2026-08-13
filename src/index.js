import * as XLSX from "xlsx";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function validateReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return false;
  }

  const rating = Number(review.rating);
  const hasValidRating = Number.isFinite(rating) && rating >= 1 && rating <= 5;
  const hasReviewText =
    (typeof review.title === "string" && review.title.trim().length > 0) ||
    (typeof review.content === "string" && review.content.trim().length > 0);

  return hasValidRating && hasReviewText;
}

function summarizeReviews(reviews) {
  const validReviews = reviews.filter(validateReview);
  const uniqueIds = new Set(
    validReviews
      .map((review) => review.id)
      .filter((id) => typeof id === "string" && id.trim().length > 0),
  );

  const ratings = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const sentiments = { positive: 0, neutral: 0, negative: 0, other: 0 };
  const productGroups = new Set();
  const flavors = new Set();

  for (const review of validReviews) {
    ratings[Math.round(Number(review.rating))] += 1;

    const sentiment = String(review.sentiment || "").toLowerCase();
    if (sentiment in sentiments && sentiment !== "other") {
      sentiments[sentiment] += 1;
    } else {
      sentiments.other += 1;
    }

    if (typeof review.product_group === "string" && review.product_group.trim()) {
      productGroups.add(review.product_group.trim());
    }

    if (typeof review.flavor === "string" && review.flavor.trim()) {
      flavors.add(review.flavor.trim());
    }
  }

  return {
    totalReviews: reviews.length,
    validReviews: validReviews.length,
    invalidReviews: reviews.length - validReviews.length,
    uniqueReviewIds: uniqueIds.size,
    ratings,
    sentiments,
    productGroups: [...productGroups].sort(),
    flavors: [...flavors].sort(),
  };
}

async function validateUpload(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");

  if (origin && origin !== requestUrl.origin) {
    return jsonResponse({ ok: false, error: "Cross-site uploads are not allowed." }, 403);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_FILE_BYTES + 100_000) {
    return jsonResponse({ ok: false, error: "The upload is larger than 5 MB." }, 413);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ ok: false, error: "Expected a file upload." }, 415);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ ok: false, error: "The upload could not be read." }, 400);
  }

  const file = formData.get("reviews");
  if (!(file instanceof File)) {
    return jsonResponse({ ok: false, error: "Choose a JSON review file." }, 400);
  }

  if (file.size === 0) {
    return jsonResponse({ ok: false, error: "The selected file is empty." }, 400);
  }

  if (file.size > MAX_FILE_BYTES) {
    return jsonResponse({ ok: false, error: "The selected file is larger than 5 MB." }, 413);
  }

  if (!file.name.toLowerCase().endsWith(".json")) {
    return jsonResponse({ ok: false, error: "For this checkpoint, upload a .json file." }, 415);
  }

  let uploadedData;
  try {
    uploadedData = JSON.parse(await file.text());
  } catch {
    return jsonResponse({ ok: false, error: "The selected file is not valid JSON." }, 400);
  }

  let reviews;
  let format;

  if (Array.isArray(uploadedData)) {
    reviews = uploadedData;
    format = "Review array";
  } else if (uploadedData && Array.isArray(uploadedData.reviews)) {
    reviews = uploadedData.reviews;
    format = "Processed report data";
  } else {
    return jsonResponse(
      {
        ok: false,
        error: "The JSON must be a review array or an object containing a reviews array.",
      },
      422,
    );
  }

  if (reviews.length === 0) {
    return jsonResponse({ ok: false, error: "No reviews were found in the file." }, 422);
  }

  return jsonResponse({
    ok: true,
    message: "The file is valid. Nothing was stored.",
    file: {
      name: file.name,
      sizeBytes: file.size,
      format,
    },
    summary: summarizeReviews(reviews),
  });
}

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

// --- SOP data access helpers (Gatekeeper-ready: no HTTP/req logic inside) ---
const SOP_ID_PATTERN = /^[a-z0-9-]+$/;

async function getSopIndex(env) {
  const object = await env.CPG_DATA.get("sops/index.json");
  if (!object) return { sops: [] };

  const data = await object.json();
  return Array.isArray(data?.sops) ? data : { sops: [] };
}

function searchSops(index, query) {
  const term = (query || "").trim().toLowerCase();
  if (!term) return [];

  return index.sops.filter((sop) => {
    const haystack = [sop.title, sop.description, ...(sop.tags || [])].join(" ").toLowerCase();
    return haystack.includes(term);
  });
}

async function getSopFile(env, id) {
  if (!SOP_ID_PATTERN.test(id)) return null;
  return env.CPG_DATA.get(`sops/${id}.pdf`);
}

// --- Weekly data (Issues/Opportunities + 2026 Plan xlsx) data access helpers
// (Gatekeeper-ready: parsing kept separate from HTTP/req logic). Raw source
// files are the only thing Chris re-uploads; everything else — which tab is
// "latest," which week is "current" — is recomputed from them on every request.
// `version` is bumped whenever a parseFn's output shape changes, so a code
// deploy invalidates old cached parses even though the source file's R2 etag
// (the other half of the cache key) hasn't changed.
const WEEKLY_DATA_SOURCES = {
  issues: {
    rawKey: "weekly-data/issues-opportunities-latest.xlsx",
    parsedKey: "weekly-data/issues-opportunities-latest.parsed.json",
    version: 2,
  },
  plan: {
    rawKey: "weekly-data/2026-plan-latest.xlsx",
    parsedKey: "weekly-data/2026-plan-latest.parsed.json",
    version: 1,
  },
};

const ISSUE_DEPARTMENTS = ["Marketing", "Procurement", "Sales"];

// Boundaries are detected by an exact (trimmed) column-A match against the
// three department names rather than bold-cell styling: SheetJS's free/CE
// build only surfaces fill styling on read (cellStyles), not font weight, so
// "bold" isn't reliably available here. Checked against several prior tabs in
// the real workbook — "Marketing"/"Procurement"/"Sales" only ever appear in
// column A as section headers, so exact match is unambiguous in practice.
const ISSUE_LABEL_RE = /^(issue|opportunity)\b/i;
// Loose M/D or M/D/YY(YY) extraction from a label/text string, used to guess
// when a since-hidden (completed) issue was actually closed out.
const DATE_IN_TEXT_RE = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/;

function extractDateGuess(text, referenceYear) {
  if (!text) return null;
  const m = text.match(DATE_IN_TEXT_RE);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = m[3] ? Number(m[3]) : referenceYear;
  if (year < 100) year += 2000;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null; // rolled over -> invalid date (e.g. Feb 30)
  return d.toISOString().slice(0, 10);
}

// Parses every issue/opportunity block in the last tab (expensive xlsx work —
// this is what gets cached). For each block: the title (column B of the
// "Issue:"/"Opportunity" header row), the latest update (the last row in the
// block with content, strictly after the header), whether every content row
// in the block is hidden (Excel row-hide = "this is done"), and — for hidden
// ones — a best-effort guess at the date it was closed out, parsed from
// whatever date appears in its latest update's label/text. Which of these are
// "currently open" vs. "resolved this week" depends on the live calendar
// date, so that split happens at request time (selectIssuesView below), not
// here.
function parseIssuesOpportunities(workbookBuffer, referenceYear) {
  const wb = XLSX.read(workbookBuffer, { type: "array", cellStyles: true, sheetStubs: true });
  const sheetNames = wb.SheetNames.filter((name) => {
    const ws = wb.Sheets[name];
    return ws && ws["!ref"];
  });

  if (sheetNames.length === 0) {
    return { sourceTab: null, allIssues: [] };
  }

  // Tabs are appended chronologically — always use whichever is last.
  const sourceTab = sheetNames[sheetNames.length - 1];
  const ws = wb.Sheets[sourceTab];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const rowsMeta = ws["!rows"] || [];
  const isHiddenRow = (r) => !!(rowsMeta[r] && rowsMeta[r].hidden);
  const cellVal = (r, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    return cell && cell.v != null ? String(cell.v).trim() : "";
  };

  const deptMarkers = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const val = cellVal(r, 0);
    if (ISSUE_DEPARTMENTS.includes(val)) deptMarkers.push({ row: r, dept: val });
  }
  const deptForRow = (row) => {
    for (let i = 0; i < deptMarkers.length; i++) {
      const start = deptMarkers[i].row;
      const end = i + 1 < deptMarkers.length ? deptMarkers[i + 1].row - 1 : range.e.r;
      if (row >= start && row <= end) return deptMarkers[i].dept;
    }
    return null;
  };

  const issueMarkers = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    if (ISSUE_LABEL_RE.test(cellVal(r, 0))) issueMarkers.push({ row: r });
  }

  const allIssues = [];
  for (let i = 0; i < issueMarkers.length; i++) {
    const startRow = issueMarkers[i].row;
    const endRow = i + 1 < issueMarkers.length ? issueMarkers[i + 1].row - 1 : range.e.r;
    const dept = deptForRow(startRow);
    if (!dept) continue;

    const title = cellVal(startRow, 1);
    if (!title) continue;

    // Content rows = rows with real text in column B — this deliberately
    // excludes bare category/topic-label rows (e.g. "GoPak", "Amazon") that
    // sit between one issue's last update and the next issue's header, which
    // would otherwise get mistaken for that issue's "latest update".
    const contentRows = [];
    for (let r = startRow; r <= endRow; r++) {
      if (cellVal(r, 1)) contentRows.push(r);
    }
    if (contentRows.length === 0) continue;

    const isHidden = contentRows.every((r) => isHiddenRow(r));

    const updateRows = contentRows.filter((r) => r > startRow);
    const lastUpdateRow = updateRows.length ? updateRows[updateRows.length - 1] : null;
    const latestUpdate = lastUpdateRow != null
      ? { label: cellVal(lastUpdateRow, 0), text: cellVal(lastUpdateRow, 1) }
      : null;

    const closeSourceText = latestUpdate
      ? `${latestUpdate.label} ${latestUpdate.text}`
      : `${cellVal(startRow, 0)} ${title}`;
    const closedDateGuess = isHidden ? extractDateGuess(closeSourceText, referenceYear) : null;

    allIssues.push({ dept, title, latestUpdate, isHidden, closedDateGuess });
  }

  return { sourceTab, allIssues };
}

// Cheap, always-live: splits the cached issue list into "currently open" per
// department and "resolved this week" (hidden, with a closedDateGuess that
// falls in referenceDate's Mon–Sun week) based on the live calendar date —
// this is the part that must never go stale between uploads.
function selectIssuesView(allIssues, referenceDate) {
  const mondayMs = mondayOfWeekUTC(referenceDate);
  const sundayMs = mondayMs + 6 * 24 * 60 * 60 * 1000;

  const departments = { Marketing: [], Procurement: [], Sales: [] };
  const resolvedThisWeek = [];

  for (const issue of allIssues) {
    if (!issue.isHidden) {
      departments[issue.dept]?.push({ title: issue.title, latestUpdate: issue.latestUpdate });
      continue;
    }
    if (issue.closedDateGuess) {
      const closedMs = new Date(`${issue.closedDateGuess}T00:00:00Z`).getTime();
      if (closedMs >= mondayMs && closedMs <= sundayMs) {
        resolvedThisWeek.push({ dept: issue.dept, title: issue.title, closedDate: issue.closedDateGuess });
      }
    }
  }

  return { departments, resolvedThisWeek };
}

const PLAN_SHEET_NAME = "Master Plnr";
const PLAN_HEADER_ROW = 3; // row 4, 0-indexed
const PLAN_STATUS_COL = 6; // column G
const PLAN_FIRST_WEEK_COL = 7; // column H

// Parses every weekly column in the sheet (expensive xlsx work — this is what
// gets cached). Returns each week's Monday (UTC midnight ms) and the summed
// case count across Active-status rows for that week.
function parseShipmentWeeks(workbookBuffer) {
  const wb = XLSX.read(workbookBuffer, { type: "array", cellDates: true });
  const ws = wb.Sheets[PLAN_SHEET_NAME];
  if (!ws || !ws["!ref"]) return { weeks: [] };

  const range = XLSX.utils.decode_range(ws["!ref"]);

  const weekCols = [];
  for (let c = PLAN_FIRST_WEEK_COL; c <= range.e.c; c++) {
    const headerCell = ws[XLSX.utils.encode_cell({ r: PLAN_HEADER_ROW, c })];
    if (!headerCell || headerCell.t !== "d") break; // first non-date column ends the weekly run
    const d = new Date(headerCell.v);
    weekCols.push({
      col: c,
      weekStart: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    });
  }

  const totals = weekCols.map(() => 0);
  for (let r = PLAN_HEADER_ROW + 1; r <= range.e.r; r++) {
    const statusCell = ws[XLSX.utils.encode_cell({ r, c: PLAN_STATUS_COL })];
    const status = statusCell && statusCell.v != null ? String(statusCell.v).trim() : "";
    if (status !== "Active") continue;
    weekCols.forEach((wc, i) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c: wc.col })];
      const v = cell && typeof cell.v === "number" ? cell.v : 0;
      totals[i] += v;
    });
  }

  return {
    weeks: weekCols.map((wc, i) => ({ weekStart: wc.weekStart, cases: Math.round(totals[i]) })),
  };
}

function mondayOfWeekUTC(referenceDate) {
  const d = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()),
  );
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.getTime();
}

// Cheap, always-live: picks the current week's column plus the next 4 out of
// an already-parsed week list, based on referenceDate. Never cached — this is
// the part that must never go stale between uploads.
function selectShipmentWindow(allWeeks, referenceDate) {
  const mondayMs = mondayOfWeekUTC(referenceDate);
  let startIdx = allWeeks.findIndex((w) => w.weekStart >= mondayMs);
  if (startIdx === -1) startIdx = Math.max(0, allWeeks.length - 5);
  const slice = allWeeks.slice(startIdx, startIdx + 5);
  const total = slice.reduce((sum, w) => sum + w.cases, 0);
  return { weeks: slice, total };
}

// Self-contained/testable: parses the workbook and windows it in one call
// given any referenceDate, without needing to know about the R2 cache below.
function parseShipmentForecast(workbookBuffer, referenceDate) {
  const { weeks } = parseShipmentWeeks(workbookBuffer);
  return selectShipmentWindow(weeks, referenceDate);
}

// Loads a source's cached parse if it's still fresh for the raw object's
// current R2 etag, otherwise re-parses and re-caches. Cache lives in R2
// (JSON) rather than KV since there's no KV binding on this Worker yet.
async function getCachedParse(env, source, parseFn) {
  const raw = await env.CPG_DATA.get(source.rawKey);
  if (!raw) return null;

  const cachedObj = await env.CPG_DATA.get(source.parsedKey);
  if (cachedObj) {
    try {
      const cached = await cachedObj.json();
      if (cached.sourceEtag === raw.etag && cached.version === source.version) {
        return { parsed: cached.parsed, lastModified: raw.uploaded, etag: raw.etag };
      }
    } catch {
      // fall through and re-parse
    }
  }

  const buffer = await raw.arrayBuffer();
  const parsed = parseFn(buffer);
  await env.CPG_DATA.put(source.parsedKey, JSON.stringify({ sourceEtag: raw.etag, version: source.version, parsed }));
  return { parsed, lastModified: raw.uploaded, etag: raw.etag };
}

async function getIssuesOpportunities(env, referenceDate) {
  const result = await getCachedParse(env, WEEKLY_DATA_SOURCES.issues, (buffer) =>
    parseIssuesOpportunities(buffer, referenceDate.getUTCFullYear()),
  );
  if (!result) return null;
  const { departments, resolvedThisWeek } = selectIssuesView(result.parsed.allIssues, referenceDate);
  return { sourceTab: result.parsed.sourceTab, departments, resolvedThisWeek };
}

async function getShipmentWeeks(env) {
  const result = await getCachedParse(env, WEEKLY_DATA_SOURCES.plan, parseShipmentWeeks);
  if (!result) return null;
  return { weeks: result.parsed.weeks, sourceFileUpdated: result.lastModified };
}

function getReviewFreshness(reviews, referenceDate) {
  if (!reviews || reviews.length === 0) {
    return { newestDate: null, addedLast7Days: 0 };
  }
  const dates = reviews.map((r) => r.date).filter((d) => typeof d === "string").sort();
  const newestDate = dates.length ? dates[dates.length - 1] : null;

  const cutoff = new Date(referenceDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const addedLast7Days = reviews.filter((r) => typeof r.date === "string" && r.date >= cutoffStr).length;

  return { newestDate, addedLast7Days };
}

async function getLatestSop(env) {
  const index = await getSopIndex(env);
  if (!index.sops.length) return null;
  return index.sops.reduce((latest, sop) =>
    !latest || (sop.uploadedDate || "") > (latest.uploadedDate || "") ? sop : latest,
  );
}

// Fallback content for the "Today" reviews tile when nothing new came in this
// week: the most recent positive and negative reviews, for the auto-scrolling
// carousel. Only computed when it'll actually be used (see getNewsSummary).
function getReviewHighlights(reviews, count = 10) {
  if (!reviews || reviews.length === 0) return { positive: [], negative: [] };
  const byDateDesc = (a, b) => (b.date || "").localeCompare(a.date || "");
  const pick = (sentiment) =>
    reviews
      .filter((r) => String(r.sentiment || "").toLowerCase() === sentiment)
      .sort(byDateDesc)
      .slice(0, count)
      .map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        rating: r.rating,
        author: r.author,
        date: r.date,
        flavor: r.flavor,
        productGroup: r.product_group,
      }));
  return { positive: pick("positive"), negative: pick("negative") };
}

async function getNewsSummary(env, referenceDate = new Date()) {
  const [reviews, latestSop, issues, shipments] = await Promise.all([
    getReviewData(env),
    getLatestSop(env),
    getIssuesOpportunities(env, referenceDate),
    getShipmentWeeks(env),
  ]);

  const reviewFreshness = getReviewFreshness(reviews, referenceDate);
  const shipmentWindow = shipments ? selectShipmentWindow(shipments.weeks, referenceDate) : null;
  // Only worth computing when the primary "new this week" stat is empty.
  const reviewHighlights = reviewFreshness.addedLast7Days === 0 ? getReviewHighlights(reviews) : null;

  return {
    latestReviews: {
      newestDate: reviewFreshness.newestDate,
      addedLast7Days: reviewFreshness.addedLast7Days,
    },
    reviewHighlights,
    latestSop: latestSop ? { title: latestSop.title, uploadedDate: latestSop.uploadedDate } : null,
    issuesSourceTab: issues ? issues.sourceTab : null,
    resolvedThisWeek: issues ? issues.resolvedThisWeek : [],
    shipmentsSourceFileUpdated: shipments ? shipments.sourceFileUpdated : null,
    shipmentsTotal: shipmentWindow ? shipmentWindow.total : null,
  };
}

// --- Marketing: D1 data access helpers (Gatekeeper-ready: no HTTP/req logic inside) ---
const MARKETING_ASSET_PREFIX = "marketing/campaigns/";
const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function rowToPromotion(row) {
  return {
    id: row.id,
    product: row.product,
    desc: row.description,
    channel: row.channel,
    retailer: row.retailer,
    campaignId: row.campaign_id,
    start: row.start_date,
    end: row.end_date,
    ptype: row.ptype,
    discount: row.discount,
    baseline: row.baseline,
    promoRev: row.promo_rev,
    postRev: row.post_rev,
    trueCost: row.true_cost,
    notes: row.notes,
  };
}

async function getPromotions(env) {
  const { results } = await env.secure_cpg_marketing.prepare("SELECT * FROM promotions ORDER BY id").all();
  return results.map(rowToPromotion);
}

// Promotions are always edited as a full in-memory list client-side (matches the
// tool's original single-key storage model), so a save replaces the whole table
// in one batch rather than diffing individual rows.
async function replacePromotions(env, promotions) {
  const db = env.secure_cpg_marketing;
  const statements = [db.prepare("DELETE FROM promotions")];
  for (const p of promotions) {
    statements.push(
      db
        .prepare(
          `INSERT INTO promotions
             (id, product, description, channel, retailer, campaign_id, start_date, end_date, ptype, discount, baseline, promo_rev, post_rev, true_cost, notes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        )
        .bind(
          p.id,
          p.product,
          p.desc ?? null,
          p.channel,
          p.retailer ?? null,
          p.campaignId ?? null,
          p.start,
          p.end,
          p.ptype ?? null,
          p.discount ?? null,
          p.baseline ?? null,
          p.promoRev ?? null,
          p.postRev ?? null,
          p.trueCost ?? null,
          p.notes ?? null,
        ),
    );
  }
  await db.batch(statements);
}

function validPromotion(p) {
  return (
    p &&
    typeof p.id === "string" &&
    typeof p.product === "string" &&
    typeof p.channel === "string" &&
    typeof p.start === "string" &&
    typeof p.end === "string"
  );
}

function rowToCampaign(row) {
  return {
    id: row.id,
    name: row.name,
    channels: JSON.parse(row.channels || "[]"),
    start: row.start_date,
    end: row.end_date,
    status: row.status,
    owner: row.owner,
    brief: row.brief,
    assetsNeeded: JSON.parse(row.assets_needed || "[]"),
    createdAt: row.created_at,
  };
}

async function getCampaigns(env) {
  const { results } = await env.secure_cpg_marketing.prepare("SELECT * FROM campaigns ORDER BY id").all();
  return results.map(rowToCampaign);
}

async function upsertCampaign(env, camp) {
  await env.secure_cpg_marketing
    .prepare(
      `INSERT INTO campaigns (id, name, channels, start_date, end_date, status, owner, brief, assets_needed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, channels=excluded.channels, start_date=excluded.start_date,
         end_date=excluded.end_date, status=excluded.status, owner=excluded.owner,
         brief=excluded.brief, assets_needed=excluded.assets_needed, updated_at=datetime('now')`,
    )
    .bind(
      camp.id,
      camp.name,
      JSON.stringify(camp.channels || []),
      camp.start ?? null,
      camp.end ?? null,
      camp.status ?? null,
      camp.owner ?? null,
      camp.brief ?? null,
      JSON.stringify(camp.assetsNeeded || []),
    )
    .run();
}

async function deleteCampaignRow(env, id) {
  await env.secure_cpg_marketing.prepare("DELETE FROM campaigns WHERE id = ?").bind(id).run();
}

function campaignAssetKey(campaignId, filename) {
  return `${MARKETING_ASSET_PREFIX}${campaignId}/${filename}`;
}

async function putCampaignAsset(env, campaignId, filename, file) {
  await env.CPG_DATA.put(campaignAssetKey(campaignId, filename), file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
}

async function getCampaignAsset(env, campaignId, filename) {
  return env.CPG_DATA.get(campaignAssetKey(campaignId, filename));
}

async function deleteCampaignAsset(env, campaignId, filename) {
  await env.CPG_DATA.delete(campaignAssetKey(campaignId, filename));
}

async function deleteAllCampaignAssets(env, campaignId) {
  const listed = await env.CPG_DATA.list({ prefix: `${MARKETING_ASSET_PREFIX}${campaignId}/` });
  await Promise.all(listed.objects.map((o) => env.CPG_DATA.delete(o.key)));
}

// --- Structured timing logs (Workers Logs / observability) ---
function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}

// --- Claude call via AI Gateway ---
const CLAUDE_MODEL = "claude-sonnet-4-6";

async function postToClaude(env, body, extraHeaders = {}, meta = {}) {
  const start = Date.now();
  logEvent("llm_call_start", { ...meta, model: body.model });

  const response = await fetch(env.AI_GATEWAY_URL + "/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    logEvent("llm_call_error", { ...meta, durationMs: Date.now() - start, status: response.status });
    throw new Error(`Claude API error: ${response.status} — ${errText}`);
  }

  const json = await response.json();
  const content = Array.isArray(json.content) ? json.content : [];
  logEvent("llm_call_end", {
    ...meta,
    durationMs: Date.now() - start,
    stopReason: json.stop_reason,
    // mcp_tool_use blocks are Windsor tool calls Anthropic already resolved
    // server-side during this single call — we never see their individual
    // timing, only that they happened before this response came back.
    mcpToolUseCount: content.filter((b) => b.type === "mcp_tool_use").length,
    toolUseCount: content.filter((b) => b.type === "tool_use").length,
  });
  return json;
}

async function callClaude(env, prompt, maxTokens = 1000) {
  const result = await postToClaude(env, {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return result.content?.[0]?.text || "No response text returned.";
}

function reviewsToText(reviews) {
  return reviews
    .map((r, i) => `Review ${i + 1} (${r.rating}★): ${r.title || ""} — ${r.content || ""}`)
    .join("\n\n");
}

function chunkReviews(reviews, size) {
  const chunks = [];
  for (let i = 0; i < reviews.length; i += size) {
    chunks.push(reviews.slice(i, i + size));
  }
  return chunks;
}

// --- Full analysis: single-shot for small sets, map-reduce chunking for large ones ---
const REVIEW_CHUNK_SIZE = 100;

async function analyzeReviews(env, reviews) {
  if (reviews.length <= REVIEW_CHUNK_SIZE) {
    return callClaude(
      env,
      `You analyze CPG customer reviews. Summarize the key themes, sentiment, and any recurring complaints or praise in these reviews:\n\n${reviewsToText(reviews)}`,
    );
  }

  const chunks = chunkReviews(reviews, REVIEW_CHUNK_SIZE);
  const chunkSummaries = [];
  for (const chunk of chunks) {
    const summary = await callClaude(
      env,
      `You analyze CPG customer reviews. Summarize the key themes, sentiment, and any recurring complaints or praise in these reviews:\n\n${reviewsToText(chunk)}`,
      800,
    );
    chunkSummaries.push(summary);
  }

  const combined = chunkSummaries
    .map((summary, i) => `--- Batch ${i + 1} of ${chunks.length} ---\n${summary}`)
    .join("\n\n");

  return callClaude(
    env,
    `These are batch-level summaries covering different slices of the same CPG product's customer reviews. Synthesize them into one overall report covering key themes, sentiment distribution, and recurring complaints or praise across the full dataset:\n\n${combined}`,
    1200,
  );
}

// --- Chat tool: get_reviews (Gatekeeper-ready: data access separate from tool-loop logic) ---
const MAX_TOOL_REVIEWS_RETURNED = 60;

async function getReviewsForTool(env, args = {}) {
  const reviews = await getReviewData(env);
  if (!reviews) {
    return { error: "No review data found in storage." };
  }

  const flavor = typeof args.flavor === "string" ? args.flavor.trim().toLowerCase() : "";
  const productGroup =
    typeof args.product_group === "string" ? args.product_group.trim().toLowerCase() : "";

  if (!flavor && !productGroup) {
    return summarizeReviews(reviews);
  }

  const matches = reviews.filter((r) => {
    const flavorOk = !flavor || (r.flavor || "").toLowerCase().includes(flavor);
    const groupOk = !productGroup || (r.product_group || "").toLowerCase().includes(productGroup);
    return flavorOk && groupOk;
  });

  return {
    totalMatching: matches.length,
    reviewsReturned: Math.min(matches.length, MAX_TOOL_REVIEWS_RETURNED),
    reviews: matches.slice(0, MAX_TOOL_REVIEWS_RETURNED).map((r) => ({
      rating: r.rating,
      sentiment: r.sentiment,
      product_group: r.product_group,
      flavor: r.flavor,
      title: r.title,
      content: r.content,
    })),
  };
}

const CHAT_TOOLS = [
  {
    name: "get_reviews",
    description:
      "Look up customer reviews for our CPG products from stored review data. Call with no arguments to get an aggregate overview (rating distribution, sentiment breakdown, and the list of available product groups and flavors). Call with 'flavor' and/or 'product_group' to retrieve actual review text for that subset so you can quote or reason over real customer language.",
    input_schema: {
      type: "object",
      properties: {
        flavor: {
          type: "string",
          description:
            "Filter to reviews of this flavor, e.g. 'Cheese-Less' or 'Fiery Chile Lime'. Partial, case-insensitive match.",
        },
        product_group: {
          type: "string",
          description:
            "Filter to reviews of this product group, e.g. 'Thins' or 'Cookie Bites'. Partial, case-insensitive match.",
        },
      },
    },
  },
  {
    name: "get_sops",
    description:
      "Search the company's Standard Operating Procedure (SOP) library. Call with no arguments to see the full list of available SOPs (title, description, category, tags). Call with 'query' to search by keyword against title, description, and tags. Returns metadata only — not the full document text — so reference the matching SOP by title, describe what it covers based on its description, and mention that the full document can be opened from the SOPs section of the hub.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keyword(s) to search for, e.g. 'Business Central' or 'lot tracking'. Case-insensitive substring match against title, description, and tags.",
        },
      },
    },
  },
];

async function getSopsForTool(env, args = {}) {
  const index = await getSopIndex(env);
  const query = typeof args.query === "string" ? args.query : "";
  const matches = query.trim() ? searchSops(index, query) : index.sops;

  return {
    query: query || null,
    totalMatching: matches.length,
    sops: matches.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      category: s.category,
      tags: s.tags,
    })),
  };
}

async function executeTool(env, name, input) {
  const start = Date.now();
  logEvent("tool_call_start", { tool: name });

  let result;
  if (name === "get_reviews") {
    result = await getReviewsForTool(env, input);
  } else if (name === "get_sops") {
    result = await getSopsForTool(env, input);
  } else {
    result = { error: `Unknown tool: ${name}` };
  }

  logEvent("tool_call_end", { tool: name, durationMs: Date.now() - start });
  return result;
}

// --- Windsor.ai MCP connector (marketing/ad platform data, tool execution handled by Anthropic) ---
const WINDSOR_MCP_SERVER_NAME = "windsor-ai";
const WINDSOR_TOOLSET = { type: "mcp_toolset", mcp_server_name: WINDSOR_MCP_SERVER_NAME };
const MCP_BETA_HEADER = "mcp-client-2025-11-20";

// --- Agentic tool-use loop ---
const CHAT_SYSTEM_PROMPT =
  "You are an assistant for a CPG (consumer packaged goods) company. You help analyze customer review data, marketing/ad platform performance data, and internal Standard Operating Procedures (SOPs). Use the get_reviews tool to look up real review data before answering any question about customer sentiment, flavors, or products. Use the windsor-ai tools to look up real ad spend, ROAS, and campaign performance data before answering any question about marketing or advertising performance. Use the get_sops tool to find the right SOP before answering any question about internal processes or how to do something operationally (e.g. 'how do I trace a lot in Business Central'). The SOP tool only returns metadata, not full document text — reference the matching SOP by title, summarize what it covers based on its description, and tell the person they can open the full document from the SOPs section of the hub. If no SOP matches, say so rather than inventing steps. Never invent data for reviews, marketing, or SOPs — if a tool returns no results, say so. If a question is unrelated to all three, answer normally without calling a tool.";
const MAX_CHAT_TOOL_ITERATIONS = 5;

async function runChatLoop(env, userMessage, requestId) {
  const overallStart = Date.now();
  const messages = [{ role: "user", content: userMessage }];
  const toolCalls = [];

  logEvent("chat_loop_start", { requestId, messageLength: userMessage.length });

  for (let i = 0; i < MAX_CHAT_TOOL_ITERATIONS; i++) {
    const result = await postToClaude(
      env,
      {
        model: CLAUDE_MODEL,
        max_tokens: 1500,
        system: CHAT_SYSTEM_PROMPT,
        tools: [...CHAT_TOOLS, WINDSOR_TOOLSET],
        mcp_servers: [
          {
            type: "url",
            url: "https://mcp.windsor.ai/",
            name: WINDSOR_MCP_SERVER_NAME,
            authorization_token: env.WINDSOR_API_KEY,
          },
        ],
        messages,
      },
      { "anthropic-beta": MCP_BETA_HEADER },
      { requestId, iteration: i + 1 },
    );

    messages.push({ role: "assistant", content: result.content });

    // MCP-toolset tools (e.g. windsor-ai) are executed by Anthropic server-side and
    // arrive already resolved as mcp_tool_use/mcp_tool_result blocks in this same
    // response — log them, but there's nothing for us to execute or answer back.
    for (const block of result.content) {
      if (block.type === "mcp_tool_use") {
        toolCalls.push({ tool: block.name, server: block.server_name, input: block.input, source: "mcp" });
      }
    }

    if (result.stop_reason !== "tool_use") {
      // MCP-toolset turns can interleave narration text between server-executed
      // tool calls, so the real final answer isn't necessarily the first text
      // block — concatenate all of them in order.
      const finalText = result.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      logEvent("chat_loop_end", {
        requestId,
        iterations: i + 1,
        totalDurationMs: Date.now() - overallStart,
        toolCallCount: toolCalls.length,
      });
      return { finalText, toolCalls, iterations: i + 1 };
    }

    const toolUseBlocks = result.content.filter((b) => b.type === "tool_use");
    const toolResults = [];
    for (const block of toolUseBlocks) {
      const output = await executeTool(env, block.name, block.input);
      toolCalls.push({ tool: block.name, input: block.input });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(output),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  logEvent("chat_loop_exceeded_iterations", { requestId, totalDurationMs: Date.now() - overallStart });
  throw new Error("Exceeded max tool-use iterations without a final answer.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/validate-reviews") {
      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
      }

      return validateUpload(request);
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const requestId = crypto.randomUUID();
      const handlerStart = Date.now();
      try {
        const body = await request.json().catch(() => null);
        const userMessage = body?.message;

        if (!userMessage || typeof userMessage !== "string") {
          return jsonResponse({ error: "Request body must include a 'message' string." }, 400);
        }

        logEvent("chat_request_received", { requestId, messageLength: userMessage.length });

        const result = await runChatLoop(env, userMessage, requestId);

        logEvent("chat_request_complete", {
          requestId,
          totalDurationMs: Date.now() - handlerStart,
          iterations: result.iterations,
          toolCallCount: result.toolCalls.length,
        });

        return jsonResponse({
          response: result.finalText,
          toolCalls: result.toolCalls,
          iterations: result.iterations,
        });
      } catch (err) {
        logEvent("chat_request_error", {
          requestId,
          totalDurationMs: Date.now() - handlerStart,
          error: err.message,
        });
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/analyze-reviews" && request.method === "GET") {
      try {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : null;
        const reviews = await getReviewData(env, limit);

        if (!reviews || reviews.length === 0) {
          return jsonResponse({ error: "No review data found" }, 404);
        }

        const analysis = await analyzeReviews(env, reviews);

        return jsonResponse({
          reviewsAnalyzed: reviews.length,
          analysis,
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/sops" && request.method === "GET") {
      const index = await getSopIndex(env);
      return jsonResponse(index);
    }

    if (url.pathname === "/api/sops/search" && request.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const index = await getSopIndex(env);
      return jsonResponse({ query: q, results: searchSops(index, q) });
    }

    const sopFileMatch = url.pathname.match(/^\/api\/sops\/([a-z0-9-]+)\/file$/);
    if (sopFileMatch && request.method === "GET") {
      const object = await getSopFile(env, sopFileMatch[1]);

      if (!object) {
        return jsonResponse({ error: "SOP not found." }, 404);
      }

      return new Response(object.body, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${sopFileMatch[1]}.pdf"`,
          "Cache-Control": "private, max-age=300",
        },
      });
    }

    if (url.pathname === "/api/issues-opportunities" && request.method === "GET") {
      const data = await getIssuesOpportunities(env, new Date());
      if (!data) {
        return jsonResponse(
          { error: "No issues/opportunities data found. Upload weekly-data/issues-opportunities-latest.xlsx first." },
          404,
        );
      }
      return jsonResponse(data);
    }

    if (url.pathname === "/api/shipments/upcoming" && request.method === "GET") {
      const data = await getShipmentWeeks(env);
      if (!data) {
        return jsonResponse(
          { error: "No shipment plan data found. Upload weekly-data/2026-plan-latest.xlsx first." },
          404,
        );
      }
      const { weeks, total } = selectShipmentWindow(data.weeks, new Date());
      return jsonResponse({
        weeks: weeks.map((w) => ({ weekStart: new Date(w.weekStart).toISOString().slice(0, 10), cases: w.cases })),
        total,
        sourceFileUpdated: data.sourceFileUpdated,
      });
    }

    if (url.pathname === "/api/news-summary" && request.method === "GET") {
      const summary = await getNewsSummary(env);
      return jsonResponse(summary);
    }

    if (url.pathname === "/api/weekly-data/upload" && request.method === "POST") {
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > MAX_FILE_BYTES + 100_000) {
        return jsonResponse({ error: "The file is larger than 5 MB." }, 413);
      }

      const formData = await request.formData().catch(() => null);
      const file = formData?.get("file");
      const type = formData?.get("type");

      if (!WEEKLY_DATA_SOURCES[type]) {
        return jsonResponse({ error: "type must be 'issues' or 'plan'." }, 422);
      }
      if (!(file instanceof File)) {
        return jsonResponse({ error: "Choose a file to upload." }, 400);
      }
      if (file.size > MAX_FILE_BYTES) {
        return jsonResponse({ error: "The file is larger than 5 MB." }, 413);
      }

      const source = WEEKLY_DATA_SOURCES[type];
      await env.CPG_DATA.put(source.rawKey, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
      });
      await env.CPG_DATA.delete(source.parsedKey);

      return jsonResponse({ ok: true, type, name: file.name, size: file.size });
    }

    if (url.pathname === "/api/marketing/promotions" && request.method === "GET") {
      const promotions = await getPromotions(env);
      return jsonResponse({ promotions });
    }

    if (url.pathname === "/api/marketing/promotions" && request.method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body)) {
        return jsonResponse({ error: "Body must be a JSON array of promotions." }, 400);
      }
      if (!body.every(validPromotion)) {
        return jsonResponse(
          { error: "Each promotion needs id, product, channel, start, and end." },
          422,
        );
      }
      await replacePromotions(env, body);
      return jsonResponse({ ok: true, count: body.length });
    }

    if (url.pathname === "/api/marketing/campaigns" && request.method === "GET") {
      const campaigns = await getCampaigns(env);
      return jsonResponse({ campaigns });
    }

    if (url.pathname === "/api/marketing/campaigns" && request.method === "PUT") {
      const camp = await request.json().catch(() => null);
      if (!camp || !CAMPAIGN_ID_PATTERN.test(camp.id || "") || typeof camp.name !== "string" || !camp.name.trim()) {
        return jsonResponse({ error: "Campaign needs a valid id and a name." }, 422);
      }
      await upsertCampaign(env, camp);
      return jsonResponse({ ok: true });
    }

    const campaignMatch = url.pathname.match(/^\/api\/marketing\/campaigns\/([A-Za-z0-9_-]+)$/);
    if (campaignMatch && request.method === "DELETE") {
      await deleteCampaignRow(env, campaignMatch[1]);
      await deleteAllCampaignAssets(env, campaignMatch[1]);
      return jsonResponse({ ok: true });
    }

    const assetMatch = url.pathname.match(/^\/api\/marketing\/campaigns\/([A-Za-z0-9_-]+)\/assets\/([^/]+)$/);
    if (assetMatch) {
      const campaignId = assetMatch[1];
      const filename = decodeURIComponent(assetMatch[2]);

      if (request.method === "POST") {
        const contentLength = Number(request.headers.get("content-length") || 0);
        if (contentLength > MAX_FILE_BYTES + 100_000) {
          return jsonResponse({ error: "The file is larger than 5 MB." }, 413);
        }

        const formData = await request.formData().catch(() => null);
        const file = formData?.get("file");
        if (!(file instanceof File)) {
          return jsonResponse({ error: "Choose a file to upload." }, 400);
        }
        if (file.size > MAX_FILE_BYTES) {
          return jsonResponse({ error: "The file is larger than 5 MB." }, 413);
        }

        await putCampaignAsset(env, campaignId, filename, file);
        return jsonResponse({ ok: true, name: filename, type: file.type, size: file.size });
      }

      if (request.method === "GET") {
        const object = await getCampaignAsset(env, campaignId, filename);
        if (!object) return jsonResponse({ error: "Asset not found." }, 404);

        return new Response(object.body, {
          headers: {
            "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
            "Content-Disposition": `inline; filename="${filename}"`,
            "Cache-Control": "private, max-age=300",
          },
        });
      }

      if (request.method === "DELETE") {
        await deleteCampaignAsset(env, campaignId, filename);
        return jsonResponse({ ok: true });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
