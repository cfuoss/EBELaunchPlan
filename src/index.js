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

// --- Claude call via AI Gateway ---
const CLAUDE_MODEL = "claude-sonnet-4-6";

async function postToClaude(env, body) {
  const response = await fetch(env.AI_GATEWAY_URL + "/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${errText}`);
  }

  return response.json();
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
];

async function executeTool(env, name, input) {
  if (name === "get_reviews") {
    return getReviewsForTool(env, input);
  }
  return { error: `Unknown tool: ${name}` };
}

// --- Agentic tool-use loop ---
const CHAT_SYSTEM_PROMPT =
  "You are an assistant for a CPG (consumer packaged goods) company. You help analyze customer review data. Use the get_reviews tool to look up real review data before answering any question about customer sentiment, flavors, or products — never invent review content. If a question is unrelated to the review data, answer normally without calling the tool.";
const MAX_CHAT_TOOL_ITERATIONS = 5;

async function runChatLoop(env, userMessage) {
  const messages = [{ role: "user", content: userMessage }];
  const toolCalls = [];

  for (let i = 0; i < MAX_CHAT_TOOL_ITERATIONS; i++) {
    const result = await postToClaude(env, {
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: CHAT_SYSTEM_PROMPT,
      tools: CHAT_TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: result.content });

    if (result.stop_reason !== "tool_use") {
      const textBlock = result.content.find((b) => b.type === "text");
      return { finalText: textBlock?.text || "", toolCalls, iterations: i + 1 };
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
      try {
        const body = await request.json().catch(() => null);
        const userMessage = body?.message;

        if (!userMessage || typeof userMessage !== "string") {
          return jsonResponse({ error: "Request body must include a 'message' string." }, 400);
        }

        const result = await runChatLoop(env, userMessage);

        return jsonResponse({
          response: result.finalText,
          toolCalls: result.toolCalls,
          iterations: result.iterations,
        });
      } catch (err) {
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

    return env.ASSETS.fetch(request);
  },
};
