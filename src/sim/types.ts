// Types for the game files produced by pipeline/build_data.py (data version v1).

export type Position = "QB" | "RB" | "FB" | "WR" | "TE";

export interface RateBlock {
  games_w?: number | null;
  plays_pg?: number | null;
  dropback_rate?: number | null;
  neutral_dropback_rate?: number | null;
  sack_rate?: number | null;
  scramble_rate?: number | null;
  scramble_ypa?: number | null;
  cmp_rate?: number | null;
  ypa?: number | null;
  int_rate?: number | null;
  pass_td_rate?: number | null;
  ypc?: number | null;
  rush_td_rate?: number | null;
  fumble_lost_rate?: number | null;
  def_td_pg?: number | null;
  turnovers_pg?: number | null;
  return_td_per_turnover?: number | null;
}

export interface TeamRates extends RateBlock {
  vs_league: Record<string, number>;
}

export interface PlayerStatus {
  availability: number;
  report: string | null;
  practice: string | null;
  injury: string | null;
  note: string | null;
}

export interface PlayerUsage {
  games: number;
  games_current: number;
  target_share?: number | null;
  carry_share?: number | null;
  dropback_share?: number | null;
  recent_target_share?: number | null;
  recent_carry_share?: number | null;
  snap_pct?: number | null;
  recent_snap_pct?: number | null;
  last_team?: string | null;
  changed_team?: boolean;
  base_target_share: number;
  base_carry_share: number;
  expected_target_share: number;
  expected_carry_share: number;
  start_prob?: number | null;
  source: "history" | "depth_default";
}

export interface ReceivingBaseline {
  targets: number;
  catch_rate: number | null;
  ypr: number | null;
  ypr_sd: number | null;
  td_rate: number | null;
  adot: number | null;
  explosive_rate: number | null;
  catch_yds_q: number[] | null;
}

export interface RushingBaseline {
  carries: number;
  ypc: number | null;
  ypc_sd: number | null;
  td_rate: number | null;
  fumble_lost_rate: number | null;
  explosive_rate: number | null;
  carry_yds_q: number[] | null;
}

export interface PassingBaseline {
  dropbacks: number;
  cmp_rate: number | null;
  ypa: number | null;
  int_rate: number | null;
  td_rate: number | null;
  sack_rate: number | null;
  scramble_rate: number | null;
  yds_per_cmp: number | null;
  yds_per_cmp_sd: number | null;
  sack_yds: number | null;
  scramble_ypa: number | null;
}

export interface PlayerData {
  id: string;
  name: string;
  pos: Position;
  depth_rank: number;
  team: string;
  headshot: string | null;
  status: PlayerStatus;
  usage: PlayerUsage;
  receiving: ReceivingBaseline | null;
  rushing: RushingBaseline;
  passing: PassingBaseline | null;
}

export interface TeamData {
  team: string;
  points: { pf_pg: number | null; pa_pg: number | null } | null;
  unlisted_qb_prob: number | null;
  offense: TeamRates;
  defense: TeamRates;
  players: PlayerData[];
}

export interface GameData {
  game_id: string;
  season: number;
  week: number;
  gameday: string;
  gametime: string | null;
  home_team: string;
  away_team: string;
  played: boolean;
  lines: {
    spread_home: number | null;
    total: number | null;
    implied_points: { home: number; away: number } | null;
    home_moneyline: number | null;
    away_moneyline: number | null;
  };
  venue: {
    stadium: string | null;
    roof: string | null;
    surface: string | null;
    temp: number | null;
    wind: number | null;
  };
  context: {
    div_game: boolean;
    home_rest: number | null;
    away_rest: number | null;
    home_qb_listed: string | null;
    away_qb_listed: string | null;
  };
  teams: Record<string, TeamData>;
  league: RateBlock;
  position_league: Record<string, {
    catch_rate: number | null;
    ypr: number | null;
    rec_td_rate: number | null;
    ypc: number | null;
    rush_td_rate: number | null;
  }>;
  data: {
    generated_at: string;
    weeks_played: number;
    prior_season_weight: number;
    depth_chart_as_of: string | null;
  };
}

/** Optional per-player overrides (Phase 3 news adjustments or manual what-ifs). */
export interface PlayerOverride {
  availability?: number;
  targetShareMult?: number;
  carryShareMult?: number;
}
