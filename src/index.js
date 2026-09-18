import * as XLSX from "xlsx";

// Set true to relaunch the AI Assistant (/api/chat) — see the route below
// for the rest of what a relaunch needs.
const AI_ASSISTANT_ENABLED = false;

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

// --- D1-backed review data access (Gatekeeper-ready: no HTTP/req logic
// inside). `reviews` (secure_cpg_reviews D1) is the source of truth — the
// old R2 blob (reviews/ebe_review_data_updated.json) is retired, nothing
// reads or writes it anymore. Every row carries a source ('amazon' |
// 'okendo') so callers can filter to one platform or see everything. ---

function reviewRowFromDb(row) {
  return {
    id: row.id,
    source: row.source,
    author: row.author,
    title: row.title,
    content: row.content,
    rating: row.rating,
    sentiment: row.sentiment,
    product_group: row.product_group,
    flavor: row.flavor,
    date: row.date,
    helpful: row.helpful,
    verified: row.verified,
    variations: row.variations,
    pack_size: row.pack_size,
    themes: JSON.parse(row.themes || "[]"),
  };
}

async function getReviewData(env, limit = null, source = null) {
  let sql =
    "SELECT r.*, COALESCE(t.product_group, 'Unmapped') as product_group, COALESCE(t.flavor, 'Unmapped') as flavor FROM reviews r " +
    "LEFT JOIN product_taxonomy t ON t.id = r.taxonomy_id";
  const binds = [];
  if (source && source !== "all") {
    sql += " WHERE r.source = ?";
    binds.push(source);
  }
  sql += " ORDER BY r.date DESC";
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) {
    sql += " LIMIT ?";
    binds.push(Number(limit));
  }

  const { results } = await env.secure_cpg_reviews
    .prepare(sql)
    .bind(...binds)
    .all();
  return results.map(reviewRowFromDb);
}

// Builds the full report structure (meta, overall_stats, overall_themes,
// groups, group_order, flavor_summary, reviews) fresh from D1 on every call.
// There's no stored report to fetch anymore — buildFullReviewReport is cheap
// enough (a handful of array passes over a couple thousand rows) to run per
// request rather than cache, and it means the report can never drift from
// what's actually in the reviews table.
async function getReviewReportData(env, source = null) {
  const reviews = await getReviewData(env, null, source);
  if (reviews.length === 0) return null;

  // Platform (Amazon listing) numbers are independent of review source — a
  // listing's review count/star rating describes the product, not which
  // review-data source we're viewing — so they're fetched first and passed
  // in, letting buildFullReviewReport include every platform-metric flavor
  // in group_order/flavor_order even when the current source filter has no
  // written reviews for it. Without that, a flavor with only Okendo reviews
  // would silently drop out of (and out of the totals for) the Amazon view,
  // and vice versa.
  const platformSummary = await getPlatformMetricsSummary(env);
  const report = buildFullReviewReport(reviews, platformSummary);
  applyPlatformMetrics(report, platformSummary);

  return report;
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

function slugifySopId(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function addSop(env, { title, description, category, tags, file }) {
  const index = await getSopIndex(env);

  const base = slugifySopId(title) || "sop";
  let id = base;
  let n = 2;
  while (index.sops.some((s) => s.id === id)) {
    id = `${base}-${n}`;
    n += 1;
  }

  await env.CPG_DATA.put(`sops/${id}.pdf`, file.stream(), {
    httpMetadata: { contentType: "application/pdf" },
  });

  const sop = {
    id,
    title: title.trim(),
    description: (description || "").trim(),
    category: (category || "General").trim(),
    tags,
    filename: `${id}.pdf`,
    uploadedDate: new Date().toISOString().slice(0, 10),
  };

  index.sops.push(sop);
  await env.CPG_DATA.put("sops/index.json", JSON.stringify(index), {
    httpMetadata: { contentType: "application/json" },
  });

  return sop;
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
    version: 3,
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
const PLAN_SALES_UOM_COL = 4; // column E
const PLAN_POSTING_GROUP_COL = 5; // column F
const PLAN_STATUS_COL = 6; // column G
const PLAN_FIRST_WEEK_COL = 7; // column H

function addTo(map, key, amount) {
  map[key] = (map[key] || 0) + amount;
}

// Parses every weekly column in the sheet (expensive xlsx work — this is what
// gets cached). Returns each week's Monday (UTC midnight ms), the summed case
// count across Active-status rows for that week, and that same total broken
// down by Sales Unit of Measure and by Gen. Prod. Posting Group.
function parseShipmentWeeks(workbookBuffer) {
  const wb = XLSX.read(workbookBuffer, { type: "array", cellDates: true });
  const ws = wb.Sheets[PLAN_SHEET_NAME];
  if (!ws || !ws["!ref"]) return { weeks: [] };

  const range = XLSX.utils.decode_range(ws["!ref"]);
  const cellVal = (r, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    return cell && cell.v != null ? String(cell.v).trim() : "";
  };

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
  const byUnit = weekCols.map(() => ({}));
  const byPostingGroup = weekCols.map(() => ({}));
  const items = [];

  for (let r = PLAN_HEADER_ROW + 1; r <= range.e.r; r++) {
    const status = cellVal(r, PLAN_STATUS_COL);
    if (status !== "Active") continue;
    const description = cellVal(r, 2) || "Unspecified item"; // column C
    const unit = cellVal(r, PLAN_SALES_UOM_COL) || "Unspecified";
    const group = cellVal(r, PLAN_POSTING_GROUP_COL) || "Unspecified";

    const itemCases = weekCols.map((wc, i) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c: wc.col })];
      const v = cell && typeof cell.v === "number" ? cell.v : 0;
      if (!v) return 0;
      totals[i] += v;
      addTo(byUnit[i], unit, v);
      addTo(byPostingGroup[i], group, v);
      return Math.round(v);
    });

    if (itemCases.some((v) => v > 0)) {
      items.push({ description, unit, postingGroup: group, cases: itemCases });
    }
  }

  const round = (n) => Math.round(n);
  const roundMap = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)]));

  return {
    weeks: weekCols.map((wc, i) => ({
      weekStart: wc.weekStart,
      cases: round(totals[i]),
      byUnit: roundMap(byUnit[i]),
      byPostingGroup: roundMap(byPostingGroup[i]),
    })),
    items,
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

// Categories get a stable color slot by alphabetical order (never re-cycled
// per request), so the same unit/group always renders the same color across
// page loads even as the 5-week window advances week to week.
function fixedCategoryOrder(weeks, key) {
  const names = new Set();
  weeks.forEach((w) => Object.keys(w[key]).forEach((name) => names.add(name)));
  return [...names].sort();
}

// Cheap, always-live: picks the current week's column plus the next 4 out of
// an already-parsed week list, based on referenceDate. Never cached — this is
// the part that must never go stale between uploads.
function selectShipmentWindow(allWeeks, referenceDate, items = []) {
  const mondayMs = mondayOfWeekUTC(referenceDate);
  let startIdx = allWeeks.findIndex((w) => w.weekStart >= mondayMs);
  if (startIdx === -1) startIdx = Math.max(0, allWeeks.length - 5);
  const slice = allWeeks.slice(startIdx, startIdx + 5);
  const total = slice.reduce((sum, w) => sum + w.cases, 0);

  // Same startIdx/window applied to each item's per-week case array (aligned
  // index-for-index with allWeeks) — only items with any volume in this
  // specific window are worth showing in the full-detail table.
  const itemsWindow = items
    .map((item) => {
      const cases = item.cases.slice(startIdx, startIdx + 5);
      return { description: item.description, unit: item.unit, postingGroup: item.postingGroup, cases, total: cases.reduce((s, v) => s + v, 0) };
    })
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total);

  return {
    weeks: slice.map((w) => ({ weekStart: w.weekStart, cases: w.cases })),
    total,
    units: fixedCategoryOrder(slice, "byUnit"),
    byUnit: slice.map((w) => ({ weekStart: w.weekStart, values: w.byUnit })),
    postingGroups: fixedCategoryOrder(slice, "byPostingGroup"),
    byPostingGroup: slice.map((w) => ({ weekStart: w.weekStart, values: w.byPostingGroup })),
    items: itemsWindow,
  };
}

// Self-contained/testable: parses the workbook and windows it in one call
// given any referenceDate, without needing to know about the R2 cache below.
function parseShipmentForecast(workbookBuffer, referenceDate) {
  const { weeks, items } = parseShipmentWeeks(workbookBuffer);
  return selectShipmentWindow(weeks, referenceDate, items);
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
  return { sourceTab: result.parsed.sourceTab, departments, resolvedThisWeek, sourceFileUpdated: result.lastModified };
}

async function getShipmentWeeks(env) {
  const result = await getCachedParse(env, WEEKLY_DATA_SOURCES.plan, parseShipmentWeeks);
  if (!result) return null;
  return { weeks: result.parsed.weeks, items: result.parsed.items || [], sourceFileUpdated: result.lastModified };
}

function getReviewFreshness(reviews, referenceDate) {
  if (!reviews || reviews.length === 0) {
    return { newestDate: null, addedLast7Days: 0, addedLast7DaysIds: [] };
  }
  const dates = reviews.map((r) => r.date).filter((d) => typeof d === "string").sort();
  const newestDate = dates.length ? dates[dates.length - 1] : null;

  const cutoff = new Date(referenceDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const recentIds = reviews.filter((r) => typeof r.date === "string" && r.date >= cutoffStr).map((r) => r.id);

  return { newestDate, addedLast7Days: recentIds.length, addedLast7DaysIds: recentIds };
}

async function getLatestSop(env) {
  const index = await getSopIndex(env);
  if (!index.sops.length) return null;
  return index.sops.reduce((latest, sop) =>
    !latest || (sop.uploadedDate || "") > (latest.uploadedDate || "") ? sop : latest,
  );
}

// Always-on breakdown for the reviews carousel: the most recent `sampleSize`
// reviews by date, split into positive/negative (by the stored sentiment
// field) for the two scrolling rows, plus the count of each — so the
// carousel has something to show regardless of how recently reviews came in.
function getReviewHighlights(reviews, sampleSize = 20) {
  if (!reviews || reviews.length === 0) {
    return { sampleSize: 0, positiveCount: 0, negativeCount: 0, neutralCount: 0, positive: [], negative: [], neutral: [] };
  }
  const recent = reviews
    .filter((r) => typeof r.date === "string")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, sampleSize);

  const toChip = (r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    rating: r.rating,
    author: r.author,
    date: r.date,
    flavor: r.flavor,
    productGroup: r.product_group,
  });

  const positive = recent.filter((r) => String(r.sentiment || "").toLowerCase() === "positive");
  const negative = recent.filter((r) => String(r.sentiment || "").toLowerCase() === "negative");
  // Everything left over (sentiment "neutral", missing, or unrecognized) —
  // defined as the complement of positive/negative rather than a strict
  // equality check, so this count always reconciles exactly with sampleSize.
  const neutral = recent.filter((r) => {
    const s = String(r.sentiment || "").toLowerCase();
    return s !== "positive" && s !== "negative";
  });

  return {
    sampleSize: recent.length,
    positiveCount: positive.length,
    negativeCount: negative.length,
    neutralCount: neutral.length,
    positive: positive.map(toChip),
    negative: negative.map(toChip),
    neutral: neutral.map(toChip),
  };
}

// --- 30-day review sentiment analysis (AI Gateway-backed, cached by content
// signature so a page left open with periodic refresh doesn't re-run Claude
// unless the underlying 30-day review set actually changed) ---
const SENTIMENT_ANALYSIS_WINDOW_DAYS = 30;
const SENTIMENT_ANALYSIS_CACHE_KEY = "reviews/sentiment-analysis-cache.json";
const SENTIMENT_ANALYSIS_MAX_REVIEWS_PER_SIDE = 60;
// Bumped whenever the analysis JSON shape changes, so a code deploy
// invalidates old cached results even though the review set (the other half
// of the cache key) hasn't changed.
const SENTIMENT_ANALYSIS_SCHEMA_VERSION = 2;

function filterReviewsByWindow(reviews, referenceDate, days) {
  const cutoff = new Date(referenceDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return reviews.filter((r) => typeof r.date === "string" && r.date >= cutoffStr);
}

async function hashIds(ids) {
  const data = new TextEncoder().encode(ids.slice().sort().join(","));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function reviewsForPrompt(reviews) {
  return reviews
    .slice(0, SENTIMENT_ANALYSIS_MAX_REVIEWS_PER_SIDE)
    .map((r) => `- [${r.id}] (${r.date}, ${r.rating}★, ${r.flavor || "unknown flavor"}) ${r.title || ""}: ${r.content || ""}`)
    .join("\n");
}

const SENTIMENT_ANALYSIS_SYSTEM_PROMPT =
  'You are a CPG customer insights analyst reviewing recent Amazon customer reviews for a snack brand. Each review below is prefixed with its ID in brackets, e.g. "[R1234ABC]". Respond with ONLY a single JSON object — no markdown fences, no commentary before or after — in exactly this shape: {"positiveSummary": string, "negativeSummary": string, "anomalies": [{"issue": string, "severity": "low"|"medium"|"high", "reviewIds": string[], "suggestedAction": string}]}. An anomaly is a cluster of 2 or more negative reviews describing the same or closely related problem (a specific defect, an off flavor or smell, a packaging issue, a formula change, etc.) — a single isolated complaint is not an anomaly. Always flag safety-related issues (illness, allergic reaction, foreign objects, spoilage/mold) as "high" severity even if only one review mentions it — a single review is enough for a safety anomaly. reviewIds must be the exact bracketed IDs (copied verbatim, no brackets) of every review that contributes to that anomaly — never invent an ID that wasn\'t given to you. Each suggestedAction should be a concrete, specific next step someone on the team could take. If there are no negative reviews, or no reviews at all for a side, say so plainly in that summary field and return an empty anomalies array. Ground every statement only in the reviews given — never invent details, flavors, or counts.';

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Could not find JSON in Claude's response");
  }
}

async function analyzeRecentReviewSentiment(env, referenceDate = new Date()) {
  const reviews = await getReviewData(env);
  if (!reviews || reviews.length === 0) return null;

  const recent = filterReviewsByWindow(reviews, referenceDate, SENTIMENT_ANALYSIS_WINDOW_DAYS);
  const positive = recent.filter((r) => String(r.sentiment || "").toLowerCase() === "positive");
  const negative = recent.filter((r) => String(r.sentiment || "").toLowerCase() === "negative");

  const base = {
    windowDays: SENTIMENT_ANALYSIS_WINDOW_DAYS,
    positiveCount: positive.length,
    negativeCount: negative.length,
    totalCount: recent.length,
    // Full pools behind the two summary cards — computed fresh every call
    // (cheap, no LLM involved) so they're never stale relative to the cache.
    positiveReviewIds: positive.map((r) => r.id),
    negativeReviewIds: negative.map((r) => r.id),
  };

  if (recent.length === 0) {
    return {
      ...base,
      positiveSummary: "No reviews in the last 30 days.",
      negativeSummary: "No reviews in the last 30 days.",
      anomalies: [],
      generatedAt: null,
      cached: false,
    };
  }

  const signature = await hashIds(recent.map((r) => r.id));

  const cachedObj = await env.CPG_DATA.get(SENTIMENT_ANALYSIS_CACHE_KEY);
  if (cachedObj) {
    try {
      const cached = await cachedObj.json();
      if (cached.signature === signature && cached.schemaVersion === SENTIMENT_ANALYSIS_SCHEMA_VERSION) {
        return { ...base, ...cached.analysis, generatedAt: cached.generatedAt, cached: true };
      }
    } catch {
      // fall through and regenerate
    }
  }

  const prompt = `Positive reviews (past ${SENTIMENT_ANALYSIS_WINDOW_DAYS} days, ${positive.length} total):\n${reviewsForPrompt(positive) || "(none)"}\n\nNegative reviews (past ${SENTIMENT_ANALYSIS_WINDOW_DAYS} days, ${negative.length} total):\n${reviewsForPrompt(negative) || "(none)"}`;

  const result = await postToClaude(
    env,
    {
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: SENTIMENT_ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    },
    {},
    { task: "sentiment_analysis_30d" },
  );

  const text = result.content?.[0]?.text || "{}";
  const rawAnalysis = parseJsonFromText(text);
  const generatedAt = new Date().toISOString();

  // Cross-check Claude's cited review IDs against the actual negative-review
  // set rather than trusting them blindly — drops any hallucinated ID and
  // derives the displayed count from what's actually verifiable, since the
  // "N reviews" link only works for IDs we can really look up.
  const negativeIdSet = new Set(negative.map((r) => r.id));
  const anomalies = (rawAnalysis.anomalies || [])
    .map((a) => {
      const reviewIds = Array.isArray(a.reviewIds) ? a.reviewIds.filter((id) => negativeIdSet.has(id)) : [];
      return {
        issue: a.issue,
        severity: a.severity,
        suggestedAction: a.suggestedAction,
        reviewIds,
        reviewCount: reviewIds.length,
      };
    })
    .filter((a) => a.reviewCount > 0);

  const analysis = {
    positiveSummary: rawAnalysis.positiveSummary,
    negativeSummary: rawAnalysis.negativeSummary,
    anomalies,
  };

  await env.CPG_DATA.put(
    SENTIMENT_ANALYSIS_CACHE_KEY,
    JSON.stringify({ signature, schemaVersion: SENTIMENT_ANALYSIS_SCHEMA_VERSION, generatedAt, analysis }),
  );

  return { ...base, ...analysis, generatedAt, cached: false };
}

// --- Priority Actions brief for the Reviews by Category dashboard —
// per-product-group AI briefing, weighted toward the last 30 days, cached in
// R2 by (group, review-ID signature) so it only regenerates when that
// group's underlying review set actually changes ("refreshed every time new
// data is added"), and switching the dropdown after a cache hit is instant.
// Same AI Gateway + signature-cache pattern as analyzeRecentReviewSentiment
// above, different prompt/shape (a brief + owned action items). ---
const CATEGORY_ACTIONS_CACHE_KEY = "reviews/category-actions-cache.json";
const CATEGORY_ACTIONS_SCHEMA_VERSION = 1;
const CATEGORY_ACTIONS_RECENT_DAYS = 30;
const CATEGORY_ACTIONS_MAX_REVIEWS = 60;
const CATEGORY_ACTIONS_OWNERS = ["QA", "Packaging & Fulfillment", "Production", "Customer Care", "Marketing / Listings", "Leadership"];

function slugifyGroup(group) {
  return (
    String(group || "all")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "all"
  );
}

const CATEGORY_ACTIONS_SYSTEM_PROMPT =
  `You are a CPG customer insights analyst writing a short operating brief for a snack brand's leadership team, based on Amazon and Okendo customer reviews for one product line. Weight the "Recent reviews" section (last ${CATEGORY_ACTIONS_RECENT_DAYS} days) more heavily than "Older reviews" (summarized only) when deciding what matters right now — older data is context, not the basis for action. Respond with ONLY a single JSON object — no markdown fences, no commentary before or after — in exactly this shape: {"brief": string, "actionItems": [{"issue": string, "severity": "low"|"medium"|"high", "suggestedOwner": string, "suggestedAction": string, "reviewIds": string[]}]}. "brief" is 2-4 sentences summarizing current standing and the most important trend. Each action item must be grounded in a real, recurring pattern (2 or more reviews) unless it is a safety issue (illness, allergic reaction, foreign object, spoilage/mold — always flag even from a single review, as "high" severity). "suggestedOwner" must be exactly one of: ${CATEGORY_ACTIONS_OWNERS.map((o) => `"${o}"`).join(", ")} — pick whichever team would actually own fixing it. reviewIds must be exact bracketed IDs (copied verbatim, no brackets) from the reviews given — never invent one. If there is not enough data to say anything meaningful, return a brief saying so and an empty actionItems array. Ground every statement only in the reviews given, never invent details or counts.`;

function buildCategoryActionsPrompt(groupLabel, recent, olderStats) {
  const recentText = reviewsForPrompt(recent.slice(0, CATEGORY_ACTIONS_MAX_REVIEWS)) || "(none)";
  const olderLine =
    olderStats.count > 0
      ? `${olderStats.count} reviews, ${olderStats.pos_pct}% positive / ${olderStats.neg_pct}% negative, ${olderStats.avg_rating}★ avg — summarized only, not itemized.`
      : "(none)";
  return `Product line: ${groupLabel}\n\nRecent reviews (last ${CATEGORY_ACTIONS_RECENT_DAYS} days, ${recent.length} total):\n${recentText}\n\nOlder reviews (before that window):\n${olderLine}`;
}

