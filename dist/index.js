"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hono_1 = require("hono");
const cors_1 = require("hono/cors");
const node_server_1 = require("@hono/node-server");
const generative_ai_1 = require("@google/generative-ai");
const redis_1 = require("@upstash/redis");
const pg_1 = require("pg");
require("dotenv/config");
/* ── Clients ──────────────────────────────────────────────── */
const app = new hono_1.Hono();
const db = new pg_1.Pool({ connectionString: process.env.DATABASE_URL });
const redis = new redis_1.Redis({
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
});
const genai = new generative_ai_1.GoogleGenerativeAI(process.env.GEMINI_API_KEY);
app.use("*", (0, cors_1.cors)({ origin: "*" }));
/* ── Health check ─────────────────────────────────────────── */
app.get("/", (c) => c.json({ status: "ok" }));
/* ── GET /api/config/:storeId ─────────────────────────────── */
app.get("/api/config/:storeId", async (c) => {
    const { storeId } = c.req.param();
    // 1. Try Redis cache first
    const cached = await redis.get(`config:${storeId}`);
    if (cached)
        return c.json(cached);
    // 2. Query DB — never expose system_prompt
    const result = await db.query(`
    SELECT
      name, logo_url, primary_color, secondary_color,
      bg_color, welcome_message, subtitle, position,
      input_placeholder, powered_by_label, open_on_init
    FROM stores
    WHERE id = $1 AND is_active = true
  `, [storeId]);
    if (!result.rows[0]) {
        return c.json({ error: "Store not found" }, 404);
    }
    // 3. Cache for 5 minutes
    await redis.setex(`config:${storeId}`, 300, JSON.stringify(result.rows[0]));
    return c.json(result.rows[0]);
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
    const allowed = store.allowed_domains || [];
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
    if (hits === 1)
        await redis.expire(rlKey, 60);
    if (hits > 20)
        return c.json({ error: "Rate limit exceeded" }, 429);
    // 4. Sanitize
    const safeMessages = messages
        .slice(-10)
        .map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: String(m.content).slice(0, 2000),
    }));
    // 5. Call Gemini
    const model = genai.getGenerativeModel({
        model: "gemini-flash-latest",
        systemInstruction: store.system_prompt,
    });
    const chat = model.startChat({
        history: safeMessages.slice(0, -1).map((m) => ({
            role: m.role === "user" ? "user" : "model",
            parts: [{ text: m.content }],
        })),
    });
    const geminiResult = await chat.sendMessage(safeMessages.at(-1).content);
    const reply = geminiResult.response.text();
    // 6. Log usage
    await db.query("INSERT INTO usage_logs (store_id) VALUES ($1)", [storeId]);
    return c.json({ reply });
});
/* ── Start ────────────────────────────────────────────────── */
const port = Number(process.env.PORT) || 3000;
(0, node_server_1.serve)({ fetch: app.fetch, port }, () => {
    console.log(`API running on http://localhost:${port}`);
});
