import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Redis } from "@upstash/redis";
import { Pool } from "pg";
import "dotenv/config";

/* ── Clients ──────────────────────────────────────────────── */
const app = new Hono();
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL!,
  token: process.env.UPSTASH_REDIS_TOKEN!,
});
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Tried in order: the next one is used if a model errors (e.g. 503) or times out
const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest"];
const GEMINI_ATTEMPT_TIMEOUT_MS = 12_000;

app.use("*", cors({ origin: "*" }));

/* ── Health check ─────────────────────────────────────────── */
app.get("/", (c) => c.json({ status: "ok" }));

/* ── GET /api/config/:storeId ─────────────────────────────── */
app.get("/api/config/:storeId", async (c) => {
  const { storeId } = c.req.param();

  // v2: camelCase shape (old snake_case cache entries are ignored)
  const cacheKey = `config:v2:${storeId}`;

  // 1. Try Redis cache first
  const cached = await redis.get(cacheKey);
  if (cached) return c.json(cached);

  // 2. Query DB — never expose system_prompt
  // Aliases must match the widget's storeConfigSchema (chatbot-widget/src/schemas/config.ts)
  const result = await db.query(`
    SELECT
      name,
      logo_url          AS "logoUrl",
      primary_color     AS "primaryColor",
      secondary_color   AS "secondaryColor",
      bg_color          AS "backgroundColor",
      welcome_message   AS "welcomeMessage",
      subtitle          AS "headerSubtitle",
      position,
      input_placeholder AS "inputPlaceholder",
      powered_by_label  AS "poweredByLabel",
      open_on_init      AS "openOnInit"
    FROM stores
    WHERE id = $1 AND is_active = true
  `, [storeId]);

  if (!result.rows[0]) {
    return c.json({ error: "Store not found" }, 404);
  }

  // Drop empty columns: the widget schema accepts missing fields, not null
  const config = Object.fromEntries(
    Object.entries(result.rows[0]).filter(([, v]) => v !== null)
  );

  // Colors are often saved as "32a852": the widget only accepts "#32a852"
  for (const key of ["primaryColor", "secondaryColor", "backgroundColor"]) {
    const v = config[key];
    if (typeof v === "string" && /^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim())) {
      config[key] = `#${v.trim()}`;
    }
  }

  // 3. Cache for 5 minutes
  await redis.setex(cacheKey, 300, JSON.stringify(config));

  return c.json(config);
});

/* ── POST /api/chat ───────────────────────────────────────── */
app.post("/api/chat", async (c) => {
  const body = await c.req.json();
  const { storeId, messages } = body;

  if (!storeId || !messages) {
    return c.json({ error: "Missing storeId or messages" }, 400);
  }

  // 1. Fetch store (system_prompt stays server-side)
  const result = await db.query(`
    SELECT system_prompt, allowed_domains, is_active
    FROM stores WHERE id = $1
  `, [storeId]);

  const store = result.rows[0];
  if (!store || !store.is_active) {
    return c.json({ error: "Store not found" }, 404);
  }

  // 2. Validate origin
  const origin = c.req.header("origin") || "";

  // No origin header = reject immediately
  if (!origin) {
    return c.json({ error: "Origin not allowed" }, 403);
  }

  const allowed = (store.allowed_domains as string[]) || [];

  // No domains configured = reject (store not set up properly)
  if (allowed.length === 0) {
    return c.json({ error: "No allowed domains configured for this store" }, 403);
  }

  // Check if origin matches
  const originOk = allowed.some((d) => origin.includes(d));
  if (!originOk) {
    return c.json({ error: "Domain not allowed" }, 403);
  }

  // 3. Rate limit via Redis — 20 msgs/min per IP per store
  const ip = c.req.header("x-forwarded-for")?.split(",")[0] || "unknown";
  const rlKey = `rl:${storeId}:${ip}`;
  const hits = await redis.incr(rlKey);
  if (hits === 1) await redis.expire(rlKey, 60);
  if (hits > 20) return c.json({ error: "Rate limit exceeded" }, 429);

  // 4. Sanitize
  const safeMessages = (messages as any[])
    .slice(-10)
    .map((m) => ({
      role: m.role === "user" ? "user" : "model",
      content: String(m.content).slice(0, 2000),
    }));

  // 5. Call Gemini
  // Lite models: full "flash" models were often overloaded (503) or took 40s+.
  // If the first model fails or is slow, try the next one.
  // Per-attempt timeouts add up to < the widget's 30s chat timeout.
  const history = safeMessages.slice(0, -1).map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }],
  }));
  const lastMessage = safeMessages.at(-1)!.content;

  let reply: string | undefined;
  for (const modelName of GEMINI_MODELS) {
    try {
      const model = genai.getGenerativeModel(
        { model: modelName, systemInstruction: store.system_prompt },
        { timeout: GEMINI_ATTEMPT_TIMEOUT_MS }
      );
      const geminiResult = await model.startChat({ history }).sendMessage(lastMessage);
      reply = geminiResult.response.text();
      break;
    } catch (err) {
      console.error(`[chat] ${modelName} failed:`, err instanceof Error ? err.message : err);
    }
  }

  if (reply === undefined) {
    return c.json({ error: "AI service is busy, please try again" }, 503);
  }

  // 6. Log usage
  await db.query(
    "INSERT INTO usage_logs (store_id) VALUES ($1)",
    [storeId]
  );

  return c.json({ reply });
});

/* ── Start ────────────────────────────────────────────────── */
const port = Number(process.env.PORT) || 3000;
serve({
  fetch: app.fetch,
  port: Number(process.env.PORT) || 3000,
  hostname: "0.0.0.0",
});