async function analyzeCategoryPriorityActions(env, group, referenceDate = new Date()) {
  const allReviews = await getReviewData(env);
  if (!allReviews || allReviews.length === 0) return null;

  const groupLabel = group && group !== "all" ? group : "All Products";
  const scoped = group && group !== "all" ? allReviews.filter((r) => r.product_group === group) : allReviews;
  if (scoped.length === 0) {
    return { productGroup: groupLabel, brief: `No reviews found yet for ${groupLabel}.`, actionItems: [], generatedAt: null, cached: false };
  }

  const cutoff = new Date(referenceDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - CATEGORY_ACTIONS_RECENT_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const recent = scoped.filter((r) => typeof r.date === "string" && r.date >= cutoffStr);
  const older = scoped.filter((r) => !(typeof r.date === "string" && r.date >= cutoffStr));
  const olderStats = computeReviewStats(older);

  const slug = slugifyGroup(group);
  const signature = await hashIds(scoped.map((r) => r.id));

  const cachedObj = await env.CPG_DATA.get(CATEGORY_ACTIONS_CACHE_KEY);
  let cacheData = {};
  if (cachedObj) {
    try {
      cacheData = await cachedObj.json();
    } catch {
      cacheData = {};
    }
  }
  const cachedEntry = cacheData[slug];
  if (cachedEntry && cachedEntry.signature === signature && cachedEntry.schemaVersion === CATEGORY_ACTIONS_SCHEMA_VERSION) {
    return { productGroup: groupLabel, ...cachedEntry.analysis, generatedAt: cachedEntry.generatedAt, cached: true };
  }

  const prompt = buildCategoryActionsPrompt(groupLabel, recent, olderStats);
  const result = await postToClaude(
    env,
    {
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: CATEGORY_ACTIONS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    },
    {},
    { task: "category_priority_actions", group: slug },
  );

  const text = result.content?.[0]?.text || "{}";
  const raw = parseJsonFromText(text);
  const generatedAt = new Date().toISOString();

  // Same hallucination guard as analyzeRecentReviewSentiment: drop any cited
  // review ID that isn't actually in this group's review set, and any owner
  // outside the fixed list, rather than trusting Claude's output blindly.
  const idSet = new Set(scoped.map((r) => r.id));
  const ownerSet = new Set(CATEGORY_ACTIONS_OWNERS);
  const actionItems = (raw.actionItems || [])
    .map((a) => {
      const reviewIds = Array.isArray(a.reviewIds) ? a.reviewIds.filter((id) => idSet.has(id)) : [];
      return {
        issue: a.issue,
        severity: ["low", "medium", "high"].includes(a.severity) ? a.severity : "low",
        suggestedOwner: ownerSet.has(a.suggestedOwner) ? a.suggestedOwner : "Leadership",
        suggestedAction: a.suggestedAction,
        reviewIds,
        reviewCount: reviewIds.length,
      };
    })
    .filter((a) => a.reviewCount > 0);

  const analysis = { brief: raw.brief || "", actionItems };

  cacheData[slug] = { signature, schemaVersion: CATEGORY_ACTIONS_SCHEMA_VERSION, generatedAt, analysis };
  await env.CPG_DATA.put(CATEGORY_ACTIONS_CACHE_KEY, JSON.stringify(cacheData));

  return { productGroup: groupLabel, ...analysis, generatedAt, cached: false };
}

// --- Per-flavor action recommendations for the review sentiment report
// (AI Gateway-backed, cached by content signature of each flavor's themes/
// quotes so recommendations only regenerate when that underlying data
// actually changes — same pattern as the 30-day sentiment cache above) ---
const RECOMMENDATIONS_CACHE_KEY = "reviews/recommendations-cache.json";
const RECOMMENDATIONS_SCHEMA_VERSION = 1;

async function hashString(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buildRecommendationPrompt(flavorEntries) {
  return flavorEntries
    .map((f) => {
      const pos = f.themesPos.map((t) => `  + ${t.display} (${t.count}x): ${t.top_quote}`).join("\n") || "  (none)";
      const neg = f.themesNeg.map((t) => `  - ${t.display} (${t.count}x): ${t.top_quote}`).join("\n") || "  (none)";
      return `### ${f.group} :: ${f.flavor}\nStats: ${f.stats.count} written reviews, ${f.stats.pos_pct}% positive, ${f.stats.neg_pct}% negative, ${f.stats.avg_rating}★ avg\nTop positive themes:\n${pos}\nTop negative themes:\n${neg}`;
    })
    .join("\n\n");
}

const RECOMMENDATIONS_SYSTEM_PROMPT =
  'You are a CPG listing strategist writing action recommendations for an Amazon review sentiment report. For each product group/flavor below, write 3-5 recommendation bullets grounded in the specific themes and quotes given — never generic advice. Each bullet should: quote or closely paraphrase the customer language that signals the issue or strength, state the concrete listing implication (copy change, A+ content, brand response, product fix, packaging change), and be specific about which theme/star cohort the signal comes from. Prioritize the top positive theme (feature it) and any negative themes with 2 or more mentions (address them, ranked by mention count — skip negative themes with only 1 mention unless it is a safety issue). Respond with ONLY a single JSON object — no markdown fences, no commentary before or after — shaped exactly like {"Group Name::Flavor Name": ["bullet 1", "bullet 2", "bullet 3"]}, with one key per group/flavor given, using the exact "Group Name::Flavor Name" strings provided. Keep each bullet to one or two sentences.';

async function getFlavorRecommendations(env, report) {
  const entries = [];
  for (const group of report.group_order || []) {
    const groupData = report.groups?.[group];
    if (!groupData) continue;
    for (const flavor of groupData.flavor_order || []) {
      const flavorData = groupData.flavors?.[flavor];
      if (!flavorData || flavorData.metric_only || !flavorData.stats?.count) continue;
      entries.push({
        group,
        flavor,
        stats: flavorData.stats,
        themesPos: (flavorData.themes_pos || []).slice(0, 5),
        themesNeg: (flavorData.themes_neg || []).slice(0, 5),
      });
    }
  }

  if (entries.length === 0) {
    return { recommendations: {}, generatedAt: null, cached: false };
  }

  const signature = await hashString(JSON.stringify(entries));

  const cachedObj = await env.CPG_DATA.get(RECOMMENDATIONS_CACHE_KEY);
  if (cachedObj) {
    try {
      const cached = await cachedObj.json();
      if (cached.signature === signature && cached.schemaVersion === RECOMMENDATIONS_SCHEMA_VERSION) {
        return { recommendations: cached.recommendations, generatedAt: cached.generatedAt, cached: true };
      }
    } catch {
      // fall through and regenerate
    }
  }

  const prompt = buildRecommendationPrompt(entries);

  const result = await postToClaude(
    env,
    {
      model: CLAUDE_MODEL,
      max_tokens: 6000,
      system: RECOMMENDATIONS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    },
    {},
    { task: "flavor_recommendations" },
  );

  const text = result.content?.[0]?.text || "{}";
  const recommendations = parseJsonFromText(text);
  const generatedAt = new Date().toISOString();

  await env.CPG_DATA.put(
    RECOMMENDATIONS_CACHE_KEY,
    JSON.stringify({ signature, schemaVersion: RECOMMENDATIONS_SCHEMA_VERSION, generatedAt, recommendations }),
  );

  return { recommendations, generatedAt, cached: false };
}

// --- Platform (Amazon listing) review metrics — uploaded from metric-data.xlsx
// into D1 (secure_cpg_reviews), independent of the R2-stored written-review
// database. Lets Chris re-upload metric-data at any time without needing to
// re-run the full review-analysis pipeline, and keeps a persistent,
// human-correctable item-name -> product group/flavor mapping so a bad
// automatic keyword match (like the one that produced "74 reviews" for Sea
// Salt Crispbread) gets caught before it reaches the report, not baked in
// silently. ---

// --- Consolidated product taxonomy (D1: product_taxonomy + product_aliases)
// — the single canonical (product_group, flavor) list plus a generic
// raw-identifier -> taxonomy mapping, replacing three things that used to
// drift independently: a hardcoded PRODUCT_TAXONOMY const here, a matching
// TAXONOMY object in update-reviews.html, and platform_metric_map. Every
// importer (platform metrics, Amazon reviews, Okendo reviews) now resolves
// through the same product_aliases table, keyed by its own `source`. ---

async function getTaxonomyGroups(env) {
  const list = await getTaxonomyList(env);
  const groups = {};
  for (const r of list) {
    (groups[r.product_group] ||= []).push(r.flavor);
  }
  return groups;
}

async function getTaxonomyList(env) {
  const { results } = await env.secure_cpg_reviews
    .prepare("SELECT id, product_group, flavor FROM product_taxonomy ORDER BY sort_order")
    .all();
  return results;
}

// group::flavor -> taxonomy id, for resolving an already-known pair.
async function getTaxonomyIdMap(env) {
  const list = await getTaxonomyList(env);
  const map = new Map();
  for (const r of list) map.set(`${r.product_group}::${r.flavor}`, r.id);
  return map;
}

async function getOrCreateTaxonomy(env, productGroup, flavor) {
  const db = env.secure_cpg_reviews;
  const existing = await db
    .prepare("SELECT id FROM product_taxonomy WHERE product_group = ? AND flavor = ?")
    .bind(productGroup, flavor)
    .first();
  if (existing) return existing.id;

  const maxRow = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) as maxOrder FROM product_taxonomy").first();
  const inserted = await db
    .prepare(
      "INSERT INTO product_taxonomy (product_group, flavor, sort_order, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(productGroup, flavor, (maxRow?.maxOrder || 0) + 1, new Date().toISOString())
    .first();
  return inserted.id;
}

// One raw identifier (an Amazon item_name/SKU or Okendo product name) -> its
// resolved taxonomy row, if a mapping already exists for it.
async function resolveAlias(env, source, rawValue) {
  const row = await env.secure_cpg_reviews
    .prepare(
      `SELECT a.taxonomy_id, a.auto_suggested, t.product_group, t.flavor
       FROM product_aliases a JOIN product_taxonomy t ON t.id = a.taxonomy_id
       WHERE a.source = ? AND a.raw_value = ?`,
    )
    .bind(source, rawValue)
    .first();
  if (!row) return null;
  return {
    taxonomyId: row.taxonomy_id,
    product_group: row.product_group,
    flavor: row.flavor,
    autoSuggested: !!row.auto_suggested,
  };
}

// Batched version of resolveAlias for import previews scanning many rows at
// once — one query instead of one per row.
async function resolveAliasesBulk(env, source, rawValues) {
  const unique = [...new Set(rawValues.filter(Boolean))];
  const map = new Map();
  if (unique.length === 0) return map;
  // D1 caps bound parameters per statement well under vanilla SQLite's
  // default (999) — keep chunks small, leaving room for the `source` bind.
  const CHUNK = 90;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await env.secure_cpg_reviews
      .prepare(
        `SELECT a.raw_value, a.taxonomy_id, a.auto_suggested, t.product_group, t.flavor
         FROM product_aliases a JOIN product_taxonomy t ON t.id = a.taxonomy_id
         WHERE a.source = ? AND a.raw_value IN (${placeholders})`,
      )
      .bind(source, ...chunk)
      .all();
    for (const r of results) {
      map.set(r.raw_value, {
        taxonomyId: r.taxonomy_id,
        product_group: r.product_group,
        flavor: r.flavor,
        autoSuggested: !!r.auto_suggested,
      });
    }
  }
  return map;
}

async function upsertAlias(env, { taxonomyId, source, rawValue, fnsku = null, asin = null, packSize = null, bcItemNumber = null, autoSuggested = false }) {
  await env.secure_cpg_reviews
    .prepare(
      `INSERT INTO product_aliases (taxonomy_id, source, raw_value, fnsku, asin, pack_size, bc_item_number, auto_suggested, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, raw_value) DO UPDATE SET
         taxonomy_id = excluded.taxonomy_id,
         fnsku = excluded.fnsku,
         asin = excluded.asin,
         pack_size = excluded.pack_size,
         bc_item_number = excluded.bc_item_number,
         auto_suggested = excluded.auto_suggested,
         updated_at = excluded.updated_at`,
    )
    .bind(taxonomyId, source, rawValue, fnsku, asin, packSize, bcItemNumber, autoSuggested ? 1 : 0, new Date().toISOString())
    .run();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Best-effort auto-suggestion for an unmapped item name. Deliberately
// conservative: a name that mentions more than one product line (a
// cross-category variety pack) or doesn't clearly match any flavor keyword
// returns null rather than guessing, so it surfaces for manual review
// instead of silently landing in the wrong bucket.
function suggestPlatformMapping(itemName) {
  const name = String(itemName || "").toLowerCase().trim();
  if (!name) return null;

  const mentions = {
    pretzel: name.includes("pretzel"),
    crispbread: name.includes("crispbread"),
    cookie: name.includes("cookie"),
    // "cracker" alone isn't enough to flag this as a separate category — the
    // "Crispbread Crackers" line contains that substring too, which would
    // otherwise make every Crispbread item look cross-category.
    thin: !name.includes("crispbread") && (name.includes("thin") || name.includes("cracker")),
  };
  const categoryCount = Object.values(mentions).filter(Boolean).length;
  if (categoryCount > 1 && name.includes("variety")) return null;

  if (mentions.pretzel) return { product_group: "Pretzel", flavor: "Pretzel" };

  if (mentions.crispbread) {
    if (name.includes("white pepper")) return { product_group: "Crispbread Crackers", flavor: "White Pepper & Garlic" };
    if (name.includes("sea salt")) return { product_group: "Crispbread Crackers", flavor: "Sea Salt" };
    if (name.includes("cranberry")) return { product_group: "Crispbread Crackers", flavor: "Cranberry" };
    if (name.includes("variety")) return { product_group: "Crispbread Crackers", flavor: "Variety" };
    return null;
  }

  if (mentions.cookie) {
    if (name.includes("chocolate chip")) return { product_group: "Cookies", flavor: "Chocolate Chip" };
    if (name.includes("cranberry")) return { product_group: "Cookies", flavor: "Cranberry Vanilla" };
    if (name.includes("ginger")) return { product_group: "Cookies", flavor: "Ginger Cinnamon" };
    if (name.includes("variety")) return { product_group: "Cookies", flavor: "Variety (Cookie)" };
    return null;
  }

  if (mentions.thin) {
    if (name.includes("cheese")) return { product_group: "Thins", flavor: "Cheese-Less" };
    if (name.includes("chive") || name.includes("garlic")) return { product_group: "Thins", flavor: "Chive & Garlic" };
    if (name.includes("fiery") || name.includes("chile") || name.includes("flame")) return { product_group: "Thins", flavor: "Fiery Chile Lime" };
    if (name.includes("sea salt")) return { product_group: "Thins", flavor: "Sea Salt Chia" };
    if (name.includes("variety")) return { product_group: "Thins", flavor: "Variety (Thins)" };
    return null;
  }

  return null;
}

async function getPlatformMetricMappings(env) {
  const { results } = await env.secure_cpg_reviews
    .prepare(
      `SELECT a.raw_value as item_name, a.auto_suggested, t.product_group, t.flavor
       FROM product_aliases a JOIN product_taxonomy t ON t.id = a.taxonomy_id
       WHERE a.source = 'platform_metric'`,
    )
    .all();
  const map = {};
  for (const row of results) {
    map[row.item_name] = { product_group: row.product_group, flavor: row.flavor, autoSuggested: !!row.auto_suggested };
  }
  return map;
}

// Each metric-data.xlsx upload is a full snapshot, not incremental data, so
// this replaces the whole table in one batch (same whole-list-replace
// pattern as the marketing promotions/campaigns tables above).
async function replacePlatformMetricRows(env, rows, sourceFile) {
  const db = env.secure_cpg_reviews;
  const uploadedAt = new Date().toISOString();
  const statements = [db.prepare("DELETE FROM platform_metric_rows")];
  for (const r of rows) {
    statements.push(
      db
        .prepare(
          `INSERT INTO platform_metric_rows
             (item_name, product_group, flavor, review_count, star_rating, refund_rate, ordered_units, ordered_revenue, raw_product_group, uploaded_at, source_file)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          r.item_name,
          r.product_group,
          r.flavor,
          r.review_count,
          r.star_rating,
          r.refund_rate ?? null,
          r.ordered_units ?? null,
          r.ordered_revenue ?? null,
          r.raw_product_group ?? null,
          uploadedAt,
          sourceFile ?? null,
        ),
    );
  }
  await db.batch(statements);
}

async function upsertPlatformMetricMappings(env, mappings) {
  if (mappings.length === 0) return;
  const db = env.secure_cpg_reviews;
  const idMap = await getTaxonomyIdMap(env);
  const updatedAt = new Date().toISOString();
  const statements = [];
  for (const m of mappings) {
    const key = `${m.product_group}::${m.flavor}`;
    let taxonomyId = idMap.get(key);
    if (!taxonomyId) {
      taxonomyId = await getOrCreateTaxonomy(env, m.product_group, m.flavor);
      idMap.set(key, taxonomyId);
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO product_aliases (taxonomy_id, source, raw_value, auto_suggested, updated_at)
           VALUES (?, 'platform_metric', ?, ?, ?)
           ON CONFLICT(source, raw_value) DO UPDATE SET
             taxonomy_id = excluded.taxonomy_id,
             auto_suggested = excluded.auto_suggested,
             updated_at = excluded.updated_at`,
        )
        .bind(taxonomyId, m.item_name, m.autoSuggested ? 1 : 0, updatedAt),
    );
  }
  await db.batch(statements);
}

// Dedupes by (group, flavor, review_count, star_rating): different SKU/pack
// rows for the same Amazon listing (variation children) report identical
// numbers because they share one review pool, so counting each row would
// multiply-count the same reviews. Rows with genuinely different numbers are
// summed as distinct listings. Mirrors the original build_report.py logic.
function aggregatePlatformMetrics(rows) {
  const seen = new Set();
  const perFlavor = {};
  for (const r of rows) {
    const dedupKey = `${r.product_group}::${r.flavor}::${r.review_count}::${r.star_rating}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const key = `${r.product_group}::${r.flavor}`;
    if (!perFlavor[key]) perFlavor[key] = { reviews: 0, wtdSum: 0 };
    perFlavor[key].reviews += r.review_count;
    perFlavor[key].wtdSum += r.review_count * r.star_rating;
  }

  const result = {};
  for (const [key, v] of Object.entries(perFlavor)) {
    result[key] = { reviews: v.reviews, rating: v.reviews > 0 ? round2(v.wtdSum / v.reviews) : 0 };
  }
  return result;
}

async function getPlatformMetricsSummary(env) {
  const { results } = await env.secure_cpg_reviews
    .prepare("SELECT product_group, flavor, review_count, star_rating FROM platform_metric_rows")
    .all();
  if (results.length === 0) return null;
  return aggregatePlatformMetrics(results);
}

// Overlays D1-sourced platform numbers onto the R2-stored report, per
// (group, flavor) — only for pairs the D1 summary actually has data for, so
// anything not yet uploaded keeps its existing R2-baked value rather than
// getting zeroed out. Group- and meta-level platform totals are then
// recomputed as a weighted rollup of the (possibly overridden) flavor
// numbers, so every level of the report stays internally consistent.
function applyPlatformMetrics(report, summary) {
  if (!summary) return report;

  let totalReviews = 0;
  let totalWtdSum = 0;

  for (const group of report.group_order || []) {
    const groupData = report.groups[group];
    let groupReviews = 0;
    let groupWtdSum = 0;

    for (const flavor of groupData.flavor_order || []) {
      const key = `${group}::${flavor}`;
      const override = summary[key];
      const flavorData = groupData.flavors[flavor];
      if (override) {
        flavorData.platform_reviews = override.reviews;
        flavorData.platform_wtd_rating = override.rating;

        const summaryRow = (report.flavor_summary || []).find(
          (r) => r.product_group === group && r.flavor === flavor,
        );
        if (summaryRow) {
          summaryRow.platform_reviews = override.reviews;
          summaryRow.platform_wtd_rating = override.rating;
        }
      }
      groupReviews += flavorData.platform_reviews || 0;
      groupWtdSum += (flavorData.platform_reviews || 0) * (flavorData.platform_wtd_rating || 0);
    }

    groupData.platform_reviews = groupReviews;
    groupData.platform_wtd_rating = groupReviews > 0 ? round2(groupWtdSum / groupReviews) : 0;

    totalReviews += groupReviews;
    totalWtdSum += groupWtdSum;
  }

  report.meta = report.meta || {};
  report.meta.total_platform_reviews = totalReviews;
  report.meta.total_platform_wtd_rating = totalReviews > 0 ? round2(totalWtdSum / totalReviews) : 0;

  return report;
}

// --- Review database import — merges newly scraped Amazon review exports
// into the existing review set (deduped by Review ID) and rebuilds every
// derived field (sentiment counts, theme frequencies, top quotes, flavor
// summary) from the combined set. Ports the same classification rules
// amazon-review-sentiment-report's build_report.py used, so a review added
// here reads identically to one that went through the original skill.
// Nothing separately "refreshes" the sentiment report or homepage after
// this runs — both already read this same R2 object live on every request
// (the report via /api/reviews/report, the homepage's Reviews tile via
// /api/news-summary), so writing the merged JSON here is the whole update. ---

const REVIEW_THEME_DEFS = [
  ["great_taste", "Great Taste", "positive", /delici|tasty|yummy|yum\b|love.{0,15}flavor|amazing.{0,10}taste|so good|great taste|wonderful flavor|wonderful taste/i],
  ["crunch_texture", "Crunch / Texture", "positive", /crisp|crunch|crunchy|texture/i],
  ["gluten_free", "Gluten-Free", "positive", /gluten.?free|gluten free/i],
  ["dairy_free_vegan", "Dairy-Free / Vegan", "positive", /dairy.?free|dairy free|vegan/i],
  ["allergy_friendly", "Allergy-Friendly", "positive", /nut.?free|nut free|allergy|allerg|school safe|allergen/i],
  ["good_replacement", "Good Replacement", "positive", /alternative|replacement|instead of|substitute|swap/i],
  ["repeat_purchase", "Repeat Purchase", "positive", /buy again|will order|reorder|repurchase|keep buying|stock up/i],
  ["clean_ingredients", "Clean Ingredients", "positive", /clean ingredient|simple ingredient|real ingredient|minimal ingredient|whole food/i],
  ["addictive", "Addictive", "positive", /can.t stop|addictive|addicted|one more|hard to stop/i],
  ["value_price", "Good Value", "positive", /worth.{0,10}(price|money|it)|great value|good price|affordable/i],
  ["broken_crumbs", "Broken / Crumbs", "negative", /broken|crumbs|crumbled|crushed|shattered|in pieces/i],
  ["bland_flavor", "Bland / Dry", "negative", /bland|dry\b|flavorless|tasteless|no flavor|boring|watery|not much flavor/i],
  ["too_spicy", "Too Spicy", "negative", /too spicy|too hot|very spicy|burn.{0,15}mouth|spice.{0,10}too much/i],
  ["too_salty", "Too Salty", "negative", /too salt|very salt|overly salt|way too salt/i],
  ["packaging", "Packaging Issues", "negative", /packag|reseal|seal|bag.{0,15}(broke|open|problem)|zip/i],
  ["small_quantity", "Small / Overpriced", "negative", /not enough|small amount|tiny.{0,10}(portion|amount|serving)|overpriced|too expensive|not worth.{0,10}(price|money)/i],
  ["arrived_damaged", "Arrived Damaged", "negative", /arriv.{0,10}(damaged|broken|crushed|smashed)|damaged.{0,10}shipping|shipping damage/i],
  ["stale", "Stale", "negative", /stale|old\b|expired|not fresh|gone bad/i],
  ["false_advertising", "False Advertising", "negative", /mislead|false.{0,15}(claim|label|ad)|lie|not as describ|bait.{0,5}switch|misrepresent/i],
  ["texture_issue", "Texture Issue", "negative", /mushy|soggy|too (hard|tough|dense)|chip.{0,10}tooth|rock hard/i],
  ["not_pretzel", "Doesn't Taste Like Pretzel", "negative", /not.{0,10}pretzel|nothing like.{0,10}pretzel|doesn.t taste like.{0,10}pretzel|not a (real )?pretzel/i],
  ["palm_oil", "Palm Oil Alert", "negative", /palm oil|hidden.{0,10}(ingredient|oil)|unlisted.{0,10}ingredient/i],
];

function classifyReviewSentiment(rating) {
  const r = Math.round(Number(rating));
  if (r >= 4) return "positive";
  if (r === 3) return "neutral";
  return "negative";
}

function detectReviewThemes(text) {
  const found = [];
  for (const [key, , , pattern] of REVIEW_THEME_DEFS) {
    if (pattern.test(text)) found.push(key);
  }
  return found;
}

function computeReviewStats(reviews) {
  const n = reviews.length;
  if (n === 0) {
    return { count: 0, positive: 0, neutral: 0, negative: 0, pos_pct: 0, neu_pct: 0, neg_pct: 0, avg_rating: 0, stars: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
  }
  const positive = reviews.filter((r) => r.sentiment === "positive").length;
  const neutral = reviews.filter((r) => r.sentiment === "neutral").length;
  const negative = reviews.filter((r) => r.sentiment === "negative").length;
  const rated = reviews.filter((r) => r.rating > 0);
  const avg_rating = rated.length ? round2(rated.reduce((s, r) => s + r.rating, 0) / rated.length) : 0;
  const stars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) if (stars[r.rating] !== undefined) stars[r.rating]++;
  return {
    count: n,
    positive,
    neutral,
    negative,
    pos_pct: round2((positive / n) * 100),
    neu_pct: round2((neutral / n) * 100),
    neg_pct: round2((negative / n) * 100),
    avg_rating,
    stars,
  };
}

function computeReviewThemeStats(reviews, polarity) {
  const defs = REVIEW_THEME_DEFS.filter((t) => !polarity || t[2] === polarity);
  const counts = {};
  const quotes = {};
  for (const r of reviews) {
    for (const [key] of defs) {
      if (!r.themes.includes(key)) continue;
      counts[key] = (counts[key] || 0) + 1;
      const snippet = (r.title ? r.title + " — " : "") + String(r.content || "").slice(0, 180);
      if (!quotes[key] || snippet.length > quotes[key].text.length) {
        quotes[key] = { text: snippet, author: r.author, rating: r.rating };
      }
    }
  }
  const result = defs
    .filter(([key]) => counts[key] > 0)
    .map(([key, display, polarityVal]) => ({
      key,
      display,
      polarity: polarityVal,
      count: counts[key],
      pct: reviews.length ? round2((counts[key] / reviews.length) * 100) : 0,
      top_quote: `"${quotes[key].text}"`,
      quote_author: quotes[key].author,
      quote_rating: quotes[key].rating,
    }));
  return result.sort((a, b) => b.count - a.count);
}

// Rebuilds the full report structure from a merged review set. Platform
// (Amazon listing) numbers are carried forward unchanged from the previous
// report — they come from the separate platform-metrics D1 upload, not from
// review data, and /api/reviews/report overlays live D1 numbers on top of
// whatever is here anyway, so staleness here is harmless.
function buildFullReviewReport(allReviews, platformSummary) {
  const overall_stats = computeReviewStats(allReviews);
  const overall_themes = computeReviewThemeStats(allReviews, null);

  // Platform-metric (group, flavor) pairs must be represented in every
  // source view even when the current filter has zero written reviews for
  // them — otherwise total_platform_reviews (and the flavor rollup table)
  // silently shrink depending on which source tab is selected, even though
  // Amazon's own listing review counts have nothing to do with that filter.
  const platformGroupFlavors = {};
  for (const key of Object.keys(platformSummary || {})) {
    const [pg, fl] = key.split("::");
    (platformGroupFlavors[pg] ||= new Set()).add(fl);
  }

  const group_order = [...new Set([...allReviews.map((r) => r.product_group), ...Object.keys(platformGroupFlavors)])].sort();
  const groups = {};

  for (const pg of group_order) {
    const pgReviews = allReviews.filter((r) => r.product_group === pg);

    const flavorsWithReviews = [...new Set(pgReviews.map((r) => r.flavor))];
    const platformOnlyFlavors = [...(platformGroupFlavors[pg] || [])].filter((fl) => !flavorsWithReviews.includes(fl));
    const flavor_order = [...new Set([...flavorsWithReviews, ...platformOnlyFlavors])].sort();

    const flavors = {};
    for (const fl of flavor_order) {
      const flReviews = pgReviews.filter((r) => r.flavor === fl);
      const themesPos = computeReviewThemeStats(flReviews, "positive");
      const themesNeg = computeReviewThemeStats(flReviews, "negative");
      flavors[fl] = {
        stats: computeReviewStats(flReviews),
        themes_pos: themesPos.slice(0, 5),
        themes_neg: themesNeg.slice(0, 5),
        all_themes_pos: themesPos,
        all_themes_neg: themesNeg,
        platform_reviews: 0,
        platform_wtd_rating: 0,
        metric_only: flReviews.length === 0,
      };
    }

    const groupPlatformReviews = Object.values(flavors).reduce((s, f) => s + (f.platform_reviews || 0), 0);
    const groupPlatformWtdSum = Object.values(flavors).reduce(
      (s, f) => s + (f.platform_reviews || 0) * (f.platform_wtd_rating || 0),
      0,
    );

    groups[pg] = {
      stats: computeReviewStats(pgReviews),
      themes_pos: computeReviewThemeStats(pgReviews, "positive").slice(0, 5),
      themes_neg: computeReviewThemeStats(pgReviews, "negative").slice(0, 5),
      platform_reviews: groupPlatformReviews,
      platform_wtd_rating: groupPlatformReviews > 0 ? round2(groupPlatformWtdSum / groupPlatformReviews) : 0,
      flavors,
      flavor_order,
    };
  }

  const flavor_summary = [];
  let totalPlatformReviews = 0;
  let totalPlatformWtdSum = 0;
  for (const pg of group_order) {
    totalPlatformReviews += groups[pg].platform_reviews;
    totalPlatformWtdSum += groups[pg].platform_reviews * groups[pg].platform_wtd_rating;
    for (const fl of groups[pg].flavor_order) {
      const fd = groups[pg].flavors[fl];
      const topTheme = fd.all_themes_pos[0]?.display || fd.all_themes_neg[0]?.display || "—";
      flavor_summary.push({
        product_group: pg,
        flavor: fl,
        platform_reviews: fd.platform_reviews,
        platform_wtd_rating: fd.platform_wtd_rating,
        written_reviews: fd.stats.count,
        written_avg_rating: fd.stats.avg_rating,
        positive: fd.stats.positive,
        neutral: fd.stats.neutral,
        negative: fd.stats.negative,
        pos_pct: fd.stats.pos_pct,
        neu_pct: fd.stats.neu_pct,
        neg_pct: fd.stats.neg_pct,
        top_theme: topTheme,
        metric_only: fd.metric_only,
      });
    }
  }

  return {
    meta: {
      brand: "Every Body Eat",
      total_written_reviews: allReviews.length,
      total_platform_reviews: totalPlatformReviews,
      total_platform_wtd_rating: totalPlatformReviews > 0 ? round2(totalPlatformWtdSum / totalPlatformReviews) : 0,
    },
    overall_stats,
    overall_themes,
    groups,
    group_order,
    flavor_summary,
    reviews: allReviews,
  };
}

// --- Per-source row normalizers. Each turns one raw import row into the
// shared shape the `reviews` table stores, classifying sentiment and themes
// fresh rather than trusting anything the client sent. ---

// Amazon reviews are still assigned product_group/flavor per FILE in the
// browser (update-reviews.html), directly from the canonical taxonomy
// dropdown — so unlike Okendo, there's no raw name to resolve here; the
// group/flavor the client sent already IS the canonical pair, matched
// directly against product_taxonomy (getOrCreateTaxonomy), never an alias.
function normalizeAmazonReviewRow(row) {
  const rating = Math.max(1, Math.min(5, Math.round(Number(row.rating) || 0)));
  const title = String(row.title || "").trim();
  const content = String(row.content || "").trim();
  const fullText = `${title} ${content}`;
  return {
    id: String(row.id || "").trim(),
    source: "amazon",
    author: String(row.author || "Amazon Customer").trim() || "Amazon Customer",
    title,
    content,
    rating,
    sentiment: classifyReviewSentiment(rating),
    product_group: String(row.product_group || "").trim(),
    flavor: String(row.flavor || "").trim(),
    date: String(row.date || "").trim(),
    helpful: Number(row.helpful) || 0,
    verified: String(row.verified || "").toLowerCase().startsWith("y") ? "Yes" : "No",
    variations: String(row.variations || "").trim(),
    pack_size: String(row.pack_size || "").trim(),
    themes: detectReviewThemes(fullText),
    positiveKeywords: null,
    negativeKeywords: null,
    mixedKeywords: null,
  };
}

// Okendo's export truncates timestamps to a date (dateCreated is ISO with
// time, everywhere else in the app a review date is just YYYY-MM-DD).
// Keywords Okendo already extracted (positive/negative/mixedKeywords) are
// kept verbatim alongside our own detectReviewThemes() scan, rather than
// thrown away — they're strictly better signal than reconstructing themes
// from free text alone, which is all Amazon-scraped reviews ever had.
function normalizeOkendoReviewRow(row) {
  const rating = Math.max(1, Math.min(5, Math.round(Number(row.rating) || 0)));
  const title = String(row.title || "").trim();
  const content = String(row.body || row.content || "").trim();
  const fullText = `${title} ${content}`;
  const dateCreated = String(row.dateCreated || "").trim();
  return {
    id: String(row.hash || row.externalId || row.id || "").trim(),
    source: "okendo",
    author: String(row.name || row.author || "Okendo Customer").trim() || "Okendo Customer",
    title,
    content,
    rating,
    sentiment: classifyReviewSentiment(rating),
    raw_product_name: String(row.productName || row.raw_product_name || "").trim() || null,
    date: dateCreated ? dateCreated.slice(0, 10) : "",
    helpful: Number(row.upvotes) || 0,
    verified: String(row.isVerifiedBuyer || "").toLowerCase() === "true" ? "Yes" : "No",
    variations: "",
    pack_size: "",
    themes: detectReviewThemes(fullText),
    positiveKeywords: row.positiveKeywords || null,
    negativeKeywords: row.negativeKeywords || null,
    mixedKeywords: row.mixedKeywords || null,
  };
}

const REVIEW_NORMALIZERS = { amazon: normalizeAmazonReviewRow, okendo: normalizeOkendoReviewRow };

async function findExistingReviewIds(env, source, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const found = new Set();
  // D1 caps bound parameters per statement well under vanilla SQLite's
  // default (999) — keep chunks small, leaving room for the `source` bind.
  const CHUNK = 90;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await env.secure_cpg_reviews
      .prepare(`SELECT id FROM reviews WHERE source = ? AND id IN (${placeholders})`)
      .bind(source, ...chunk)
      .all();
    for (const r of results) found.add(r.id);
  }
  return found;
}

async function countReviews(env, source) {
  const row = await env.secure_cpg_reviews.prepare("SELECT COUNT(*) as n FROM reviews WHERE source = ?").bind(source).first();
  return row?.n || 0;
}

// Inserts a batch of normalized, taxonomy-resolved review rows into D1,
// chunked so one very large import (Okendo exports run 1,000+ rows) stays
// well under a single request's practical statement/time budget.
async function insertReviewsBatch(env, rows, source, sourceFile) {
  const db = env.secure_cpg_reviews;
  const importedAt = new Date().toISOString();
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const statements = chunk.map((r) =>
      db
        .prepare(
          `INSERT INTO reviews
             (id, source, author, title, content, rating, sentiment, taxonomy_id, raw_product_name, date, helpful, verified, variations, pack_size, themes, positive_keywords, negative_keywords, mixed_keywords, imported_at, source_file)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          r.id,
          source,
          r.author,
          r.title,
          r.content,
          r.rating,
          r.sentiment,
          r.taxonomyId,
          r.raw_product_name ?? null,
          r.date,
          r.helpful,
          r.verified,
          r.variations,
          r.pack_size,
          JSON.stringify(r.themes || []),
          r.positiveKeywords ?? null,
          r.negativeKeywords ?? null,
          r.mixedKeywords ?? null,
          importedAt,
          sourceFile,
        ),
    );
    await db.batch(statements);
  }
}

