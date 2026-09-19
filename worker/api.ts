// Shared Sim Simma API logic for Workers and Pages Functions.
// Serves pipeline data from Workers KV and D1.

import { GAME_UNAVAILABLE, isUpcomingGame } from "../src/lib/upcoming";

export interface Env {
  DB: D1Database;
  DATA: KVNamespace;
  DATA_VERSION?: string;
}

interface NewsAdjustmentRow {
  gsis_id: string | null;
  player_name: string | null;
  team: string | null;
  availability_adj: number | null;
  target_share_adj: number | null;
  carry_share_adj: number | null;
  confidence: number | null;
  summary: string | null;
  source_url: string | null;
  created_at: string;
}

const GAME_ID = /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/;
const CACHE_SECONDS = { meta: 60, week: 300, game: 300, weeks: 300 } as const;

/** Handle an /api/* request. Caller must ensure pathname starts with /api/. */
export async function handleApiRequest(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    return await route(url, request, env, ctx);
  } catch (err) {
    console.error("API error", url.pathname, err);
    return json({ error: "Something went wrong loading data. Try again in a moment." }, 500);
  }
}

async function route(
  url: URL,
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const parts = url.pathname.replace(/\/+$/, "").split("/").slice(2); // after "/api"
  const prefix = env.DATA_VERSION || "v1";

  // GET /api/health
  if (parts[0] === "health" && parts.length === 1) {
    return json({ ok: true, time: new Date().toISOString() }, 200, 0);
  }

  // GET /api/meta
  if (parts[0] === "meta" && parts.length === 1) {
    return cached(request, ctx, CACHE_SECONDS.meta, () =>
      kvJson(env, `${prefix}/meta.json`, "No data has been published yet."),
    );
  }

  // GET /api/status  (last pipeline run)
  if (parts[0] === "status" && parts.length === 1) {
    const row = await env.DB.prepare(
      "SELECT run_at, season, week, games, players, injuries, status FROM pipeline_runs ORDER BY id DESC LIMIT 1",
    ).first();
    return json({ lastRun: row ?? null }, 200, 30);
  }

  // GET /api/weeks?season=2026  (weeks that have published games)
  if (parts[0] === "weeks" && parts.length === 1) {
    const season = toInt(url.searchParams.get("season"));
    if (season === null) return json({ error: "Add ?season=YYYY to the request." }, 400);
    return cached(request, ctx, CACHE_SECONDS.weeks, async () => {
      const { results } = await env.DB.prepare(
        "SELECT week, COUNT(*) AS games FROM games WHERE season = ?1 GROUP BY week ORDER BY week",
      )
        .bind(season)
        .all<{ week: number; games: number }>();
      return json({ season, weeks: results ?? [] });
    });
  }

  // GET /api/weeks/:season/:week
  if (parts[0] === "weeks" && parts.length === 3) {
    const season = toInt(parts[1]);
    const week = toInt(parts[2]);
    if (season === null || week === null || week < 1 || week > 23) {
      return json({ error: "Season and week must be numbers, like /api/weeks/2026/2." }, 400);
    }
    return cached(request, ctx, CACHE_SECONDS.week, async () => {
      const raw = await env.DATA.get(`${prefix}/weeks/${season}/${week}.json`);
      if (raw == null) return json({ error: `No games published for ${season} week ${week}.` }, 404);
      const idx = JSON.parse(raw) as { games?: KickoffRow[] } & Record<string, unknown>;
      const games = (idx.games ?? []).filter((g) => isUpcomingGame(g));
      return json({ ...idx, games });
    });
  }

  // GET /api/games/:gameId
  if (parts[0] === "games" && parts.length === 2) {
    const gameId = decodeURIComponent(parts[1]);
    if (!GAME_ID.test(gameId)) return json({ error: "Game IDs look like 2026_02_DET_BUF." }, 400);

    return cached(request, ctx, CACHE_SECONDS.game, async () => {
      const raw = await env.DATA.get(`${prefix}/games/${gameId}.json`);
      if (raw == null) return json({ error: `Game ${gameId} has not been published.` }, 404);
      const game = JSON.parse(raw) as KickoffRow & Record<string, unknown>;
      if (!isUpcomingGame(game)) return json({ error: GAME_UNAVAILABLE }, 410);

      const [season, week, away, home] = gameId.split("_");
      const adjustments = await loadAdjustments(env, Number(season), Number(week), [away, home]);
      return json({ ...game, adjustments });
    });
  }

  return json({ error: `No API route for ${url.pathname}` }, 404);
}

async function loadAdjustments(
  env: Env,
  season: number,
  week: number,
  teams: string[],
): Promise<NewsAdjustmentRow[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT gsis_id, player_name, team, availability_adj, target_share_adj, carry_share_adj,
              confidence, summary, source_url, created_at
         FROM news_adjustments
        WHERE season = ?1 AND week = ?2 AND team IN (?3, ?4)
        ORDER BY created_at DESC
        LIMIT 100`,
    )
      .bind(season, week, teams[0], teams[1])
      .all<NewsAdjustmentRow>();
    return results ?? [];
  } catch (err) {
    // The game file is still useful without adjustments (for example before migrations run).
    console.warn("news_adjustments unavailable", err);
    return [];
  }
}

async function kvJson(env: Env, key: string, missingMessage: string): Promise<Response> {
  const body = await env.DATA.get(key);
  if (body == null) return json({ error: missingMessage }, 404);
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

/** Edge-cache GET responses for a short time so repeat visitors skip KV/D1. */
async function cached(
  request: Request,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  seconds: number,
  produce: () => Promise<Response>,
): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return request.method === "HEAD" ? new Response(null, hit) : hit;

  const res = await produce();
  if (res.status !== 200) return res;

  const out = new Response(res.body, res);
  out.headers.set("cache-control", `public, max-age=${seconds}`);
  ctx.waitUntil(cache.put(key, out.clone()));
  return request.method === "HEAD" ? new Response(null, out) : out;
}

function json(body: unknown, status = 200, maxAge = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
      ...corsHeaders(),
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
  };
}

interface KickoffRow {
  gameday?: string | null;
  gametime?: string | null;
  played?: boolean;
}

function toInt(v: string | null | undefined): number | null {
  if (v == null || !/^\d+$/.test(v)) return null;
  return Number(v);
}
