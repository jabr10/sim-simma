// Client for the Worker API (worker/index.ts).
import type { GameData, PlayerOverride } from "../sim/types";

export interface Meta {
  data_version: string;
  season: number;
  week: number;
  generated_at: string;
  games: number;
  players: number;
}

export interface WeekGame {
  game_id: string;
  gameday: string;
  gametime: string | null;
  played?: boolean;
  away_team: string;
  home_team: string;
  spread_home: number | null;
  total: number | null;
  roof: string | null;
}

export interface WeekIndex {
  season: number;
  week: number;
  generated_at: string;
  games: WeekGame[];
}

export interface NewsAdjustment {
  gsis_id: string | null;
  player_name: string | null;
  team: string | null;
  availability_adj: number | null; // replacement availability, 0 to 1
  target_share_adj: number | null; // multiplier on target share
  carry_share_adj: number | null; // multiplier on carry share
  confidence: number | null; // 0 to 1
  summary: string | null;
  source_url: string | null;
  created_at: string;
}

export type GameWithAdjustments = GameData & { adjustments?: NewsAdjustment[] };

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) {
    let message = `Request failed (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep the default message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  meta: (signal?: AbortSignal) => getJson<Meta>("/meta", signal),
  weeks: (season: number, signal?: AbortSignal) =>
    getJson<{ season: number; weeks: { week: number; games: number }[] }>(`/weeks?season=${season}`, signal),
  week: (season: number, week: number, signal?: AbortSignal) =>
    getJson<WeekIndex>(`/weeks/${season}/${week}`, signal),
  game: (gameId: string, signal?: AbortSignal) =>
    getJson<GameWithAdjustments>(`/games/${encodeURIComponent(gameId)}`, signal),
};

/**
 * Turn news adjustments into engine overrides. The newest row per player wins,
 * and each change is scaled by its confidence.
 */
export function overridesFrom(game: GameWithAdjustments): Record<string, PlayerOverride> {
  const out: Record<string, PlayerOverride> = {};
  const baseAvailability = new Map<string, number>();
  for (const team of Object.values(game.teams)) {
    for (const p of team.players) baseAvailability.set(p.id, p.status.availability);
  }
  const seen = new Set<string>();
  for (const adj of game.adjustments ?? []) {
    if (!adj.gsis_id || seen.has(adj.gsis_id) || !baseAvailability.has(adj.gsis_id)) continue;
    seen.add(adj.gsis_id);
    const c = Math.min(1, Math.max(0, adj.confidence ?? 0.5));
    const o: PlayerOverride = {};
    if (adj.availability_adj != null) {
      const base = baseAvailability.get(adj.gsis_id) ?? 1;
      o.availability = base + (adj.availability_adj - base) * c;
    }
    if (adj.target_share_adj != null) o.targetShareMult = 1 + (adj.target_share_adj - 1) * c;
    if (adj.carry_share_adj != null) o.carryShareMult = 1 + (adj.carry_share_adj - 1) * c;
    out[adj.gsis_id] = o;
  }
  return out;
}