function reviewsToCsv(reviews) {
  const cols = ["id", "source", "product_group", "flavor", "author", "title", "content", "rating", "sentiment", "date", "helpful", "verified", "themes"];
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of reviews) {
    lines.push(cols.map((c) => esc(c === "themes" ? (r.themes || []).join("; ") : r[c])).join(","));
  }
  return lines.join("\n");
}

// Taxonomy rows with every alias mapped to them, for the taxonomy admin view
// — lets Chris see (and correct) exactly which raw Amazon SKUs, platform
// metric item names, and Okendo product names resolve to each flavor.
async function getTaxonomyWithAliases(env) {
  const [taxonomy, aliasResult] = await Promise.all([
    getTaxonomyList(env),
    env.secure_cpg_reviews
      .prepare("SELECT id, taxonomy_id, source, raw_value, auto_suggested FROM product_aliases ORDER BY source, raw_value")
      .all(),
  ]);
  const byTaxonomy = {};
  for (const a of aliasResult.results) {
    (byTaxonomy[a.taxonomy_id] ||= []).push({
      id: a.id,
      source: a.source,
      raw_value: a.raw_value,
      autoSuggested: !!a.auto_suggested,
    });
  }
  return taxonomy.map((t) => ({ ...t, aliases: byTaxonomy[t.id] || [] }));
}

// --- Amazon Product Table — the SKU/FNSKU/ASIN → Product Group/Flavor/Pack
// Size reference sheet, editable in the hub and downloadable as CSV. Stored
// as a single R2 JSON document (columns + rows) rather than a D1 table:
// Chris wants to add whole new columns from the UI, not just rows, which
// SQLite doesn't do gracefully — a document with a column list is much
// simpler to extend than migrating a table schema on every edit. ---

const PRODUCT_TABLE_KEY = "reference/amazon-product-table.json";
const PRODUCT_TABLE_DEFAULT_COLUMNS = ["sku", "fnsku", "asin", "product_group", "flavor", "pack_size", "bc_item_number"];

async function getProductTable(env) {
  const object = await env.CPG_DATA.get(PRODUCT_TABLE_KEY);
  if (!object) return { columns: PRODUCT_TABLE_DEFAULT_COLUMNS, rows: [], updatedAt: null };
  return await object.json();
}

async function saveProductTable(env, columns, rows) {
  const doc = { columns, rows, updatedAt: new Date().toISOString() };
  await env.CPG_DATA.put(PRODUCT_TABLE_KEY, JSON.stringify(doc));
  return doc;
}

function productTableToCsv(doc) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [doc.columns.map(esc).join(",")];
  for (const row of doc.rows) {
    lines.push(doc.columns.map((c) => esc(row[c])).join(","));
  }
  return lines.join("\n");
}

// Builds an ASIN -> {product_group, flavor, pack_size} lookup from the
// product table, for callers that have a real ASIN to join against
// (most metric-data.xlsx exports don't populate ASIN, so this is a
// best-available lookup, not something every row will hit).
function buildAsinLookup(doc, taxonomyGroups) {
  const lookup = {};
  const asinCol = doc.columns.find((c) => c.toLowerCase() === "asin");
  const pgCol = doc.columns.find((c) => c.toLowerCase().replace(/[^a-z]/g, "") === "productgroup");
  const flCol = doc.columns.find((c) => c.toLowerCase() === "flavor");
  const packCol = doc.columns.find((c) => c.toLowerCase().replace(/[^a-z]/g, "") === "packsize");
  if (!asinCol) return lookup;
  for (const row of doc.rows) {
    const asin = String(row[asinCol] || "").trim();
    if (!asin || lookup[asin]) continue;
    const group = pgCol ? row[pgCol] : null;
    lookup[asin] = {
      product_group: group,
      flavor: canonicalizeFlavor(taxonomyGroups, group, flCol ? row[flCol] : null),
      pack_size: packCol ? row[packCol] : null,
    };
  }
  return lookup;
}

