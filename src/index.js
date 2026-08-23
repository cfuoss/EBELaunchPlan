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
    "SELECT r.*, t.product_group as product_group, t.flavor as flavor FROM reviews r " +
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

function monthBounds(referenceDate) {
  const y = referenceDate.getUTCFullYear();
  const m = referenceDate.getUTCMonth();
  const toStr = (d) => d.toISOString().slice(0, 10);
  return { start: toStr(new Date(Date.UTC(y, m, 1))), end: toStr(new Date(Date.UTC(y, m + 1, 0))) };
}

function overlapsRange(itemStart, itemEnd, rangeStart, rangeEnd) {
  if (!itemStart || !itemEnd) return false;
  return itemStart <= rangeEnd && itemEnd >= rangeStart;
}

// Promotions/campaigns come from the same "marketing" D1 used by
// ebe-promo-calendar.html (getPromotions/getCampaigns below) — this just
// filters that live list down to whatever overlaps the current calendar
// month, so the home page never needs its own copy of the data.
async function getThisMonthMarketing(env, referenceDate) {
  const { start: monthStart, end: monthEnd } = monthBounds(referenceDate);
  const [promotions, campaigns] = await Promise.all([getPromotions(env), getCampaigns(env)]);

  const activePromotions = promotions
    .filter((p) => overlapsRange(p.start, p.end, monthStart, monthEnd))
    .sort((a, b) => a.start.localeCompare(b.start));

  const activeCampaigns = campaigns
    .filter((c) => overlapsRange(c.start, c.end, monthStart, monthEnd))
    .sort((a, b) => (a.start || "").localeCompare(b.start || ""));

  return { monthStart, monthEnd, promotions: activePromotions, campaigns: activeCampaigns };
}

async function getNewsSummary(env, referenceDate = new Date()) {
  const [reviews, latestSop, issues, shipments, amazonUpdated, okendoUpdated, instacartUpdated, bcUpdated, thisMonthMarketing] = await Promise.all([
    getReviewData(env),
    getLatestSop(env),
    getIssuesOpportunities(env, referenceDate),
    getShipmentWeeks(env),
    getReviewSourceFreshness(env, "amazon"),
    getReviewSourceFreshness(env, "okendo"),
    getInstacartLastSynced(env),
    getBcLastSynced(env),
    getThisMonthMarketing(env, referenceDate),
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
    thisMonthMarketing,
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

    if (url.pathname === "/api/me" && request.method === "GET") {
      // Set by Cloudflare Access on every request that passes through it —
      // not present in local `wrangler dev` (no Access in front of it there).
      const email = request.headers.get("Cf-Access-Authenticated-User-Email");
      return jsonResponse({ email: email || null });
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

    return env.ASSETS.fetch(request);
  },
};