// The product table's flavor spelling doesn't always match the taxonomy
// used everywhere else (e.g. it has bare "Variety" for Thins/Cookies, where
// the rest of the app — including the D1 upload validator — expects
// "Variety (Thins)"/"Variety (Cookie)"). Rather than requiring the product
// table itself to be edited to match, treat a value as a match if it's an
// unambiguous prefix of exactly one known flavor in that group.
function canonicalizeFlavor(taxonomyGroups, group, rawFlavor) {
  const flavors = taxonomyGroups[group];
  const flavor = String(rawFlavor || "").trim();
  if (!flavors || !flavor) return flavor;
  if (flavors.includes(flavor)) return flavor;
  const prefixMatches = flavors.filter((f) => f.toLowerCase().startsWith(flavor.toLowerCase() + " ("));
  return prefixMatches.length === 1 ? prefixMatches[0] : flavor;
}

// One row per D1 review import batch, keyed by source ('amazon'/'okendo') —
// MAX(imported_at) is when that source's data was last refreshed, distinct
// from the reviews' own posted dates (used elsewhere for "newest review").
async function getReviewSourceFreshness(env, source) {
  const row = await env.secure_cpg_reviews
    .prepare("SELECT MAX(imported_at) as lastUpdated FROM reviews WHERE source = ?")
    .bind(source)
    .first();
  return row?.lastUpdated || null;
}

// instacart-data-mcp (separate Worker) writes this single row at the end of
// every successful daily sync — see its src/ingest.ts recordSyncCompleted().
async function getInstacartLastSynced(env) {
  try {
    const row = await env.instacart_data.prepare("SELECT last_synced_at FROM sync_state WHERE id = 1").first();
    return row?.last_synced_at || null;
  } catch (err) {
    console.error("Failed to read Instacart sync_state", err);
    return null;
  }
}

// ebe-bc-mcp (separate Worker) tracks per-table sync times in sync_state;
// MAX() across tables gives the most recent Business Central refresh.
async function getBcLastSynced(env) {
  try {
    const row = await env.ebe_bc_database.prepare("SELECT MAX(lastSyncedAt) as lastUpdated FROM sync_state").first();
    return row?.lastUpdated || null;
  } catch (err) {
    console.error("Failed to read BC MCP sync_state", err);
    return null;
  }
}

function dataFreshnessStatus(lastUpdated, thresholdHours, referenceDate) {
  if (!lastUpdated) return "red";
  const updated = new Date(lastUpdated);
  if (Number.isNaN(updated.getTime())) return "red";
  const hoursAgo = (referenceDate.getTime() - updated.getTime()) / 3600000;
  return hoursAgo <= thresholdHours ? "green" : "red";
}

function dataStatusTile(label, lastUpdated, thresholdHours, referenceDate) {
  return { label, lastUpdated, status: dataFreshnessStatus(lastUpdated, thresholdHours, referenceDate) };
}

async function getNewsSummary(env, referenceDate = new Date()) {
  const [reviews, latestSop, issues, shipments, amazonUpdated, okendoUpdated, instacartUpdated, bcUpdated] = await Promise.all([
    getReviewData(env),
    getLatestSop(env),
    getIssuesOpportunities(env, referenceDate),
    getShipmentWeeks(env),
    getReviewSourceFreshness(env, "amazon"),
    getReviewSourceFreshness(env, "okendo"),
    getInstacartLastSynced(env),
    getBcLastSynced(env),
  ]);

  const reviewFreshness = getReviewFreshness(reviews, referenceDate);
  const shipmentWindow = shipments ? selectShipmentWindow(shipments.weeks, referenceDate) : null;
  const reviewHighlights = getReviewHighlights(reviews);

  const SEVEN_DAYS_HOURS = 24 * 7;
  const dataStatus = [
    dataStatusTile("Instacart", instacartUpdated, 24, referenceDate),
    dataStatusTile("Issues/Opportunities", issues ? issues.sourceFileUpdated : null, SEVEN_DAYS_HOURS, referenceDate),
    dataStatusTile("Shipment Data (Demand Plan)", shipments ? shipments.sourceFileUpdated : null, SEVEN_DAYS_HOURS, referenceDate),
    dataStatusTile("Okendo Reviews", okendoUpdated, SEVEN_DAYS_HOURS, referenceDate),
    dataStatusTile("Amazon Reviews", amazonUpdated, SEVEN_DAYS_HOURS, referenceDate),
    dataStatusTile("BC MCP", bcUpdated, SEVEN_DAYS_HOURS, referenceDate),
  ];

  return {
    latestReviews: {
      newestDate: reviewFreshness.newestDate,
      addedLast7Days: reviewFreshness.addedLast7Days,
      addedLast7DaysIds: reviewFreshness.addedLast7DaysIds,
    },
    reviewHighlights,
    latestSop: latestSop ? { title: latestSop.title, uploadedDate: latestSop.uploadedDate } : null,
    issuesSourceTab: issues ? issues.sourceTab : null,
    resolvedThisWeek: issues ? issues.resolvedThisWeek : [],
    shipmentsSourceFileUpdated: shipments ? shipments.sourceFileUpdated : null,
    shipmentsTotal: shipmentWindow ? shipmentWindow.total : null,
    dataStatus,
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
    baselineUnits: row.baseline_units,
    promoRev: row.promo_rev,
    promoUnits: row.promo_units,
    postRev: row.post_rev,
    postUnits: row.post_units,
    costPerRedemption: row.cost_per_redemption,
    otherCosts: row.other_costs,
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
             (id, product, description, channel, retailer, campaign_id, start_date, end_date, ptype, discount, baseline, baseline_units, promo_rev, promo_units, post_rev, post_units, cost_per_redemption, other_costs, true_cost, notes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
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
          p.baselineUnits ?? null,
          p.promoRev ?? null,
          p.promoUnits ?? null,
          p.postRev ?? null,
          p.postUnits ?? null,
          p.costPerRedemption ?? null,
          p.otherCosts ?? null,
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

/* ---------- Marketing: Monthly Channel Budget vs Actuals ---------- */

const BUDGET_CHANNELS = ["Amazon", "Walmart", "TikTok", "DTC", "Whole Foods on Amazon", "Instacart"];
const BUDGET_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function rowToBudgetVersion(row) {
  return {
    id: row.id,
    name: row.name,
    year: row.year,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getBudgetVersions(env) {
  const { results } = await env.secure_cpg_marketing.prepare("SELECT * FROM budget_versions ORDER BY created_at").all();
  return results.map(rowToBudgetVersion);
}

async function getBudgetVersionDetail(env, id) {
  const version = await env.secure_cpg_marketing.prepare("SELECT * FROM budget_versions WHERE id = ?").bind(id).first();
  if (!version) return null;
  const { results } = await env.secure_cpg_marketing
    .prepare("SELECT channel, month, budget_sales, budget_spend FROM budget_line_items WHERE version_id = ?")
    .bind(id)
    .all();
  return {
    version: rowToBudgetVersion(version),
    lineItems: results.map((r) => ({
      channel: r.channel,
      month: r.month,
      budgetSales: r.budget_sales,
      budgetSpend: r.budget_spend,
    })),
  };
}

// Versions are always edited as a full in-memory grid client-side, so a save
// replaces all of that version's line items in one batch (same model as
// promotions' replacePromotions).
async function saveBudgetVersion(env, id, body) {
  const db = env.secure_cpg_marketing;
  const statements = [
    db
      .prepare(
        `INSERT INTO budget_versions (id, name, year, notes, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, year=excluded.year, notes=excluded.notes, updated_at=datetime('now')`,
      )
      .bind(id, body.name, body.year, body.notes ?? null),
    db.prepare("DELETE FROM budget_line_items WHERE version_id = ?").bind(id),
  ];
  for (const li of body.lineItems || []) {
    statements.push(
      db
        .prepare(
          `INSERT INTO budget_line_items (version_id, channel, month, budget_sales, budget_spend) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(id, li.channel, li.month, li.budgetSales ?? null, li.budgetSpend ?? null),
    );
  }
  await db.batch(statements);
}

async function deleteBudgetVersionRow(env, id) {
  await env.secure_cpg_marketing.prepare("DELETE FROM budget_versions WHERE id = ?").bind(id).run();
}

async function duplicateBudgetVersion(env, sourceId, newId, newName) {
  const source = await getBudgetVersionDetail(env, sourceId);
  if (!source) return null;
  await saveBudgetVersion(env, newId, {
    name: newName,
    year: source.version.year,
    notes: source.version.notes,
    lineItems: source.lineItems,
  });
  return getBudgetVersionDetail(env, newId);
}

async function getActiveBudgetVersionId(env) {
  const row = await env.secure_cpg_marketing
    .prepare("SELECT value FROM budget_settings WHERE key = 'active_version_id'")
    .first();
  return row ? row.value : null;
}

async function setActiveBudgetVersionId(env, id) {
  await env.secure_cpg_marketing
    .prepare(
      `INSERT INTO budget_settings (key, value) VALUES ('active_version_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(id)
    .run();
}

// Instacart has its own live-syncing D1 (instacart_data, kept fresh by a
// separate existing pipeline) with real spend and ad-attributed sales, so its
// actuals are queried live here rather than cached in channel_actuals like
// the Triple-Whale-sourced channels — no manual refresh ever needed for it.
async function getInstacartActuals(env) {
  const { results } = await env.instacart_data
    .prepare(
      `SELECT month, SUM(spend) AS spend, SUM(sales) AS sales FROM (
         SELECT substr(date,1,7) AS month, spend, attributed_sales AS sales FROM sp_events
         UNION ALL
         SELECT substr(date,1,7) AS month, spend, (direct_sales + halo_sales) AS sales FROM sd_events
       ) GROUP BY month ORDER BY month`,
    )
    .all();
  return results.map((r) => ({
    channel: "Instacart",
    month: r.month,
    actualSales: r.sales,
    actualSpend: r.spend,
    syncedAt: null,
  }));
}

async function getChannelActuals(env) {
  const { results } = await env.secure_cpg_marketing
    .prepare("SELECT channel, month, actual_sales, actual_spend, synced_at FROM channel_actuals WHERE channel != 'Instacart' ORDER BY month")
    .all();
  const cached = results.map((r) => ({
    channel: r.channel,
    month: r.month,
    actualSales: r.actual_sales,
    actualSpend: r.actual_spend,
    syncedAt: r.synced_at,
  }));
  const instacart = await getInstacartActuals(env);
  return [...cached, ...instacart];
}

// Actuals are upserted per (channel, month) rather than replaced wholesale,
// since a sync only ever covers a subset of channels/months (e.g. refreshing
// just the current month) and shouldn't blow away older cached data.
async function putChannelActuals(env, rows) {
  const db = env.secure_cpg_marketing;
  const statements = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO channel_actuals (channel, month, actual_sales, actual_spend, synced_at) VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(channel, month) DO UPDATE SET
           actual_sales=excluded.actual_sales, actual_spend=excluded.actual_spend, synced_at=datetime('now')`,
      )
      .bind(r.channel, r.month, r.actualSales ?? null, r.actualSpend ?? null),
  );
  await db.batch(statements);
}

function validBudgetVersionBody(b) {
  return (
    b &&
    typeof b.name === "string" &&
    b.name.trim().length > 0 &&
    Number.isInteger(b.year) &&
    Array.isArray(b.lineItems || [])
  );
}

function validActualsRow(r) {
  return r && BUDGET_CHANNELS.includes(r.channel) && BUDGET_MONTH_PATTERN.test(r.month || "");
}

/* ---------- Marketing: Amazon Ad Spend Budget (bottoms-up) ---------- */
// Separate from the Monthly Channel Budget vs Actuals tracker above (top-line
// Sales/Ad Spend vs Actuals) — this models the ad funnel itself: Clicks, CPC,
// and Conversion Rate are budget inputs, Spend/Ad Orders/Ad Sales/ROAS are
// derived. Only Amazon is wired up for now; AD_BUDGET_CHANNELS/line items are
// channel-scoped so Walmart/TikTok Shop/Shopify can be added later without a
// schema change.

const AD_BUDGET_CHANNELS = ["Amazon", "Walmart"];
// Every Body Eat's own Amazon Ads account in Triple Whale. WFMOA reports
// under the same channel='amazon' but a different account_id — excluding it
// here matches how the tracker above splits "Amazon" from "Whole Foods on
// Amazon" as separate channels.
const AMAZON_ADS_ACCOUNT_ID = "1391283812218656";

// Walmart's product catalog in Triple Whale is dozens of individual SKUs/pack
// variants, not a clean small list like Amazon's ASINs — so Walmart's Traffic
// Budget tracks the same 4 product-line categories the Income Statement uses
// (via name-pattern matching over Triple Whale's orders_table), rather than
// per-ASIN. See getWalmartTrafficActualsFromTriplewhale below.
const WALMART_PRODUCT_GROUP_KEYS = ["thins", "cookies", "pretzel", "crispbread"];
const WALMART_PRODUCT_GROUP_KEY_SET = new Set(WALMART_PRODUCT_GROUP_KEYS);
// 3 SKUs with no product name in Triple Whale's data at all — can't be
// categorized without knowing what they are (confirmed with Chris 2026-09-13).
const WALMART_UNCATEGORIZED_SKUS = new Set(["GD-SJJD-VLMR", "VI-VW1L-D7JD", "N3-TCAB-DIQ8"]);
// SKU "30009" and its "30009-01" variant have no product name in the data
// either, but the adjacent "30009-2" SKU is clearly the same Chocolate Chip
// Pack-of-6 item, so these are confidently Cookies rather than uncategorized.
const WALMART_SKU_PREFIX_OVERRIDES = [{ prefix: "30009", group: "cookies" }];
// "Snack Thins and Pretzel Thins Variety Pack" (SKU 30072) is a genuine mixed
// pack — negligible revenue (~$72), defaults to Thins per Chris's call rather
// than splitting it.
const WALMART_SKU_OVERRIDES = { 30072: "thins" };
function walmartProductGroupFor(sku, productName) {
  const skuStr = String(sku ?? "");
  if (WALMART_UNCATEGORIZED_SKUS.has(skuStr)) return null;
  if (WALMART_SKU_OVERRIDES[skuStr]) return WALMART_SKU_OVERRIDES[skuStr];
  for (const { prefix, group } of WALMART_SKU_PREFIX_OVERRIDES) {
    if (skuStr.startsWith(prefix)) return group;
  }
  const name = (productName || "").toLowerCase();
  if (name.includes("pretzel")) return "pretzel"; // checked before "thin" — real pretzel products are named "...Pretzel Thins..."
  if (name.includes("cookie")) return "cookies";
  if (name.includes("crispbread") || name.includes("cracker")) return "crispbread";
  if (name.includes("thin")) return "thins";
  return null;
}

// Product groups the Traffic Budget is split by, one row per (asin, month).
const AD_BUDGET_ASINS = [
  { asin: "B0HF1FS3QM", label: "Snack Thins Full Size" },
  { asin: "B0GZ2Y9TYX", label: "Snack Thins Single Serve" },
  { asin: "B0GP2VN4W5", label: "Cookie Bites Full Size" },
  { asin: "B0F2TML2ZX", label: "Cookie Bites Single Serve" },
  { asin: "B0GNWN9P1W", label: "Crispbread Crackers" },
  { asin: "B0H12RRFS3", label: "Pretzels" },
];
const AD_BUDGET_ASIN_SET = new Set(AD_BUDGET_ASINS.map((p) => p.asin));

// Income Statement product-line categories, rolling the 6 ASINs above up into
// the 4 revenue lines the reference P&L uses (Thins/Cookies each cover a Full
// Size + Single Serve ASIN; Pretzel and Crispbread are single-ASIN lines).
const AD_BUDGET_INCOME_CATEGORIES = [
  { key: 'thins', label: 'Thins Revenue', asins: ['B0HF1FS3QM', 'B0GZ2Y9TYX'] },
  { key: 'cookies', label: 'Cookies Revenue', asins: ['B0GP2VN4W5', 'B0F2TML2ZX'] },
  { key: 'pretzel', label: 'Pretzel Revenue', asins: ['B0H12RRFS3'] },
  { key: 'crispbread', label: 'Crispbread Revenue', asins: ['B0GNWN9P1W'] },
];

// The 8 single-rate Income Statement line items (one rate per version, not
// per month — unlike PPC/Traffic Budget inputs). Amazon Advertising is
// deliberately excluded: its budget and actual come straight from the
// existing PPC Budget tab (Spend), not a rate of Gross Revenue.
const AD_BUDGET_INCOME_ITEMS = [
  { key: 'shipping_income_chargeback', label: 'Shipping Income/Charge Back', group: 'revenue' },
  { key: 'promotions', label: 'Promotions', group: 'revenue' },
  { key: 'selling_fees', label: 'Amazon Selling Fees', group: 'revenue' },
  { key: 'refunds_spoils', label: 'Refunds and Spoils', group: 'revenue' },
  { key: 'fba_fees', label: 'Amazon FBA Fees', group: 'opex' },
  { key: 'misc_other_fees', label: 'Amazon Misc Other Fees', group: 'opex' },
  { key: 'shipping_freight_out', label: 'Amazon Shipping (Freight Out)', group: 'opex' },
  { key: 'fba_fees_storage', label: 'Amazon FBA Fees - Storage', group: 'opex' },
];
const AD_BUDGET_INCOME_ITEM_KEY_SET = new Set(AD_BUDGET_INCOME_ITEMS.map((i) => i.key));

function rowToAdBudgetVersion(row) {
  return {
    id: row.id,
    name: row.name,
    year: row.year,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getAdBudgetVersions(env) {
  const { results } = await env.secure_cpg_marketing.prepare("SELECT * FROM ad_budget_versions ORDER BY created_at").all();
  return results.map(rowToAdBudgetVersion);
}

async function getAdBudgetVersionDetail(env, id) {
  const version = await env.secure_cpg_marketing.prepare("SELECT * FROM ad_budget_versions WHERE id = ?").bind(id).first();
  if (!version) return null;
  const [{ results: liResults }, { results: trafficResults }, { results: incomeResults }] = await Promise.all([
    env.secure_cpg_marketing
      .prepare("SELECT channel, month, clicks, cpc, conversion_rate, aov FROM ad_budget_line_items WHERE version_id = ?")
      .bind(id)
      .all(),
    env.secure_cpg_marketing
      .prepare("SELECT channel, asin, month, sessions, conversion_rate, aov, repeat_sales_pct, units_ordered FROM ad_budget_traffic_line_items WHERE version_id = ?")
      .bind(id)
      .all(),
    env.secure_cpg_marketing
      .prepare("SELECT channel, item_key, rate FROM ad_budget_income_rates WHERE version_id = ?")
      .bind(id)
      .all(),
  ]);
  return {
    version: rowToAdBudgetVersion(version),
    lineItems: liResults.map((r) => ({
      channel: r.channel,
      month: r.month,
      clicks: r.clicks,
      cpc: r.cpc,
      conversionRate: r.conversion_rate,
      aov: r.aov,
    })),
    trafficLineItems: trafficResults.map((r) => ({
      channel: r.channel,
      asin: r.asin,
      month: r.month,
      sessions: r.sessions,
      conversionRate: r.conversion_rate,
      aov: r.aov,
      repeatSalesPct: r.repeat_sales_pct,
      unitsOrdered: r.units_ordered,
    })),
    incomeRates: incomeResults.map((r) => ({
      channel: r.channel,
      itemKey: r.item_key,
      rate: r.rate,
    })),
  };
}

async function saveAdBudgetVersion(env, id, body) {
  const db = env.secure_cpg_marketing;
  const statements = [
    db
      .prepare(
        `INSERT INTO ad_budget_versions (id, name, year, notes, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, year=excluded.year, notes=excluded.notes, updated_at=datetime('now')`,
      )
      .bind(id, body.name, body.year, body.notes ?? null),
    db.prepare("DELETE FROM ad_budget_line_items WHERE version_id = ?").bind(id),
    db.prepare("DELETE FROM ad_budget_traffic_line_items WHERE version_id = ?").bind(id),
    db.prepare("DELETE FROM ad_budget_income_rates WHERE version_id = ?").bind(id),
  ];
  for (const li of body.lineItems || []) {
    statements.push(
      db
        .prepare(`INSERT INTO ad_budget_line_items (version_id, channel, month, clicks, cpc, conversion_rate, aov) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, li.channel, li.month, li.clicks ?? null, li.cpc ?? null, li.conversionRate ?? null, li.aov ?? null),
    );
  }
  for (const ti of body.trafficLineItems || []) {
    // Amazon's traffic rows are keyed by real ASIN; Walmart's are keyed by
    // product-group slug (thins/cookies/pretzel/crispbread) — validate
    // against whichever set matches the row's own channel.
    const validKey = ti.channel === "Walmart" ? WALMART_PRODUCT_GROUP_KEY_SET.has(ti.asin) : AD_BUDGET_ASIN_SET.has(ti.asin);
    if (!validKey) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO ad_budget_traffic_line_items (version_id, channel, asin, month, sessions, conversion_rate, aov, repeat_sales_pct, units_ordered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          ti.channel,
          ti.asin,
          ti.month,
          ti.sessions ?? null,
          ti.conversionRate ?? null,
          ti.aov ?? null,
          ti.repeatSalesPct ?? null,
          ti.unitsOrdered ?? null,
        ),
    );
  }
  for (const ir of body.incomeRates || []) {
    if (!AD_BUDGET_INCOME_ITEM_KEY_SET.has(ir.itemKey)) continue;
    statements.push(
      db
        .prepare(`INSERT INTO ad_budget_income_rates (version_id, channel, item_key, rate) VALUES (?, ?, ?, ?)`)
        .bind(id, ir.channel, ir.itemKey, ir.rate ?? null),
    );
  }
  await db.batch(statements);
}

async function deleteAdBudgetVersionRow(env, id) {
  await env.secure_cpg_marketing.prepare("DELETE FROM ad_budget_versions WHERE id = ?").bind(id).run();
}

async function duplicateAdBudgetVersion(env, sourceId, newId, newName) {
  const source = await getAdBudgetVersionDetail(env, sourceId);
  if (!source) return null;
  await saveAdBudgetVersion(env, newId, {
    name: newName,
    year: source.version.year,
    notes: source.version.notes,
    lineItems: source.lineItems,
    trafficLineItems: source.trafficLineItems,
    incomeRates: source.incomeRates,
  });
  return getAdBudgetVersionDetail(env, newId);
}

async function getActiveAdBudgetVersionId(env) {
  const row = await env.secure_cpg_marketing
    .prepare("SELECT value FROM ad_budget_settings WHERE key = 'active_version_id'")
    .first();
  return row ? row.value : null;
}

async function setActiveAdBudgetVersionId(env, id) {
  await env.secure_cpg_marketing
    .prepare(
      `INSERT INTO ad_budget_settings (key, value) VALUES ('active_version_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(id)
    .run();
}

function validAdBudgetVersionBody(b) {
  return (
    b &&
    typeof b.name === "string" &&
    b.name.trim().length > 0 &&
    Number.isInteger(b.year) &&
    Array.isArray(b.lineItems || [])
  );
}

// Live Amazon Ads actuals from Triple Whale's ads_table for the given
// calendar year — queried fresh on every request (no cache table) so the
// numbers are always current, same reasoning as Instacart's live read above.
async function getAmazonAdActualsFromTriplewhale(env, year) {
  await getTriplewhaleTools(env); // ensures the MCP session is initialized
  const sql = `SELECT toStartOfMonth(adt.event_date) AS month, SUM(adt.spend) AS spend, SUM(adt.clicks) AS clicks, SUM(adt.conversions) AS orders, SUM(adt.conversion_value) AS ad_sales
FROM ads_table AS adt
WHERE adt.channel = 'amazon' AND adt.account_id = '${AMAZON_ADS_ACCOUNT_ID}' AND adt.event_date BETWEEN '${year}-01-01' AND '${year}-12-31'
GROUP BY month ORDER BY month ASC`;
  const result = await callTriplewhaleTool(env, "run-sql", { query: sql });
  if (result?.error) throw new Error(result.error);
  const columns = result?.columns || null;
  const rawRows = result?.rows || [];
  // run-sql returns rows as positional arrays matched to `columns`, not
  // objects with named keys — normalize to objects here before mapping.
  const rows = columns
    ? rawRows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])))
    : rawRows;
  return rows.map((r) => ({
    month: String(r.month).slice(0, 7),
    clicks: Number(r.clicks) || 0,
    spend: Number(r.spend) || 0,
    orders: Number(r.orders) || 0,
    adSales: Number(r.ad_sales) || 0,
  }));
}

// Same as getAmazonAdActualsFromTriplewhale above, for Walmart Connect ads.
// No account_id filter needed — 'walmart-ads' isn't shared with another
// account the way 'amazon' is with Whole Foods on Amazon.
async function getWalmartAdActualsFromTriplewhale(env, year) {
  await getTriplewhaleTools(env);
  const sql = `SELECT toStartOfMonth(adt.event_date) AS month, SUM(adt.spend) AS spend, SUM(adt.clicks) AS clicks, SUM(adt.conversions) AS orders, SUM(adt.conversion_value) AS ad_sales
FROM ads_table AS adt
WHERE adt.channel = 'walmart-ads' AND adt.event_date BETWEEN '${year}-01-01' AND '${year}-12-31'
GROUP BY month ORDER BY month ASC`;
  const result = await callTriplewhaleTool(env, "run-sql", { query: sql });
  if (result?.error) throw new Error(result.error);
  const columns = result?.columns || null;
  const rawRows = result?.rows || [];
  const rows = columns
    ? rawRows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])))
    : rawRows;
  return rows.map((r) => ({
    month: String(r.month).slice(0, 7),
    clicks: Number(r.clicks) || 0,
    spend: Number(r.spend) || 0,
    orders: Number(r.orders) || 0,
    adSales: Number(r.ad_sales) || 0,
  }));
}

// Walmart Traffic Budget actuals: unlike Amazon, there's no marketplace
// page-traffic connector for Walmart (Triple Whale's session tables only
// cover the Shopify DTC website), so this only ever returns unitsOrdered and
// salesAmount — sessions is always null (confirmed with Chris 2026-09-13,
// Sessions/Conversion Rate stay Budget-only inputs for Walmart). Queried live
// from Triple Whale's orders_table on every request, no cache table, same
// reasoning as the Amazon Ads query above. Per-line revenue uses the
// products_info tuple's own price x quantity (not the order-level total),
// since one order can contain multiple different products.
async function getWalmartTrafficActualsFromTriplewhale(env, year) {
  await getTriplewhaleTools(env);
  const sql = `WITH exploded AS (
  SELECT event_date, arrayJoin(products_info) AS p
  FROM orders_table
  WHERE platform = 'walmart' AND event_date BETWEEN '${year}-01-01' AND '${year}-12-31'
)
SELECT toStartOfMonth(event_date) AS month, p.product_sku AS sku, p.product_name AS product_name,
       SUM(p.product_name_price * p.product_name_quantity_sold) AS revenue,
       SUM(p.product_name_quantity_sold) AS units
FROM exploded
GROUP BY month, sku, product_name
ORDER BY month ASC`;
  const result = await callTriplewhaleTool(env, "run-sql", { query: sql });
  if (result?.error) throw new Error(result.error);
  const columns = result?.columns || null;
  const rawRows = result?.rows || [];
  const rows = columns
    ? rawRows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])))
    : rawRows;

  const byMonthGroup = new Map(); // "month|group" -> { month, asin: group, unitsOrdered, salesAmount }
  for (const r of rows) {
    const group = walmartProductGroupFor(r.sku, r.product_name);
    if (!group) continue; // uncategorized SKU — excluded per Chris's call, not silently lumped into a category
    const month = String(r.month).slice(0, 7);
    const key = `${month}|${group}`;
    if (!byMonthGroup.has(key)) byMonthGroup.set(key, { month, asin: group, sessions: null, unitsOrdered: 0, salesAmount: 0 });
    const row = byMonthGroup.get(key);
    row.unitsOrdered += Number(r.units) || 0;
    row.salesAmount += Number(r.revenue) || 0;
  }
  return [...byMonthGroup.values()];
}

// Walmart Traffic Budget actuals, sourced directly from the Walmart
// Marketplace API's own order data (env.secure_cpg_walmart — see
// syncWalmartMarketplaceOrders) instead of Triple Whale's copy. More
// authoritative and doesn't depend on a third-party ETL, but only covers the
// last ~180 days — that's a hard limit of Walmart's own Orders API, not
// something this Worker can work around (confirmed against Walmart's docs
// 2026-09-15). getWalmartTrafficActualsFromTriplewhale above is left in place
// as a fallback for months outside that window, in case Triple Whale's
// history is ever wired back in. Same categorization (walmartProductGroupFor)
// and per-line-item revenue basis as the Triple Whale version, just reading
// charge_amount/quantity off our own walmart_order_lines instead.
async function getWalmartTrafficActualsFromD1(env, year) {
  const { results } = await env.secure_cpg_walmart
    .prepare(
      `SELECT o.order_date, l.sku, l.item_name, l.quantity, l.charge_amount
       FROM walmart_order_lines l
       JOIN walmart_orders o ON o.purchase_order_id = l.purchase_order_id
       WHERE o.order_date BETWEEN ? AND ?`,
    )
    .bind(`${year}-01-01`, `${year}-12-31T23:59:59Z`)
    .all();

  const byMonthGroup = new Map(); // "month|group" -> { month, asin: group, sessions: null, unitsOrdered, salesAmount }
  for (const r of results) {
    const group = walmartProductGroupFor(r.sku, r.item_name);
    if (!group) continue; // uncategorized SKU — excluded per Chris's call, not silently lumped into a category
    const month = String(r.order_date).slice(0, 7);
    const key = `${month}|${group}`;
    if (!byMonthGroup.has(key)) byMonthGroup.set(key, { month, asin: group, sessions: null, unitsOrdered: 0, salesAmount: 0 });
    const row = byMonthGroup.get(key);
    row.unitsOrdered += Number(r.quantity) || 0;
    row.salesAmount += Number(r.charge_amount) || 0;
  }
  return [...byMonthGroup.values()];
}

// Per-product Traffic Budget actuals (Sessions, Units Ordered, Sales Amount)
// are fed into ad_budget_traffic_actuals via a GitHub relay, not fetched live
// or pulled directly by this Worker. Chain: a nightly Claude scheduled agent
// calls Sophie Society's query_sales_traffic MCP tool (fast, backed by
// pre-ingested S3 data) and commits the result as JSON to the private repo
// cfuoss/ebe-data-cache; this Worker's own Cron Trigger (see scheduled()
// below) then pulls that file via GitHub's Contents API and upserts it here.
// The relay exists because neither more direct path works: Windsor.ai's
// per-ASIN Amazon Sales & Traffic query hangs indefinitely (Amazon's own
// report generation for that breakdown is very slow, confirmed via direct
// fetch()), and the scheduled agent's sandbox has an egress allowlist that
// blocks direct HTTP calls to this Worker's own domain (MCP traffic and git
// operations are allowed; arbitrary HTTPS fetch is not) — so the ingest route
// below is reachable only from the manual/testing path, not the automation.
function validAmazonTrafficActualsRow(r) {
  return (
    r &&
    AD_BUDGET_ASIN_SET.has(r.asin) &&
    typeof r.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.date)
  );
}

async function upsertAmazonTrafficActuals(env, rows) {
  const db = env.secure_cpg_marketing;
  const statements = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO ad_budget_traffic_actuals (channel, asin, event_date, sessions, units_ordered, sales_amount, updated_at)
         VALUES ('Amazon', ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(channel, asin, event_date) DO UPDATE SET
           sessions=excluded.sessions, units_ordered=excluded.units_ordered, sales_amount=excluded.sales_amount, updated_at=datetime('now')`,
      )
      .bind(r.asin, r.date, r.sessions ?? 0, r.unitsOrdered ?? 0, r.salesAmount ?? 0),
  );
  if (statements.length) await db.batch(statements);
  return statements.length;
}

// Pulls the latest relay file from the private GitHub repo (see comment
// above) via the Contents API — which resolves the default branch on its
// own, so this doesn't need to guess "main" vs "master" — and upserts it
// into the daily cache.
async function syncAmazonTrafficActualsFromGithub(env) {
  const res = await fetch("https://api.github.com/repos/cfuoss/ebe-data-cache/contents/traffic-actuals-latest.json", {
    headers: {
      Authorization: `Bearer ${env.GITHUB_DATA_CACHE_TOKEN}`,
      Accept: "application/vnd.github.raw+json",
      "User-Agent": "secure-cpg-demo-worker",
    },
  });
  if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("Expected traffic-actuals-latest.json to be a JSON array.");
  const validRows = rows.filter(validAmazonTrafficActualsRow);
  const count = await upsertAmazonTrafficActuals(env, validRows);
  return { pulled: rows.length, cached: count };
}

// Reads the daily cache and sums it up to months for the given year — the
// Traffic Budget by Product table is monthly, but the cache stores Amazon's
// native daily grain so re-aggregation here never double-counts.
async function getAmazonTrafficActualsFromCache(env, year) {
  const { results } = await env.secure_cpg_marketing
    .prepare(
      `SELECT asin, substr(event_date, 1, 7) AS month, SUM(sessions) AS sessions, SUM(units_ordered) AS units_ordered, SUM(sales_amount) AS sales_amount
       FROM ad_budget_traffic_actuals
       WHERE channel = 'Amazon' AND event_date BETWEEN ? AND ?
       GROUP BY asin, month ORDER BY month ASC, asin ASC`,
    )
    .bind(`${year}-01-01`, `${year}-12-31`)
    .all();
  return results.map((r) => ({
    month: r.month,
    asin: r.asin,
    sessions: Number(r.sessions) || 0,
    unitsOrdered: Number(r.units_ordered) || 0,
    salesAmount: Number(r.sales_amount) || 0,
  }));
}

// Income Statement actuals, live from Business Central (env.ebe_bc_database —
// a synced mirror kept by the separate ebe-bc-mcp Worker) exclusively — no
// other MCP/data source feeds this endpoint. Same "query fresh every
// request, no cache table" pattern as getAmazonAdActualsFromTriplewhale
// above. Each of these 9 GL accounts is Amazon-only by definition/booking
// convention (confirmed with Chris — not blended with Walmart/TikTok/
// wholesale/etc.), unlike the 4 product-line revenue accounts (40210/40220/
// 40230/40240), which ARE blended across every sales channel with no
// per-GL-entry channel field — see getRevenueActualsFromBc below for
// how those get scoped to Amazon anyway (via each sales invoice's own
// channel dimension). debitAmount - creditAmount gives the right signed monthly
// contribution for every account here regardless of its normal balance: it's
// positive (a deduction) for the debit-normal expense/discount accounts, and
// negative (an addition back to Net Revenue) for the credit-normal Shipping
// Income account — both fall out of the same formula, no per-account sign
// special-casing needed.
const AD_BUDGET_INCOME_BC_ACCOUNTS = {
  shipping_income_chargeback: "40298",
  promotions: "40340",
  selling_fees: "61250",
  refunds_spoils: "40430",
  fba_fees: "61220",
  misc_other_fees: "61240",
  shipping_freight_out: "61330",
  fba_fees_storage: "61225",
  // Not one of the 8 rate items (Advertising has no rate input — its Budget
  // comes from the PPC Budget tab), but its Actual pulls from BC too, same as
  // every other Income Statement actual — no other MCP/data source is used here.
  advertising: "61810",
};
// Walmart's parallel fee structure. No shipping_income_chargeback/promotions/
// refunds_spoils equivalents: those 3 accounts on the Amazon side are shared,
// whole-account, no-channel-filter numbers (Chris confirmed "Amazon-only in
// practice" for Amazon) — reusing them for Walmart would double-count the
// same dollars in both channels' statements, and there's no dedicated
// Walmart account for any of the 3. Confirmed with Chris 2026-09-13: leave
// them out of Walmart's Income Statement entirely rather than guess.
const WALMART_INCOME_BC_ACCOUNTS = {
  selling_fees: "61265", // Walmart Net Commissions
  fba_fees: "61270", // Walmart Fulfillment Fees
  misc_other_fees: "61280", // Walmart Adjustments
  shipping_freight_out: "61285", // Walmart Freight
  fba_fees_storage: "61275", // Walmart Storage Fees
  advertising: "61811", // Walmart Advertising
};

// Generic version of the two channel-specific functions this replaced
// (this used to be two separate near-identical Amazon/Walmart functions —
// been identical apart from the account map) — takes any {itemKey: account}
// map and returns the same debitAmount - creditAmount signed monthly
// contribution described above, since every account in both maps is a
// debit-normal expense/discount account (or, for Shipping Income, the one
// credit-normal exception where the same formula still yields the correct
// sign — see the comment above AD_BUDGET_INCOME_BC_ACCOUNTS's original
// version for why no per-account sign special-casing is needed).
async function getIncomeActualsFromBc(env, year, accountMap) {
  const accounts = Object.values(accountMap);
  const accountToItem = Object.fromEntries(Object.entries(accountMap).map(([itemKey, account]) => [account, itemKey]));
  const placeholders = accounts.map(() => "?").join(",");
  const { results } = await env.ebe_bc_database
    .prepare(
      `SELECT substr(postingDate, 1, 7) AS month, accountNumber,
              SUM(debitAmount) AS debit, SUM(creditAmount) AS credit
       FROM generalLedgerEntries
       WHERE accountNumber IN (${placeholders}) AND postingDate BETWEEN ? AND ?
       GROUP BY month, accountNumber`,
    )
    .bind(...accounts, `${year}-01-01`, `${year}-12-31 23:59:59`)
    .all();
  return results.map((r) => ({
    month: r.month,
    itemKey: accountToItem[r.accountNumber],
    amount: (Number(r.debit) || 0) - (Number(r.credit) || 0),
  }));
}

// Revenue category accounts (Thins/Cookies/Pretzel/Crispbread) are blended
// across every sales channel — unlike the fee/advertising accounts above,
// which are Amazon-only by account definition, these need an explicit
// channel filter. Business Central has no per-GL-entry channel field, but
// each sales invoice carries one (shortcutDimension1Code — its "Sales
// Channel" dimension), and generalLedgerEntries.documentNumber matches
// salesInvoices.number 1:1, so joining recovers it. Code "205" is confirmed
// as "Amazon" (its dimensionValues row exists but is orphaned from the
// SALESCHANNELS dimension group in this mirror's sync, which is why it
// didn't show up when the fee accounts above were first investigated).
// creditAmount - debitAmount (not debit - credit, the opposite of the fee
// accounts) because these are credit-normal income accounts and we want a
// natural positive revenue figure, matching how Traffic Budget's Gross Sales
// is already signed.
const AD_BUDGET_REVENUE_BC_ACCOUNTS = {
  thins: "40240",
  cookies: "40210",
  pretzel: "40220",
  crispbread: "40230",
};
// Same 4 GL accounts for every channel (they're blended across all of them) —
// only the Sales Channel dimension code differs. Code "205" = Amazon (its
// dimensionValues row is orphaned from the SALESCHANNELS dimension group in
// this mirror's sync, which is why it didn't show up in the first pass);
// code "210" = "Walmart.com", cleanly linked.
const AMAZON_SALES_CHANNEL_DIMENSION_CODE = "205";
const WALMART_SALES_CHANNEL_DIMENSION_CODE = "210";

// Takes any {itemKey: account} map plus the channel's own Sales Channel
// dimension code, so one function covers every channel's revenue query.
// creditAmount - debitAmount (not debit - credit, the opposite of the fee
// accounts) because these are credit-normal income accounts and we want a
// natural positive revenue figure, matching how Traffic Budget's Gross Sales
// is already signed.
async function getRevenueActualsFromBc(env, year, accountMap, dimensionCode) {
  const accounts = Object.values(accountMap);
  const accountToKey = Object.fromEntries(Object.entries(accountMap).map(([key, account]) => [account, key]));
  const placeholders = accounts.map(() => "?").join(",");
  const { results } = await env.ebe_bc_database
    .prepare(
      `SELECT substr(gle.postingDate, 1, 7) AS month, gle.accountNumber,
              SUM(gle.creditAmount) AS credit, SUM(gle.debitAmount) AS debit
       FROM generalLedgerEntries gle
       JOIN salesInvoices si ON si.number = gle.documentNumber
       WHERE gle.accountNumber IN (${placeholders})
         AND si.shortcutDimension1Code = ?
         AND gle.postingDate BETWEEN ? AND ?
       GROUP BY month, gle.accountNumber`,
    )
    .bind(...accounts, dimensionCode, `${year}-01-01`, `${year}-12-31 23:59:59`)
    .all();
  return results.map((r) => ({
    month: r.month,
    itemKey: accountToKey[r.accountNumber],
    amount: (Number(r.credit) || 0) - (Number(r.debit) || 0),
  }));
}

async function getIncomeActualsManual(env, channel) {
  const { results } = await env.secure_cpg_marketing
    .prepare("SELECT month, item_key, amount FROM ad_income_actuals_manual WHERE channel = ?")
    .bind(channel)
    .all();
  return results.map((r) => ({ month: r.month, itemKey: r.item_key, amount: r.amount }));
}

function validIncomeActualsManualRow(r) {
  return r && AD_BUDGET_INCOME_ITEM_KEY_SET.has(r.itemKey) && typeof r.month === "string" && /^\d{4}-\d{2}$/.test(r.month);
}

async function putIncomeActualsManual(env, channel, rows) {
  const db = env.secure_cpg_marketing;
  const statements = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO ad_income_actuals_manual (channel, month, item_key, amount, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(channel, month, item_key) DO UPDATE SET
           amount=excluded.amount, updated_at=datetime('now')`,
      )
      .bind(channel, r.month, r.itemKey, r.amount ?? null),
  );
  if (statements.length) await db.batch(statements);
}

async function getManualAdActuals(env, channel) {
  const { results } = await env.secure_cpg_marketing
    .prepare("SELECT channel, month, clicks, spend, orders, ad_sales, updated_at FROM ad_actuals_manual WHERE channel = ?")
    .bind(channel)
    .all();
  return results.map((r) => ({
    month: r.month,
    clicks: r.clicks,
    spend: r.spend,
    orders: r.orders,
    adSales: r.ad_sales,
    updatedAt: r.updated_at,
  }));
}

async function putManualAdActuals(env, rows) {
  const db = env.secure_cpg_marketing;
  const statements = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO ad_actuals_manual (channel, month, clicks, spend, orders, ad_sales, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(channel, month) DO UPDATE SET
           clicks=excluded.clicks, spend=excluded.spend, orders=excluded.orders, ad_sales=excluded.ad_sales, updated_at=datetime('now')`,
      )
      .bind(r.channel, r.month, r.clicks ?? null, r.spend ?? null, r.orders ?? null, r.adSales ?? null),
  );
  await db.batch(statements);
}

function deriveAdMetrics(row) {
  const clicks = row.clicks ?? null;
  const spend = row.spend ?? null;
  const orders = row.orders ?? null;
  const adSales = row.adSales ?? null;
  return {
    clicks,
    spend,
    orders,
    adSales,
    cpc: clicks ? spend / clicks : null,
    conversionRate: clicks ? orders / clicks : null,
    roas: spend ? adSales / spend : null,
  };
}

// Combines live Triple Whale actuals with manual overrides (for months TW
// has no data for, e.g. before Amazon Ads was connected there). A manual row
// always wins for its month when present, so re-entering a month after TW
// picks it up just means clearing the manual row.
const AD_CHANNEL_TRIPLEWHALE_FN = {
  Amazon: getAmazonAdActualsFromTriplewhale,
  Walmart: getWalmartAdActualsFromTriplewhale,
};

async function getAdChannelActuals(env, channel, year) {
  const twSourceFn = AD_CHANNEL_TRIPLEWHALE_FN[channel];
  if (!twSourceFn) return { actuals: [], twError: null }; // no live source wired up for this channel

  let twRows = [];
  let twError = null;
  try {
    twRows = await twSourceFn(env, year);
  } catch (err) {
    twError = err.message;
  }
  const manualRows = await getManualAdActuals(env, channel);

  const byMonth = new Map();
  for (const r of twRows) byMonth.set(r.month, { ...r, source: "triplewhale" });
  for (const r of manualRows) {
    if (r.clicks == null && r.spend == null && r.orders == null && r.adSales == null) continue;
    byMonth.set(r.month, {
      month: r.month,
      clicks: r.clicks,
      spend: r.spend,
      orders: r.orders,
      adSales: r.adSales,
      source: "manual",
    });
  }

  const actuals = [...byMonth.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((r) => ({ channel, month: r.month, source: r.source, ...deriveAdMetrics(r) }));

  return { actuals, twError };
}

function validAdManualActualsRow(r) {
  return r && AD_BUDGET_CHANNELS.includes(r.channel) && BUDGET_MONTH_PATTERN.test(r.month || "");
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

const MARKETING_EVENT_ASSET_PREFIX = "marketing/events/";

function rowToEvent(row) {
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

async function getEvents(env) {
  const { results } = await env.secure_cpg_marketing.prepare("SELECT * FROM events ORDER BY id").all();
  return results.map(rowToEvent);
}

async function upsertEvent(env, ev) {
  await env.secure_cpg_marketing
    .prepare(
      `INSERT INTO events (id, name, channels, start_date, end_date, status, owner, brief, assets_needed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, channels=excluded.channels, start_date=excluded.start_date,
         end_date=excluded.end_date, status=excluded.status, owner=excluded.owner,
         brief=excluded.brief, assets_needed=excluded.assets_needed, updated_at=datetime('now')`,
    )
    .bind(
      ev.id,
      ev.name,
      JSON.stringify(ev.channels || []),
      ev.start ?? null,
      ev.end ?? null,
      ev.status ?? null,
      ev.owner ?? null,
      ev.brief ?? null,
      JSON.stringify(ev.assetsNeeded || []),
    )
    .run();
}

async function deleteEventRow(env, id) {
  await env.secure_cpg_marketing.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
}

function eventAssetKey(eventId, filename) {
  return `${MARKETING_EVENT_ASSET_PREFIX}${eventId}/${filename}`;
}

async function putEventAsset(env, eventId, filename, file) {
  await env.CPG_DATA.put(eventAssetKey(eventId, filename), file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
}

async function getEventAsset(env, eventId, filename) {
  return env.CPG_DATA.get(eventAssetKey(eventId, filename));
}

async function deleteEventAsset(env, eventId, filename) {
  await env.CPG_DATA.delete(eventAssetKey(eventId, filename));
}

async function deleteAllEventAssets(env, eventId) {
  const listed = await env.CPG_DATA.list({ prefix: `${MARKETING_EVENT_ASSET_PREFIX}${eventId}/` });
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

// --- Instacart Ads data (local D1, same database instacart-data-mcp fills) ---
// secure-cpg-demo already binds this D1 directly (env.instacart_data, used
// for the home page sync tile) — no remote MCP call needed, just a guarded
// read-only SQL tool over the same tables instacart-data-mcp's own MCP
// server (get_schema/query_instacart_data) exposes.
const INSTACART_SQL_FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|pragma|vacuum)\b/i;
const INSTACART_QUERY_ROW_CAP = 1000;

function assertReadOnlySql(sql) {
  const trimmed = String(sql || "").trim().replace(/;+\s*$/, "");
  if (!trimmed) throw new Error("SQL query is required.");
  if (trimmed.includes(";")) throw new Error("Only a single SQL statement is allowed.");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Only SELECT/WITH statements are allowed.");
  if (INSTACART_SQL_FORBIDDEN.test(trimmed)) throw new Error("Query contains a forbidden keyword.");
  return trimmed;
}

async function queryInstacartData(env, sql) {
  const cleanSql = assertReadOnlySql(sql);
  const { results } = await env.instacart_data.prepare(cleanSql).all();
  const truncated = results.length > INSTACART_QUERY_ROW_CAP;
  return {
    rowCount: results.length,
    truncated,
    rows: truncated ? results.slice(0, INSTACART_QUERY_ROW_CAP) : results,
  };
}

const INSTACART_SCHEMA_NOTES = `Instacart Ads data (Every Body Eat) — Sponsored Products + Sponsored Display. SQLite dialect (Cloudflare D1, not ClickHouse/Postgres).

sp_events (Sponsored Products, one row per campaign per day):
  date (YYYY-MM-DD), campaign (name), spend, attributed_sales, ntb_attributed_sales

sd_events (Sponsored Display, one row per campaign per day):
  date (YYYY-MM-DD), name (campaign name), starts_at, ends_at, status (ACTIVE/PAUSED/ENDED),
  spend, direct_sales, halo_sales, ntb_direct_sales

campaigns (Sponsored Products only — one row per campaign, current state):
  uuid, name, campaign_type (always "featured_product" for SP), campaign_status
  (active/paused/draft/ended), enabled, target_daily_budget, budget_type,
  avg_missed_auctions_percentage (Instacart's own at-risk flag)

campaign_budget_insights (Sponsored Products only, rolling 7-day window; join to campaigns
  on campaign_uuid = uuid): campaign_uuid, date, missed_auction_participation_rate,
  estimated_missed_impressions, estimated_missed_sales

Notes:
- ROAS = sales / spend. For SD use direct_sales as "sales" (halo_sales already includes
  direct_sales — never add them together, that double-counts).
- NTB% = ntb_attributed_sales / attributed_sales (SP) or ntb_direct_sales / direct_sales (SD),
  as a fraction of the campaign's own sales, times 100.
- Campaign "type" is: Sponsored Display (its own channel), or for Sponsored Products, inferred
  from the campaign name — names containing "Acquire"/"Aquire" are Acquire, everything else
  is Max Sales.
- This data source does NOT include clicks, impressions, CTR, average CPC, or attributed
  units — Instacart's pull for this account never captured those fields. If asked for them,
  say clearly they aren't available here rather than estimating or inventing them.
- Data covers a rolling ~20-month window and is fully replaced on every pull (no append-only
  history beyond what's currently in these tables).`;

const INSTACART_TOOLS = [
  {
    name: "query_instacart_data",
    description:
      "Run a read-only SQL SELECT query against Instacart Ads data (Sponsored Products + Sponsored Display campaign spend, sales, and new-to-brand metrics). Only SELECT/WITH, single statement, results capped at 1000 rows — include your own ORDER BY/LIMIT for predictable results.\n\n" +
      INSTACART_SCHEMA_NOTES,
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single read-only SQL SELECT statement (SQLite dialect)." },
      },
      required: ["sql"],
    },
  },
];

// --- Triple Whale MCP proxy (DTC order/revenue/attribution + ad-platform
// performance data — the default marketing/ad-spend source; windsor-ai was
// removed from this loop because its Anthropic-native MCP connector runs
// windsor-ai's entire tool-use loop inside a single Claude API call with no
// visibility into it, so a slow/hung Windsor request looked like the whole
// chat was stuck with no status update the whole time.) ---
// Triple Whale's endpoint authenticates via an `x-api-key` header, which
// Anthropic's server-side MCP connector can't send — it only ever sends
// `Authorization: Bearer`, and Triple Whale rejects that for an API key
// (confirmed: 401 "Invalid or expired token" on Bearer, 200 OK on
// x-api-key). So instead of connecting Claude to Triple Whale directly, this
// Worker speaks MCP to them itself and hands the resulting tools to Claude
// as regular function-call tools — same shape as get_reviews/get_sops.
const TRIPLEWHALE_MCP_URL = "https://mcp.triplewhale.com/v1/mcp";
const TRIPLEWHALE_TOOLS_CACHE_MS = 10 * 60 * 1000;
let twToolsCache = null;
let twToolsCacheAt = 0;

async function triplewhaleRequest(env, method, params, attempt = 1) {
  const response = await fetch(TRIPLEWHALE_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": env.TRIPLEWHALE_API_KEY,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });

  const raw = await response.text();

  // A non-2xx here can be a plain-text infra error (e.g. "no healthy
  // upstream" from whatever fronts their endpoint), not JSON — check status
  // before ever trying to parse, and retry once since these look transient.
  if (!response.ok) {
    if (attempt < 2) return triplewhaleRequest(env, method, params, attempt + 1);
    throw new Error(`Triple Whale MCP error: ${response.status} — ${raw.slice(0, 200)}`);
  }

  // On success, Triple Whale responds with a single SSE-framed event rather
  // than plain JSON — pull the JSON payload out of the "data:" line.
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  let json;
  try {
    json = dataLine ? JSON.parse(dataLine.slice(5).trim()) : raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Triple Whale MCP returned an unparseable response: ${raw.slice(0, 200)}`);
  }

  if (json.error) {
    throw new Error(json.error.message || "Triple Whale MCP returned an error.");
  }
  return json.result;
}

async function triplewhaleNotify(env, method, params) {
  // True JSON-RPC notification (no id, no response expected) — best-effort.
  await fetch(TRIPLEWHALE_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": env.TRIPLEWHALE_API_KEY,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  }).catch(() => {});
}

// Fetches Triple Whale's tool list (converted to Anthropic's tool schema)
// plus their server-provided workflow instructions, once per warm isolate.
async function getTriplewhaleTools(env) {
  const now = Date.now();
  if (twToolsCache && now - twToolsCacheAt < TRIPLEWHALE_TOOLS_CACHE_MS) {
    return twToolsCache;
  }

  const init = await triplewhaleRequest(env, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "secure-cpg-demo", version: "1.0" },
  });
  await triplewhaleNotify(env, "notifications/initialized", {});
  const list = await triplewhaleRequest(env, "tools/list", {});

  const tools = (list.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const fetched = { tools, instructions: init.instructions || "" };
  twToolsCache = fetched;
  twToolsCacheAt = now;
  return fetched;
}

async function callTriplewhaleTool(env, name, args) {
  const result = await triplewhaleRequest(env, "tools/call", { name, arguments: args || {} });

  if (result?.isError) {
    const text = (result.content || []).map((c) => c.text).join("\n");
    return { error: text || "Triple Whale tool returned an error." };
  }
  // Prefer structuredContent (already a parsed object matching the tool's
  // outputSchema) over re-parsing the text content block.
  if (result?.structuredContent !== undefined) return result.structuredContent;

  const text = (result?.content || []).map((c) => c.text).join("\n");
  if (!text) return { error: "Triple Whale tool returned no content." };
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

const TRIPLEWHALE_TOOL_STATUS_LABELS = {
  "list-stores": "Checking connected stores…",
  "get-shop-info": "Loading store context…",
  "get-available-tables": "Looking up available e-commerce data…",
  "get-table-schemas": "Checking data structure…",
  "find-sql-examples": "Finding a similar query…",
  "get-date-range": "Resolving date range…",
  "run-sql": "Querying e-commerce data…",
  "search-knowledge-base": "Searching Triple Whale docs…",
  "get-summary-kpis": "Pulling summary KPIs…",
  "explain-metric-change": "Analyzing what changed…",
  "pixel-attribution": "Pulling attribution data…",
};

function friendlyToolLabel(name) {
  if (name === "get_reviews") return "Checking customer reviews…";
  if (name === "get_sops") return "Searching SOPs…";
  if (name === "query_instacart_data") return "Querying Instacart ad data…";
  if (TRIPLEWHALE_TOOL_STATUS_LABELS[name]) return TRIPLEWHALE_TOOL_STATUS_LABELS[name];
  return `Using ${name}…`;
}

// Human-readable data source for a tool call — shown in the "Checked: ..."
// line under a chat answer, and while the loop is synthesizing an answer
// from already-fetched data ("Pulling together data from ...").
function toolSourceLabel(name, triplewhaleToolNames) {
  if (name === "get_reviews") return "Reviews";
  if (name === "get_sops") return "SOPs";
  if (name === "query_instacart_data") return "Instacart";
  if (triplewhaleToolNames?.has(name)) return "Triple Whale";
  return null;
}

async function executeTool(env, name, input, triplewhaleToolNames) {
  const start = Date.now();
  logEvent("tool_call_start", { tool: name });

  let result;
  if (name === "get_reviews") {
    result = await getReviewsForTool(env, input);
  } else if (name === "get_sops") {
    result = await getSopsForTool(env, input);
  } else if (name === "query_instacart_data") {
    try {
      result = await queryInstacartData(env, input?.sql);
    } catch (err) {
      result = { error: err.message };
    }
  } else if (triplewhaleToolNames?.has(name)) {
    result = await callTriplewhaleTool(env, name, input);
  } else {
    result = { error: `Unknown tool: ${name}` };
  }

  logEvent("tool_call_end", { tool: name, durationMs: Date.now() - start });
  return result;
}

// --- Agentic tool-use loop ---
const CHAT_SYSTEM_PROMPT =
  "You are an assistant for a CPG (consumer packaged goods) company. You help analyze customer review data, marketing/ad platform performance data, e-commerce order/revenue data, Instacart ad performance data, and internal Standard Operating Procedures (SOPs). Use the get_reviews tool to look up real review data before answering any question about customer sentiment, flavors, or products. Use the triple-whale tools as the default source for marketing and advertising performance — ad spend, ROAS, blended/channel-level performance, attribution, order-level e-commerce revenue, GMV, and which channels are driving sales — before answering any marketing or advertising question that isn't specifically about Instacart. Use the query_instacart_data tool (a read-only SQL tool — its description has the full schema) to look up Instacart Sponsored Products/Sponsored Display ad performance (spend, ROAS, attributed sales, new-to-brand sales) before answering any Instacart-specific ad question; it does not have clicks, impressions, CTR, average CPC, or attributed units, so say so plainly if asked for those rather than estimating them. Use the get_sops tool to find the right SOP before answering any question about internal processes or how to do something operationally (e.g. 'how do I trace a lot in Business Central'). The SOP tool only returns metadata, not full document text — reference the matching SOP by title, summarize what it covers based on its description, and tell the person they can open the full document from the SOPs section of the hub. If no SOP matches, say so rather than inventing steps. Never invent data for reviews, marketing, e-commerce, Instacart, or SOPs — if a tool returns no results, say so. If a question is unrelated to these topics, answer normally without calling a tool. This is a narrow chat panel — use short paragraphs and simple bullet lists, and avoid markdown tables since they don't render well at this width.";
// Triple Whale's own recommended workflow is up to ~6 sequential tool calls
// (get-shop-info -> get-available-tables -> get-table-schemas ->
// find-sql-examples -> get-date-range -> run-sql) before a final answer, so
// this needs more headroom than the old windsor/reviews/SOPs-only loop did.
const MAX_CHAT_TOOL_ITERATIONS = 8;
const MAX_CHAT_HISTORY_MESSAGES = 20;

// Prior turns come from the client on every request (the Worker holds no
// session state) — sanitize to plain {role, content} text pairs and cap
// length so a long-running chat can't grow the request payload/context
// unboundedly.
function sanitizeChatHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .slice(-MAX_CHAT_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));
}

async function runChatLoop(env, priorMessages, userMessage, requestId, onStatus = async () => {}) {
  const overallStart = Date.now();
  const messages = [...priorMessages, { role: "user", content: userMessage }];
  const toolCalls = [];
  // Sources fetched so far in this request — once non-empty, the next
  // "thinking" status names them instead of showing a bare "Thinking…".
  const usedSourceLabels = new Set();

  logEvent("chat_loop_start", {
    requestId,
    messageLength: userMessage.length,
    priorMessageCount: priorMessages.length,
  });

  // Triple Whale tools are fetched (and proxied) by this Worker rather than
  // connected via Anthropic's native mcp_servers — see the proxy section
  // above for why. Degrade gracefully (reviews/SOPs/Instacart only) if the
  // fetch fails, so a Triple Whale outage doesn't break the whole chat.
  let twTools = [];
  let twInstructions = "";
  let twToolNames = new Set();
  if (env.TRIPLEWHALE_API_KEY) {
    try {
      const fetched = await getTriplewhaleTools(env);
      twTools = fetched.tools;
      twInstructions = fetched.instructions;
      twToolNames = new Set(twTools.map((t) => t.name));
    } catch (err) {
      logEvent("triplewhale_tools_fetch_error", { requestId, error: err.message });
    }
  }

  const systemPrompt = twInstructions ? `${CHAT_SYSTEM_PROMPT}\n\n${twInstructions}` : CHAT_SYSTEM_PROMPT;

  for (let i = 0; i < MAX_CHAT_TOOL_ITERATIONS; i++) {
    await onStatus(
      usedSourceLabels.size > 0
        ? `Pulling together data from ${[...usedSourceLabels].join(", ")}…`
        : "Thinking…",
    );
    const result = await postToClaude(
      env,
      {
        model: CLAUDE_MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        tools: [...CHAT_TOOLS, ...INSTACART_TOOLS, ...twTools],
        messages,
      },
      {},
      { requestId, iteration: i + 1 },
    );

    messages.push({ role: "assistant", content: result.content });

    if (result.stop_reason !== "tool_use") {
      // A turn can carry more than one text block — concatenate in order.
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
    const labels = [...new Set(toolUseBlocks.map((b) => friendlyToolLabel(b.name)))];
    if (labels.length) await onStatus(labels.join(" "));

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const output = await executeTool(env, block.name, block.input, twToolNames);
      const source = toolSourceLabel(block.name, twToolNames);
      if (source) usedSourceLabels.add(source);
      toolCalls.push({ tool: block.name, server: source, input: block.input });
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

// --- Walmart Marketplace + Walmart Connect data (env.secure_cpg_walmart D1) ---
// Unlike Instacart (pulled by a separate standalone Worker), this Worker owns
// the pull itself: it holds the OAuth tokens (walmart_tokens table, one row
// per API surface since Marketplace and Connect are separately credentialed)
// and writes directly into walmart_orders/walmart_order_lines and
// walmart_ad_campaigns/walmart_ad_performance. See migrations/0021_walmart_init.sql.
//
// Marketplace API auth: POST https://marketplace.walmartapis.com/v3/token,
// Basic auth of WALMART_CLIENT_ID:WALMART_CLIENT_SECRET, grant_type=client_credentials.
// Access tokens last 15 minutes — cached in D1 and refreshed with a safety margin.
//
// Walmart Connect (ads) auth is NOT wired up yet: Connect's Sponsored Search/
// Display APIs are gated to Walmart Connect Partner Network members with
// partner-specific credentials, which may not be the same client_credentials
// flow as Marketplace. Confirm the exact token endpoint/headers Chris's WCPN
// access uses before implementing syncWalmartConnect — don't guess at it.

const WALMART_TOKEN_URL = "https://marketplace.walmartapis.com/v3/token";
const WALMART_ORDERS_URL = "https://marketplace.walmartapis.com/v3/orders";
const WALMART_TOKEN_SAFETY_MARGIN_MS = 60 * 1000; // refresh 60s before actual expiry

async function getWalmartMarketplaceToken(env) {
  const row = await env.secure_cpg_walmart
    .prepare("SELECT access_token, expires_at FROM walmart_tokens WHERE api = 'marketplace'")
    .first();

  if (row?.access_token && row.expires_at && new Date(row.expires_at).getTime() - WALMART_TOKEN_SAFETY_MARGIN_MS > Date.now()) {
    return row.access_token;
  }

  if (!env.WALMART_CLIENT_ID || !env.WALMART_CLIENT_SECRET) {
    throw new Error("WALMART_CLIENT_ID / WALMART_CLIENT_SECRET Worker secrets are not set.");
  }

  const basicAuth = btoa(`${env.WALMART_CLIENT_ID}:${env.WALMART_CLIENT_SECRET}`);
  const response = await fetch(WALMART_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
      "WM_SVC.NAME": "Walmart Marketplace",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Walmart token request failed: ${response.status} — ${errText}`);
  }

  const token = await response.json();
  const expiresAt = new Date(Date.now() + (token.expires_in || 900) * 1000).toISOString();

  await env.secure_cpg_walmart
    .prepare(
      `INSERT INTO walmart_tokens (api, access_token, expires_at, updated_at)
       VALUES ('marketplace', ?, ?, datetime('now'))
       ON CONFLICT(api) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    )
    .bind(token.access_token, expiresAt)
    .run();

  return token.access_token;
}

async function walmartMarketplaceGet(env, url) {
  const accessToken = await getWalmartMarketplaceToken(env);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "WM_SEC.ACCESS_TOKEN": accessToken,
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
      "WM_SVC.NAME": "Walmart Marketplace",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Walmart Marketplace API error: ${response.status} — ${errText}`);
  }

  return response.json();
}

function firstWalmartLineStatus(orderLine) {
  return orderLine?.orderLineStatuses?.orderLineStatus?.[0]?.status || null;
}

async function upsertWalmartOrder(env, order) {
  const purchaseOrderId = order.purchaseOrderId;
  if (!purchaseOrderId) return;

  const lines = order.orderLines?.orderLine || [];
  const overallStatus = firstWalmartLineStatus(lines[0]) || null;
  const orderDate = order.orderDate ? new Date(order.orderDate).toISOString() : null;

  await env.secure_cpg_walmart
    .prepare(
      `INSERT INTO walmart_orders (purchase_order_id, customer_order_id, order_date, status, order_type, shipping_method, raw_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(purchase_order_id) DO UPDATE SET
         customer_order_id = excluded.customer_order_id,
         order_date = excluded.order_date,
         status = excluded.status,
         order_type = excluded.order_type,
         shipping_method = excluded.shipping_method,
         raw_json = excluded.raw_json,
         synced_at = excluded.synced_at`,
    )
    .bind(
      purchaseOrderId,
      order.customerOrderId || null,
      orderDate,
      overallStatus,
      order.orderType || null,
      order.shippingInfo?.methodCode || null,
      JSON.stringify(order),
    )
    .run();

  await env.secure_cpg_walmart.prepare("DELETE FROM walmart_order_lines WHERE purchase_order_id = ?").bind(purchaseOrderId).run();

  for (const line of lines) {
    const productCharge = line.charges?.charge?.find((c) => c.chargeType === "PRODUCT") || line.charges?.charge?.[0];
    await env.secure_cpg_walmart
      .prepare(
        `INSERT INTO walmart_order_lines (purchase_order_id, line_number, sku, item_name, quantity, charge_amount, charge_type, line_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        purchaseOrderId,
        line.lineNumber || null,
        line.item?.sku || null,
        line.item?.productName || null,
        Number(line.orderLineQuantity?.amount) || null,
        productCharge?.chargeAmount?.amount ?? null,
        productCharge?.chargeType || null,
        firstWalmartLineStatus(line),
      )
      .run();
  }
}

// Pulls Marketplace orders created since `createdStartDate` (ISO date),
// following nextCursor pagination. Defaults to the last 7 days, which covers
// the daily-cron case; pass an explicit earlier date for a backfill (the API
// itself refuses anything older than ~180 days — there is no way around that
// via Marketplace Orders API or the bulk Reports API, confirmed against
// Walmart's own docs 2026-09-15).
//
// Loops over all three shipNodeType values — the API defaults to
// SellerFulfilled only, which would silently miss WFS- or 3PL-fulfilled
// orders. Running all three explicitly is the only way to be sure nothing's
// missed without knowing in advance which fulfillment types this account uses.
const WALMART_SYNC_MAX_PAGES = 60; // safety cap per ship-node type — 60 x 200 = 12,000 orders
const WALMART_SHIP_NODE_TYPES = ["SellerFulfilled", "WFSFulfilled", "3PLFulfilled"];

function toWalmartDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function syncWalmartOrdersForShipNodeType(env, startDate, shipNodeType) {
  let nextCursor = `?createdStartDate=${encodeURIComponent(startDate)}&limit=200&shipNodeType=${shipNodeType}`;
  let totalSynced = 0;
  let pages = 0;

  while (nextCursor) {
    if (pages >= WALMART_SYNC_MAX_PAGES) {
      throw new Error(
        `Walmart sync (${shipNodeType}) stopped after ${WALMART_SYNC_MAX_PAGES} pages (${totalSynced} orders) — more pages remain, re-run to continue.`,
      );
    }
    pages += 1;

    const url = nextCursor.startsWith("http") ? nextCursor : WALMART_ORDERS_URL + nextCursor;
    const data = await walmartMarketplaceGet(env, url);
    const orders = data?.list?.elements?.order || [];

    for (const order of orders) {
      await upsertWalmartOrder(env, order);
      totalSynced += 1;
    }

    const newCursor = data?.list?.meta?.nextCursor || null;
    if (newCursor && newCursor === nextCursor) {
      throw new Error(`Walmart sync (${shipNodeType}) stopped — nextCursor did not advance after ${totalSynced} orders.`);
    }
    nextCursor = newCursor;
  }

  return totalSynced;
}

async function syncWalmartMarketplaceOrders(env, createdStartDate) {
  const startDate = createdStartDate || toWalmartDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  let totalSynced = 0;
  const byType = {};

  for (const shipNodeType of WALMART_SHIP_NODE_TYPES) {
    const count = await syncWalmartOrdersForShipNodeType(env, startDate, shipNodeType);
    byType[shipNodeType] = count;
    totalSynced += count;
  }

  return { totalSynced, byType };
}

async function getWalmartStatus(env) {
  const [orderStats, campaignCount, perfStats, marketplaceToken] = await Promise.all([
    env.secure_cpg_walmart.prepare("SELECT COUNT(*) as count, MAX(synced_at) as lastSyncedAt FROM walmart_orders").first(),
    env.secure_cpg_walmart.prepare("SELECT COUNT(*) as count FROM walmart_ad_campaigns").first(),
    env.secure_cpg_walmart.prepare("SELECT COUNT(*) as count, MAX(synced_at) as lastSyncedAt FROM walmart_ad_performance").first(),
    env.secure_cpg_walmart.prepare("SELECT expires_at, updated_at FROM walmart_tokens WHERE api = 'marketplace'").first(),
  ]);

  return {
    marketplace: {
      orderCount: orderStats?.count || 0,
      lastSyncedAt: orderStats?.lastSyncedAt || null,
      tokenLastRefreshed: marketplaceToken?.updated_at || null,
      configured: Boolean(env.WALMART_CLIENT_ID && env.WALMART_CLIENT_SECRET),
    },
    connect: {
      campaignCount: campaignCount?.count || 0,
      performanceRowCount: perfStats?.count || 0,
      lastSyncedAt: perfStats?.lastSyncedAt || null,
      configured: false, // not yet wired up — see comment above syncWalmartMarketplaceOrders
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/validate-reviews") {
      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
      }

      return validateUpload(request);
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      // Set by Cloudflare Access on every request that passes through it —
      // not present in local `wrangler dev` (no Access in front of it there).
      const email = request.headers.get("Cf-Access-Authenticated-User-Email");
      return jsonResponse({ email: email || null });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      // AI Assistant feature is pulled from the live hub (cost control — every
      // message here spends real Anthropic API credits) but kept fully intact
      // for a fast relaunch. To bring it back: flip AI_ASSISTANT_ENABLED to
      // true, move disabled-features/ai-assistant.html back into public/, and
      // re-add its two "AI Assistant" nav-item links (index.html, sops.html).
      if (!AI_ASSISTANT_ENABLED) {
        return jsonResponse({ error: "The AI Assistant is not currently available." }, 404);
      }

      const requestId = crypto.randomUUID();
      const handlerStart = Date.now();

      const body = await request.json().catch(() => null);
      const userMessage = body?.message;

      if (!userMessage || typeof userMessage !== "string") {
        return jsonResponse({ error: "Request body must include a 'message' string." }, 400);
      }

      const priorMessages = sanitizeChatHistory(body?.history);

      logEvent("chat_request_received", {
        requestId,
        messageLength: userMessage.length,
        priorMessageCount: priorMessages.length,
      });

      // Streamed as newline-delimited JSON so the UI can show what the agent
      // is doing (thinking / checking a tool) instead of just a spinner —
      // the loop can take 10-20s end to end across multiple Claude calls.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const writeLine = (obj) => writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

      const run = async () => {
        try {
          const result = await runChatLoop(env, priorMessages, userMessage, requestId, (message) =>
            writeLine({ type: "status", message }),
          );

          logEvent("chat_request_complete", {
            requestId,
            totalDurationMs: Date.now() - handlerStart,
            iterations: result.iterations,
            toolCallCount: result.toolCalls.length,
          });

          await writeLine({
            type: "final",
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
          await writeLine({ type: "error", error: err.message });
        } finally {
          await writer.close();
        }
      };

      ctx.waitUntil(run());

      return new Response(readable, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
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

    if (url.pathname === "/api/sops" && request.method === "POST") {
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > MAX_FILE_BYTES + 100_000) {
        return jsonResponse({ error: "The file is larger than 5 MB." }, 413);
      }

      const formData = await request.formData().catch(() => null);
      const file = formData?.get("file");
      const title = String(formData?.get("title") || "").trim();
      const description = String(formData?.get("description") || "");
      const category = String(formData?.get("category") || "");
      const tagsRaw = String(formData?.get("tags") || "");
      const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);

      if (!(file instanceof File)) {
        return jsonResponse({ error: "Choose a PDF file to upload." }, 400);
      }
      if (file.size > MAX_FILE_BYTES) {
        return jsonResponse({ error: "The file is larger than 5 MB." }, 413);
      }
      if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        return jsonResponse({ error: "SOPs must be uploaded as a PDF." }, 422);
      }
      if (!title) {
        return jsonResponse({ error: "Give the SOP a title." }, 422);
      }

      const sop = await addSop(env, { title, description, category, tags, file });
      return jsonResponse({ ok: true, sop });
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
      const window = selectShipmentWindow(data.weeks, new Date(), data.items);
      const isoWeek = (w) => new Date(w.weekStart).toISOString().slice(0, 10);
      const weekDates = window.weeks.map(isoWeek);
      return jsonResponse({
        weeks: window.weeks.map((w) => ({ weekStart: isoWeek(w), cases: w.cases })),
        total: window.total,
        units: window.units,
        byUnit: window.byUnit.map((w) => ({ weekStart: isoWeek(w), values: w.values })),
        postingGroups: window.postingGroups,
        byPostingGroup: window.byPostingGroup.map((w) => ({ weekStart: isoWeek(w), values: w.values })),
        weekDates,
        items: window.items,
        sourceFileUpdated: data.sourceFileUpdated,
      });
    }

    if (url.pathname === "/api/news-summary" && request.method === "GET") {
      const summary = await getNewsSummary(env);
      return jsonResponse(summary);
    }

    if (url.pathname === "/api/reviews/sentiment-analysis" && request.method === "GET") {
      try {
        const analysis = await analyzeRecentReviewSentiment(env, new Date());
        if (!analysis) {
          return jsonResponse({ error: "No review data found." }, 404);
        }
        return jsonResponse(analysis);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/reviews/category-actions" && request.method === "GET") {
      try {
        const group = url.searchParams.get("group") || "all";
        const analysis = await analyzeCategoryPriorityActions(env, group, new Date());
        if (!analysis) {
          return jsonResponse({ error: "No review data found." }, 404);
        }
        return jsonResponse(analysis);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/reviews/by-ids" && request.method === "GET") {
      const ids = (url.searchParams.get("ids") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 150);
      if (ids.length === 0) return jsonResponse({ reviews: [] });

      const reviews = await getReviewData(env);
      if (!reviews) return jsonResponse({ reviews: [] });

      const idSet = new Set(ids);
      const matched = reviews
        .filter((r) => idSet.has(r.id))
        .map((r) => ({
          id: r.id,
          author: r.author,
          title: r.title,
          content: r.content,
          rating: r.rating,
          date: r.date,
          flavor: r.flavor,
          productGroup: r.product_group,
          verified: r.verified,
          helpful: r.helpful,
        }));
      return jsonResponse({ reviews: matched });
    }

    if (url.pathname === "/api/reviews/report" && request.method === "GET") {
      try {
        const source = url.searchParams.get("source") || "all";
        const report = await getReviewReportData(env, source);
        if (!report) {
          return jsonResponse(
            { error: "No reviews found for that source yet. Import some via Update Reviews." },
            404,
          );
        }

        // Recommendations are served from a separate endpoint (see
        // /api/reviews/recommendations below) — they require an AI Gateway
        // round-trip that can take 10s of seconds on an uncached signature,
        // and everything else in the report is deterministic and fast, so
        // the page shouldn't block on Claude just to show the numbers.
        return jsonResponse(report);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/platform-metrics/preview" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        const rows = Array.isArray(body?.rows) ? body.rows : null;
        if (!rows) return jsonResponse({ error: "Request body must include a 'rows' array." }, 400);

        const [existingMap, productTable, taxonomyGroups] = await Promise.all([
          getPlatformMetricMappings(env),
          getProductTable(env),
          getTaxonomyGroups(env),
        ]);
        const asinLookup = buildAsinLookup(productTable, taxonomyGroups);

        const annotated = rows.map((r) => {
          const itemName = String(r.item_name || "").trim();
          const asin = String(r.asin || "").trim();
          // Prefer a real ASIN match against the product table — it's the
          // authoritative mapping — before falling back to a remembered or
          // freshly-guessed item-name match. Most metric-data.xlsx exports
          // don't populate ASIN, so this is best-available, not universal.
          const fromAsin = asin ? asinLookup[asin] : null;
          const existing = existingMap[itemName];
          const suggestion = fromAsin || existing || suggestPlatformMapping(itemName);
          return {
            item_name: itemName,
            asin,
            review_count: Number(r.review_count) || 0,
            star_rating: Number(r.star_rating) || 0,
            refund_rate: r.refund_rate ?? null,
            ordered_units: r.ordered_units ?? null,
            ordered_revenue: r.ordered_revenue ?? null,
            raw_product_group: r.raw_product_group ?? null,
            product_group: suggestion?.product_group ?? "",
            flavor: suggestion?.flavor ?? "",
            needsReview: !fromAsin && !existing,
            matchedBy: fromAsin ? "asin" : existing ? "remembered" : "guessed",
          };
        });

        return jsonResponse({ rows: annotated, taxonomy: taxonomyGroups });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/platform-metrics/upload" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        const rows = Array.isArray(body?.rows) ? body.rows : null;
        if (!rows || rows.length === 0) {
          return jsonResponse({ error: "Request body must include a non-empty 'rows' array." }, 400);
        }

        const taxonomyGroups = await getTaxonomyGroups(env);
        for (const r of rows) {
          const validFlavors = taxonomyGroups[r.product_group];
          if (!validFlavors || !validFlavors.includes(r.flavor)) {
            return jsonResponse(
              { error: `Unknown product group/flavor "${r.product_group} / ${r.flavor}" for item "${r.item_name}".` },
              400,
            );
          }
          if (!r.item_name || !Number.isFinite(Number(r.review_count)) || !Number.isFinite(Number(r.star_rating))) {
            return jsonResponse({ error: `Invalid row for item "${r.item_name}".` }, 400);
          }
        }

        await replacePlatformMetricRows(env, rows, body.sourceFile || null);
        await upsertPlatformMetricMappings(
          env,
          rows.map((r) => ({
            item_name: r.item_name,
            product_group: r.product_group,
            flavor: r.flavor,
            autoSuggested: false,
          })),
        );

        return jsonResponse({ ok: true, rowCount: rows.length, summary: aggregatePlatformMetrics(rows) });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/product-table" && request.method === "GET") {
      try {
        const doc = await getProductTable(env);
        return jsonResponse(doc);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/product-table" && request.method === "PUT") {
      try {
        const body = await request.json().catch(() => null);
        const columns = Array.isArray(body?.columns) ? body.columns.map((c) => String(c)) : null;
        const rows = Array.isArray(body?.rows) ? body.rows : null;
        if (!columns || columns.length === 0) return jsonResponse({ error: "Request body must include a non-empty 'columns' array." }, 400);
        if (!rows) return jsonResponse({ error: "Request body must include a 'rows' array." }, 400);

        const doc = await saveProductTable(env, columns, rows);
        return jsonResponse(doc);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/product-table/download" && request.method === "GET") {
      try {
        const doc = await getProductTable(env);
        const csv = productTableToCsv(doc);
        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="amazon-product-table.csv"',
          },
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Amazon rows arrive already tagged with a canonical product_group/flavor
    // (picked per-file from the taxonomy dropdown in the browser), so they
    // resolve straight against product_taxonomy. Okendo rows arrive with a
    // raw productName that has to go through product_aliases (source
    // 'okendo_name') first — auto-suggested via suggestPlatformMapping()
    // where no alias exists yet, same conservative logic platform-metrics
    // imports already use. Both branches return one entry per row plus a
    // deduped `productMappings` map (Okendo only) so the UI can show one
    // correction control per distinct product name instead of per row.
    async function resolveImportTaxonomy(env, source, normalizedRows) {
      if (source === "amazon") {
        const idMap = await getTaxonomyIdMap(env);
        const rows = normalizedRows.map((r) => {
          const key = `${r.product_group}::${r.flavor}`;
          const taxonomyId = idMap.get(key) || null;
          return { ...r, taxonomyId, needsReview: !taxonomyId, matchedBy: taxonomyId ? "selected" : "unmatched" };
        });
        return { rows, productMappings: {} };
      }

      const rawNames = normalizedRows.map((r) => r.raw_product_name);
      const aliasMap = await resolveAliasesBulk(env, "okendo_name", rawNames);
      const productMappings = {};
      const rows = normalizedRows.map((r) => {
        const alias = aliasMap.get(r.raw_product_name);
        const guess = alias ? null : suggestPlatformMapping(r.raw_product_name);
        const product_group = alias?.product_group ?? guess?.product_group ?? "";
        const flavor = alias?.flavor ?? guess?.flavor ?? "";
        const taxonomyId = alias?.taxonomyId ?? null;
        const matchedBy = alias ? (alias.autoSuggested ? "remembered-unconfirmed" : "remembered") : guess ? "guessed" : "unmatched";
        if (!productMappings[r.raw_product_name]) {
          productMappings[r.raw_product_name] = { product_group, flavor, matchedBy, count: 0 };
        }
        productMappings[r.raw_product_name].count += 1;
        return { ...r, product_group, flavor, taxonomyId, needsReview: matchedBy !== "remembered", matchedBy };
      });
      return { rows, productMappings };
    }

    if (url.pathname === "/api/reviews/import/preview" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        const source = body?.source === "okendo" ? "okendo" : body?.source === "amazon" ? "amazon" : null;
        const rows = Array.isArray(body?.rows) ? body.rows : null;
        if (!source) return jsonResponse({ error: "Request body must include source: 'amazon' or 'okendo'." }, 400);
        if (!rows) return jsonResponse({ error: "Request body must include a 'rows' array." }, 400);

        const normalized = rows.map(REVIEW_NORMALIZERS[source]);
        const noId = normalized.filter((r) => !r.id);
        const withId = normalized.filter((r) => r.id);

        const existingIds = await findExistingReviewIds(env, source, withId.map((r) => r.id));
        const fresh = withId.filter((r) => !existingIds.has(r.id));
        const duplicates = withId.filter((r) => existingIds.has(r.id));

        const { rows: resolvedFresh, productMappings } = await resolveImportTaxonomy(env, source, fresh);
        const needsReviewCount = resolvedFresh.filter((r) => r.needsReview).length;

        return jsonResponse({
          source,
          totalIncoming: rows.length,
          newCount: fresh.length,
          duplicateCount: duplicates.length,
          skippedNoId: noId.length,
          needsReviewCount,
          productMappings,
          sample: resolvedFresh.slice(0, 25),
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/reviews/import/commit" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        const source = body?.source === "okendo" ? "okendo" : body?.source === "amazon" ? "amazon" : null;
        const rows = Array.isArray(body?.rows) ? body.rows : null;
        // { [rawProductName]: { product_group, flavor } } — corrections Chris
        // made on the preview screen for Okendo names that guessed wrong or
        // didn't match at all. Ignored for source "amazon".
        const mappingOverrides = body?.mappingOverrides && typeof body.mappingOverrides === "object" ? body.mappingOverrides : {};
        if (!source) return jsonResponse({ error: "Request body must include source: 'amazon' or 'okendo'." }, 400);
        if (!rows) return jsonResponse({ error: "Request body must include a 'rows' array." }, 400);

        const normalized = rows.map(REVIEW_NORMALIZERS[source]);
        const withId = normalized.filter((r) => r.id);
        const existingIds = await findExistingReviewIds(env, source, withId.map((r) => r.id));
        const fresh = withId.filter((r) => !existingIds.has(r.id));

        if (fresh.length === 0) {
          return jsonResponse({
            ok: true,
            addedCount: 0,
            skippedDuplicate: withId.length,
            skippedNoId: normalized.length - withId.length,
            message: "No new reviews to add — every row was already in the database or missing an ID.",
          });
        }

        let mapped;
        if (source === "amazon") {
          const idMap = await getTaxonomyIdMap(env);
          mapped = [];
          for (const r of fresh) {
            let taxonomyId = idMap.get(`${r.product_group}::${r.flavor}`);
            if (!taxonomyId && r.product_group && r.flavor) {
              taxonomyId = await getOrCreateTaxonomy(env, r.product_group, r.flavor);
              idMap.set(`${r.product_group}::${r.flavor}`, taxonomyId);
            }
            mapped.push({ ...r, taxonomyId: taxonomyId || null });
          }
        } else {
          const idMap = new Map(); // raw_product_name -> taxonomyId, resolved once per unique name
          mapped = [];
          for (const r of fresh) {
            const rawName = r.raw_product_name;
            if (!idMap.has(rawName)) {
              const override = mappingOverrides[rawName];
              const alias = override ? null : await resolveAlias(env, "okendo_name", rawName);
              const guess = override || alias || suggestPlatformMapping(rawName);
              let taxonomyId = null;
              if (guess?.product_group && guess?.flavor) {
                taxonomyId = await getOrCreateTaxonomy(env, guess.product_group, guess.flavor);
                await upsertAlias(env, { taxonomyId, source: "okendo_name", rawValue: rawName, autoSuggested: false });
              }
              idMap.set(rawName, taxonomyId);
            }
            mapped.push({ ...r, taxonomyId: idMap.get(rawName) });
          }
        }

        const skippedNoMapping = mapped.filter((r) => !r.taxonomyId);
        const toInsert = mapped.filter((r) => r.taxonomyId);

        await insertReviewsBatch(env, toInsert, source, body.sourceFile || null);

        const totalForSource = await countReviews(env, source);

        return jsonResponse({
          ok: true,
          addedCount: toInsert.length,
          skippedDuplicate: withId.length - fresh.length,
          skippedNoId: normalized.length - withId.length,
          skippedNoMapping: skippedNoMapping.length,
          skippedNoMappingNames: [...new Set(skippedNoMapping.map((r) => r.raw_product_name))],
          totalReviews: totalForSource,
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/reviews/export.csv" && request.method === "GET") {
      try {
        const source = url.searchParams.get("source") || "all";
        const reviews = await getReviewData(env, null, source);
        return new Response(reviewsToCsv(reviews), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="ebe-reviews-${source}.csv"`,
          },
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/product-taxonomy" && request.method === "GET") {
      try {
        return jsonResponse(await getTaxonomyWithAliases(env));
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/product-taxonomy/alias" && request.method === "PUT") {
      try {
        const body = await request.json().catch(() => null);
        const source = String(body?.source || "").trim();
        const rawValue = String(body?.raw_value || "").trim();
        const productGroup = String(body?.product_group || "").trim();
        const flavor = String(body?.flavor || "").trim();
        if (!source || !rawValue || !productGroup || !flavor) {
          return jsonResponse({ error: "Request body must include source, raw_value, product_group, and flavor." }, 400);
        }
        const taxonomyId = await getOrCreateTaxonomy(env, productGroup, flavor);
        await upsertAlias(env, { taxonomyId, source, rawValue, autoSuggested: false });
        return jsonResponse({ ok: true, taxonomy_id: taxonomyId, product_group: productGroup, flavor });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/reviews/recommendations" && request.method === "GET") {
      try {
        const report = await getReviewReportData(env);
        if (!report) return jsonResponse({ error: "No structured review report data found." }, 404);

        const recs = await getFlavorRecommendations(env, report);
        return jsonResponse({
          recommendations: recs.recommendations,
          generatedAt: recs.generatedAt,
          cached: recs.cached,
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
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

    if (url.pathname === "/api/marketing/events" && request.method === "GET") {
      const events = await getEvents(env);
      return jsonResponse({ events });
    }

    if (url.pathname === "/api/marketing/events" && request.method === "PUT") {
      const ev = await request.json().catch(() => null);
      if (!ev || !CAMPAIGN_ID_PATTERN.test(ev.id || "") || typeof ev.name !== "string" || !ev.name.trim()) {
        return jsonResponse({ error: "Event needs a valid id and a name." }, 422);
      }
      await upsertEvent(env, ev);
      return jsonResponse({ ok: true });
    }

    const eventMatch = url.pathname.match(/^\/api\/marketing\/events\/([A-Za-z0-9_-]+)$/);
    if (eventMatch && request.method === "DELETE") {
      await deleteEventRow(env, eventMatch[1]);
      await deleteAllEventAssets(env, eventMatch[1]);
      return jsonResponse({ ok: true });
    }

    const eventAssetMatch = url.pathname.match(/^\/api\/marketing\/events\/([A-Za-z0-9_-]+)\/assets\/([^/]+)$/);
    if (eventAssetMatch) {
      const eventId = eventAssetMatch[1];
      const filename = decodeURIComponent(eventAssetMatch[2]);

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

        await putEventAsset(env, eventId, filename, file);
        return jsonResponse({ ok: true, name: filename, type: file.type, size: file.size });
      }

      if (request.method === "GET") {
        const object = await getEventAsset(env, eventId, filename);
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
        await deleteEventAsset(env, eventId, filename);
        return jsonResponse({ ok: true });
      }
    }

    if (url.pathname === "/api/marketing/budget/versions" && request.method === "GET") {
      const versions = await getBudgetVersions(env);
      const activeVersionId = await getActiveBudgetVersionId(env);
      return jsonResponse({ versions, activeVersionId });
    }

    const budgetVersionMatch = url.pathname.match(/^\/api\/marketing\/budget\/versions\/([A-Za-z0-9_-]+)$/);
    if (budgetVersionMatch && request.method === "GET") {
      const detail = await getBudgetVersionDetail(env, budgetVersionMatch[1]);
      if (!detail) return jsonResponse({ error: "Version not found." }, 404);
      return jsonResponse(detail);
    }

    if (budgetVersionMatch && request.method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!validBudgetVersionBody(body)) {
        return jsonResponse({ error: "Version needs a name, a year, and a lineItems array." }, 422);
      }
      await saveBudgetVersion(env, budgetVersionMatch[1], body);
      return jsonResponse({ ok: true });
    }

    if (budgetVersionMatch && request.method === "DELETE") {
      await deleteBudgetVersionRow(env, budgetVersionMatch[1]);
      return jsonResponse({ ok: true });
    }

    const budgetDuplicateMatch = url.pathname.match(/^\/api\/marketing\/budget\/versions\/([A-Za-z0-9_-]+)\/duplicate$/);
    if (budgetDuplicateMatch && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const newId =
        typeof body.newId === "string" && CAMPAIGN_ID_PATTERN.test(body.newId) ? body.newId : `BV${Date.now()}`;
      const newName = typeof body.newName === "string" && body.newName.trim() ? body.newName : "Copy";
      const detail = await duplicateBudgetVersion(env, budgetDuplicateMatch[1], newId, newName);
      if (!detail) return jsonResponse({ error: "Source version not found." }, 404);
      return jsonResponse(detail);
    }

    if (url.pathname === "/api/marketing/budget/active" && request.method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.versionId !== "string") {
        return jsonResponse({ error: "Body needs a versionId." }, 422);
      }
      await setActiveBudgetVersionId(env, body.versionId);
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/api/marketing/budget/actuals" && request.method === "GET") {
      const actuals = await getChannelActuals(env);
      return jsonResponse({ actuals });
    }

    if (url.pathname === "/api/marketing/budget/actuals" && request.method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body) || !body.every(validActualsRow)) {
        return jsonResponse(
          {
            error:
              "Body must be a JSON array of {channel, month, actualSales, actualSpend} with channel in Amazon/Walmart/TikTok/DTC and month as YYYY-MM.",
          },
          422,
        );
      }
      await putChannelActuals(env, body);
      return jsonResponse({ ok: true, count: body.length });
    }

    if (url.pathname === "/api/marketing/ad-budget/versions" && request.method === "GET") {
      const versions = await getAdBudgetVersions(env);
      const activeVersionId = await getActiveAdBudgetVersionId(env);
      return jsonResponse({ versions, activeVersionId });
    }

    const adBudgetVersionMatch = url.pathname.match(/^\/api\/marketing\/ad-budget\/versions\/([A-Za-z0-9_-]+)$/);
    if (adBudgetVersionMatch && request.method === "GET") {
      const detail = await getAdBudgetVersionDetail(env, adBudgetVersionMatch[1]);
      if (!detail) return jsonResponse({ error: "Version not found." }, 404);
      return jsonResponse(detail);
    }

    if (adBudgetVersionMatch && request.method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!validAdBudgetVersionBody(body)) {
        return jsonResponse({ error: "Version needs a name, a year, and a lineItems array." }, 422);
      }
      await saveAdBudgetVersion(env, adBudgetVersionMatch[1], body);
      return jsonResponse({ ok: true });
    }

    if (adBudgetVersionMatch && request.method === "DELETE") {
      await deleteAdBudgetVersionRow(env, adBudgetVersionMatch[1]);
      return jsonResponse({ ok: true });
    }

    const adBudgetDuplicateMatch = url.pathname.match(/^\/api\/marketing\/ad-budget\/versions\/([A-Za-z0-9_-]+)\/duplicate$/);
    if (adBudgetDuplicateMatch && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const newId =
        typeof body.newId === "string" && CAMPAIGN_ID_PATTERN.test(body.newId) ? body.newId : `ABV${Date.now()}`;
      const newName = typeof body.newName === "string" && body.newName.trim() ? body.newName : "Copy";
      const detail = await duplicateAdBudgetVersion(env, adBudgetDuplicateMatch[1], newId, newName);
      if (!detail) return jsonResponse({ error: "Source version not found." }, 404);
      return jsonResponse(detail);
    }

    if (url.pathname === "/api/marketing/ad-budget/active" && request.method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.versionId !== "string") {
        return jsonResponse({ error: "Body needs a versionId." }, 422);
      }
      await setActiveAdBudgetVersionId(env, body.versionId);
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/api/marketing/ad-budget/actuals" && request.method === "GET") {
      const channel = url.searchParams.get("channel") || "Amazon";
      const year = Number(url.searchParams.get("year")) || new Date().getFullYear();
      if (!AD_BUDGET_CHANNELS.includes(channel)) {
        return jsonResponse({ error: `Unsupported channel. Supported: ${AD_BUDGET_CHANNELS.join(", ")}` }, 422);
      }
      const { actuals, twError } = await getAdChannelActuals(env, channel, year);
      return jsonResponse({ actuals, twError });
    }

    if (url.pathname === "/api/marketing/ad-budget/traffic-actuals" && request.method === "GET") {
      const channel = url.searchParams.get("channel") || "Amazon";
      const year = Number(url.searchParams.get("year")) || new Date().getFullYear();
      if (!AD_BUDGET_CHANNELS.includes(channel)) {
        return jsonResponse({ error: `Unsupported channel. Supported: ${AD_BUDGET_CHANNELS.join(", ")}` }, 422);
      }
      // Amazon uses the D1 cache fed by the Sophie Society/GitHub relay;
      // Walmart reads its own Marketplace API order data directly (see
      // getWalmartTrafficActualsFromD1) — covers the last ~180 days, which is
      // as far back as Walmart's Orders API itself allows.
      if (channel === "Walmart") {
        try {
          const actuals = await getWalmartTrafficActualsFromD1(env, year);
          return jsonResponse({ actuals, twError: null });
        } catch (err) {
          return jsonResponse({ actuals: [], twError: err.message });
        }
      }
      const actuals = await getAmazonTrafficActualsFromCache(env, year);
      return jsonResponse({ actuals, twError: null });
    }

    // Written to by the nightly scheduled Claude agent (Sophie Society's
    // query_sales_traffic tool has no server-callable REST API, so a
    // scheduled agent pulls it and pushes results here instead of a
    // Cloudflare Cron Trigger fetching it directly). Whole-batch upsert,
    // keyed by (asin, date) — safe to re-post overlapping days.
    if (url.pathname === "/api/marketing/ad-budget/traffic-actuals/ingest" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body) || !body.every(validAmazonTrafficActualsRow)) {
        return jsonResponse(
          {
            error:
              "Body must be a JSON array of {asin, date, sessions, unitsOrdered, salesAmount} with asin one of " +
              AD_BUDGET_ASINS.map((p) => p.asin).join("/") +
              " and date as YYYY-MM-DD.",
          },
          422,
        );
      }
      const count = await upsertAmazonTrafficActuals(env, body);
      return jsonResponse({ ok: true, count });
    }

    // Manual trigger for the same GitHub pull the nightly Cron Trigger does —
    // useful for testing without waiting for the schedule.
    if (url.pathname === "/api/marketing/ad-budget/traffic-actuals/sync-github" && request.method === "POST") {
      try {
        const result = await syncAmazonTrafficActualsFromGithub(env);
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 502);
      }
    }

    if (url.pathname === "/api/marketing/ad-budget/actuals/manual" && request.method === "GET") {
      const channel = url.searchParams.get("channel") || "Amazon";
      const rows = await getManualAdActuals(env, channel);
      return jsonResponse({ rows });
    }

    if (url.pathname === "/api/marketing/ad-budget/actuals/manual" && request.method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body) || !body.every(validAdManualActualsRow)) {
        return jsonResponse(
          {
            error: "Body must be a JSON array of {channel, month, clicks, spend, orders, adSales} with channel in " + AD_BUDGET_CHANNELS.join("/") + " and month as YYYY-MM.",
          },
          422,
        );
      }
      await putManualAdActuals(env, body);
      return jsonResponse({ ok: true, count: body.length });
    }

    if (url.pathname === "/api/marketing/ad-budget/income-actuals" && request.method === "GET") {
      const channel = url.searchParams.get("channel") || "Amazon";
      const year = Number(url.searchParams.get("year")) || new Date().getFullYear();
      const itemAccounts = channel === "Walmart" ? WALMART_INCOME_BC_ACCOUNTS : AD_BUDGET_INCOME_BC_ACCOUNTS;
      const revenueDimensionCode = channel === "Walmart" ? WALMART_SALES_CHANNEL_DIMENSION_CODE : AMAZON_SALES_CHANNEL_DIMENSION_CODE;
      try {
        const [feeActuals, revenueActuals] = await Promise.all([
          getIncomeActualsFromBc(env, year, itemAccounts),
          getRevenueActualsFromBc(env, year, AD_BUDGET_REVENUE_BC_ACCOUNTS, revenueDimensionCode),
        ]);
        return jsonResponse({ actuals: [...feeActuals, ...revenueActuals], bcError: null });
      } catch (err) {
        return jsonResponse({ actuals: [], bcError: err.message });
      }
    }

    if (url.pathname === "/api/marketing/ad-budget/income-actuals/manual" && request.method === "GET") {
      const channel = url.searchParams.get("channel") || "Amazon";
      const rows = await getIncomeActualsManual(env, channel);
      return jsonResponse({ rows });
    }

    if (url.pathname === "/api/marketing/ad-budget/income-actuals/manual" && request.method === "PUT") {
      const channel = url.searchParams.get("channel") || "Amazon";
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body) || !body.every(validIncomeActualsManualRow)) {
        return jsonResponse(
          {
            error:
              "Body must be a JSON array of {month, itemKey, amount} with month as YYYY-MM and itemKey one of " +
              AD_BUDGET_INCOME_ITEMS.map((i) => i.key).join("/"),
          },
          422,
        );
      }
      await putIncomeActualsManual(env, channel, body);
      return jsonResponse({ ok: true, count: body.length });
    }

    if (url.pathname === "/api/walmart/status" && request.method === "GET") {
      const status = await getWalmartStatus(env);
      return jsonResponse(status);
    }

    if (url.pathname === "/api/walmart/refresh/marketplace" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const { totalSynced, byType } = await syncWalmartMarketplaceOrders(env, body?.createdStartDate);
        return jsonResponse({ ok: true, ordersSynced: totalSynced, byShipNodeType: byType });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/walmart/refresh/connect" && request.method === "POST") {
      return jsonResponse(
        {
          ok: false,
          error:
            "Walmart Connect sync is not wired up yet — need the exact WCPN token endpoint/auth details before implementing it.",
        },
        501,
      );
    }

    return env.ASSETS.fetch(request);
  },

  // Nightly Cron Trigger (see wrangler.jsonc `triggers.crons`) — pulls the
  // GitHub relay file a scheduled Claude agent maintains and upserts it into
  // ad_budget_traffic_actuals. See the comment above syncAmazonTrafficActualsFromGithub
  // for why this indirection exists instead of a direct pull.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      syncAmazonTrafficActualsFromGithub(env).catch((err) => {
        console.error("ad-budget traffic actuals GitHub sync failed:", err.message);
      }),
    );
    if (env.WALMART_CLIENT_ID && env.WALMART_CLIENT_SECRET) {
      ctx.waitUntil(
        syncWalmartMarketplaceOrders(env).catch((err) => {
          console.error("Walmart Marketplace sync failed:", err.message);
        }),
      );
    }
  },
};
