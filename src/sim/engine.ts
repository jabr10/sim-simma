// Sim Simma engine: drive-by-drive, play-by-play Monte Carlo simulation.
//
// Every number in ENGINE_TUNING is a modeling assumption. Tune them with
// backtesting (Phase 4) rather than treating them as facts.

import { Rng, hashSeed } from "./rng";
import type { GameData, PlayerData, PlayerOverride, RateBlock, TeamData } from "./types";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
export const ENGINE_TUNING = {
  halfSeconds: 1800,
  otSeconds: 600,
  // Seconds consumed per snap before pace adjustment.
  secRunningPlay: 35.5,
  secIncomplete: 7,
  secSack: 35,
  secTwoMinute: 14,
  secKillClock: 40,
  secPunt: 8,
  secFieldGoal: 5,
  paceClamp: [0.85, 1.15] as [number, number],
  // Kickoffs (average start near own 30 under the newer kickoff rules; verify each season).
  kickoffStartMean: 70,
  kickoffStartSd: 6,
  puntNetMean: 42,
  puntNetSd: 7,
  patMake: 0.95,
  // Field goal make probability: 1 / (1 + exp((distance - fgMid) / fgScale)).
  fgMid: 58,
  fgScale: 5,
  fgMaxAttempt: 57,
  // Situational pass rates before team tilt.
  passRate: {
    firstDown: 0.5,
    secondLong: 0.62,
    secondShort: 0.45,
    thirdLong: 0.88,
    thirdMedium: 0.64,
    thirdShort: 0.32,
    trailingBig: 0.15,
    trailingHuge: 0.25,
    leadingLate: -0.2,
    twoMinute: 0.3,
  },
  stripSackLost: 0.07,
  catchFumbleLost: 0.004,
  defTdOnSackFumbleMult: 1.8,
  // Defensive TDs are streaky, so team skill is capped hard.
  defTdMatchupClamp: [0.6, 1.6] as [number, number],
  // Market calibration.
  marketWeight: 0.6,
  calibrationRounds: 3,
  calibrationSims: 400,
  efficiencyClamp: [0.75, 1.3] as [number, number],
  // Shape fallbacks (yards per catch / carry quantiles at p10..p90).
  genericCatchQ: [3, 6, 9, 14, 21],
  genericCarryQ: [-1, 1, 3, 6, 10],
  minSampleForOwnShape: 20,
  unlistedQb: {
    cmp_rate: 0.6,
    ypa: 6.2,
    int_rate: 0.03,
    td_rate: 0.035,
    sack_rate: 0.08,
    scramble_rate: 0.05,
    yds_per_cmp: 10.3,
    sack_yds: -7,
    scramble_ypa: 6,
    carry_share: 0.03,
  },
  otherReceiver: { catch_rate: 0.64, ypr: 10.5 },
  otherRusher: { ypc: 4.1, fumble: 0.008 },
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export const STAT_KEYS = [
  "passAtt", "cmp", "passYds", "passTd", "ints", "sacked",
  "rushAtt", "rushYds", "targets", "rec", "recYds", "tds",
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
const NS = STAT_KEYS.length;
const S_PASS_ATT = 0, S_CMP = 1, S_PASS_YDS = 2, S_PASS_TD = 3, S_INTS = 4, S_SACKED = 5,
  S_RUSH_ATT = 6, S_RUSH_YDS = 7, S_TARGETS = 8, S_REC = 9, S_REC_YDS = 10, S_TDS = 11;

export const TEAM_KEYS = ["points", "sacks", "defTd", "turnovers", "yards", "plays"] as const;
export type TeamKey = (typeof TEAM_KEYS)[number];
const NT = TEAM_KEYS.length;
const T_POINTS = 0, T_SACKS = 1, T_DEF_TD = 2, T_TURNOVERS = 3, T_YARDS = 4, T_PLAYS = 5;

export interface SimOptions {
  iterations?: number;
  seed?: number;
  calibrateToMarket?: boolean;
  marketWeight?: number;
  overrides?: Record<string, PlayerOverride>;
  keepDistributions?: boolean;
}

export interface Summary {
  mean: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

export interface PlayerResult {
  id: string;
  name: string;
  pos: string;
  team: string;
  depthRank: number;
  headshot: string | null;
  availability: number;
  playedPct: number;
  statusNote: string | null;
  // Summaries are conditional on the player playing.
  stats: Partial<Record<StatKey, Summary>>;
  anyTdProb: number;
}

export interface TeamResult {
  team: string;
  isHome: boolean;
  winProb: number;
  points: Summary;
  sacks: Summary;
  sacks3PlusProb: number;
  defTdProb: number;
  turnovers: Summary;
  yards: Summary;
  plays: Summary;
  efficiency: number;
  impliedPoints: number | null;
}

export type DriveResultType =
  | "Touchdown" | "Field goal" | "Missed FG" | "Punt" | "Interception" | "Fumble"
  | "Downs" | "Safety" | "End of half" | "End of game" | "Pick-six" | "Fumble return TD";

export interface DriveLog {
  period: "1st half" | "2nd half" | "OT";
  team: string;
  startYardline: number;
  plays: number;
  yards: number;
  result: DriveResultType;
  detail: string | null;
  scoreHome: number;
  scoreAway: number;
  clockStart: string;
}

export interface SimResult {
  gameId: string;
  home: string;
  away: string;
  iterations: number;
  seed: number;
  elapsedMs: number;
  tieProb: number;
  teams: Record<string, TeamResult>;
  players: PlayerResult[];
  featured: { index: number; homePoints: number; awayPoints: number; drives: DriveLog[] };
  distributions?: {
    players: Record<string, Partial<Record<StatKey, Float32Array>>>;
    teams: Record<string, Record<TeamKey, Float32Array>>;
    played: Record<string, Uint8Array>;
    margin: Float32Array;
  };
  notes: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const num = (v: number | null | undefined, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const QP = [0.1, 0.25, 0.5, 0.75, 0.9];

/** Inverse CDF from five quantiles with a linear lower tail and exponential upper tail. */
function sampleQuantiles(q: number[], u: number): number {
  if (u < 0.1) {
    const lo = Math.min(q[0] - (q[1] - q[0]) * 1.5, q[0] - 2);
    return lo + (q[0] - lo) * (u / 0.1);
  }
  if (u > 0.9) {
    const scale = Math.max(3, (q[4] - q[2]) * 0.55);
    const v = (u - 0.9) / 0.1;
    return q[4] - Math.log(1 - v + 1e-9) * scale;
  }
  for (let i = 0; i < 4; i++) {
    if (u <= QP[i + 1]) {
      return q[i] + ((q[i + 1] - q[i]) * (u - QP[i])) / (QP[i + 1] - QP[i]);
    }
  }
  return q[4];
}

function quantileMean(q: number[]): number {
  const n = 400;
  let s = 0;
  for (let i = 0; i < n; i++) s += sampleQuantiles(q, (i + 0.5) / n);
  return s / n;
}

function validQ(q: number[] | null | undefined): q is number[] {
  return !!q && q.length === 5 && q.every((v) => typeof v === "number" && Number.isFinite(v));
}

function summarize(values: Float32Array | number[], mask?: Uint8Array): Summary {
  const arr: number[] = [];
  for (let i = 0; i < values.length; i++) if (!mask || mask[i]) arr.push(values[i]);
  if (arr.length === 0) return { mean: 0, p10: 0, p25: 0, median: 0, p75: 0, p90: 0 };
  arr.sort((a, b) => a - b);
  const at = (p: number) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1) + 0.5))];
  let sum = 0;
  for (const v of arr) sum += v;
  return {
    mean: round(sum / arr.length, 2),
    p10: at(0.1), p25: at(0.25), median: at(0.5), p75: at(0.75), p90: at(0.9),
  };
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

function fmtClock(period: number, secLeft: number): string {
  let s = Math.max(0, Math.round(secLeft));
  let label: string;
  if (period === 3) {
    label = "OT";
  } else {
    const firstQuarterOfHalf = s > 900;
    label = `Q${(period - 1) * 2 + (firstQuarterOfHalf ? 1 : 2)}`;
    if (firstQuarterOfHalf) s -= 900;
  }
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${label} ${mm}:${ss}`;
}

/** Probability a player is over a line, computed from a stored distribution. */
export function probOver(dist: Float32Array, line: number, played?: Uint8Array): number {
  let n = 0;
  let over = 0;
  for (let i = 0; i < dist.length; i++) {
    if (played && !played[i]) continue;
    n++;
    if (dist[i] > line) over++;
  }
  return n ? over / n : 0;
}

// ---------------------------------------------------------------------------
// Prepared models
// ---------------------------------------------------------------------------
interface PreparedPlayer {
  gi: number; // global index
  data: PlayerData;
  isQB: boolean;
  availability: number;
  baseTgt: number;
  baseCar: number;
  // receiving
  catchRate: number;
  catchQ: number[];
  catchScale: number;
  // rushing
  carryQ: number[];
  carryScale: number;
  fumbleLost: number;
  // passing
  qb: QbRates | null;
}

interface QbRates {
  cmp: number;
  intRate: number;
  sackRate: number;
  sackYds: number;
  scrambleRate: number;
  scrambleYpa: number;
  ydsPerCmp: number;
}

interface TeamModel {
  code: string;
  data: TeamData;
  players: PreparedPlayer[];
  qbs: PreparedPlayer[];
  others: PreparedPlayer[];
  unlistedQbProb: number;
  pace: number;
  passTilt: number;
  efficiency: number;
  impliedPoints: number | null;
}

interface Lineup {
  qb: PreparedPlayer | null;
  qbRates: QbRates;
  tgtCum: Float64Array;
  tgtRef: (PreparedPlayer | null)[];
  tgtLen: number;
  carCum: Float64Array;
  carRef: (PreparedPlayer | null)[];
  carLen: number;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------
export class GameSimulator {
  readonly game: GameData;
  readonly iterations: number;
  readonly seed: number;
  private readonly opts: Required<Omit<SimOptions, "overrides">> & { overrides: Record<string, PlayerOverride> };
  private readonly league: RateBlock;
  private readonly teams: [TeamModel, TeamModel]; // 0 = home, 1 = away
  private readonly all: PreparedPlayer[] = [];
  private readonly defMult: [Record<string, number>, Record<string, number>];
  private readonly offMult: [Record<string, number>, Record<string, number>];

  // Per-sim scratch
  private pstat: Float64Array;
  private tstat: Float64Array;
  private played: Uint8Array;

  // Accumulated results
  private done = 0;
  private startTime = 0;
  private pDist: Float32Array[]; // [gi * NS]
  private playedDist: Uint8Array[]; // [gi]
  private tDist: Float32Array[]; // [team * NT]
  private readonly notes: string[] = [];
  private calibrated = false;

  constructor(game: GameData, options: SimOptions = {}) {
    this.game = game;
    this.iterations = Math.max(100, Math.floor(options.iterations ?? 10000));
    this.seed = (options.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
    this.opts = {
      iterations: this.iterations,
      seed: this.seed,
      calibrateToMarket: options.calibrateToMarket ?? true,
      marketWeight: options.marketWeight ?? ENGINE_TUNING.marketWeight,
      keepDistributions: options.keepDistributions ?? true,
      overrides: options.overrides ?? {},
    };
    this.league = game.league;

    const home = game.teams[game.home_team];
    const away = game.teams[game.away_team];
    if (!home || !away) throw new Error(`Game ${game.game_id} is missing team data`);

    const implied = game.lines.implied_points;
    this.teams = [
      this.prepareTeam(home, implied ? implied.home : null),
      this.prepareTeam(away, implied ? implied.away : null),
    ];
    this.defMult = [home.defense.vs_league ?? {}, away.defense.vs_league ?? {}];
    this.offMult = [home.offense.vs_league ?? {}, away.offense.vs_league ?? {}];

    const np = this.all.length;
    this.pstat = new Float64Array(np * NS);
    this.tstat = new Float64Array(2 * NT);
    this.played = new Uint8Array(np);
    this.pDist = Array.from({ length: np * NS }, () => new Float32Array(this.iterations));
    this.playedDist = Array.from({ length: np }, () => new Uint8Array(this.iterations));
    this.tDist = Array.from({ length: 2 * NT }, () => new Float32Array(this.iterations));

    if (!implied) this.notes.push("No betting lines available, so results are not anchored to the market.");
  }

  // -------------------------------------------------------------------------
  // Preparation
  // -------------------------------------------------------------------------
  private prepareTeam(t: TeamData, implied: number | null): TeamModel {
    const L = this.league;
    const T = ENGINE_TUNING;
    const posLeague = this.game.position_league;
    const players: PreparedPlayer[] = [];

    for (const p of t.players) {
      const ov = this.opts.overrides[p.id] ?? {};
      const pl = posLeague[p.pos] ?? {};
      const rec = p.receiving;
      const rush = p.rushing;

      const catchQ = rec && rec.targets >= T.minSampleForOwnShape && validQ(rec.catch_yds_q) ? rec.catch_yds_q : T.genericCatchQ;
      const ypr = num(rec?.ypr, num(pl.ypr, T.otherReceiver.ypr));
      const carryQ = rush && rush.carries >= T.minSampleForOwnShape && validQ(rush.carry_yds_q) ? rush.carry_yds_q : T.genericCarryQ;
      const ypc = num(rush?.ypc, num(pl.ypc, T.otherRusher.ypc));
      const carries = rush?.carries ?? 0;
      const rawFum = num(rush?.fumble_lost_rate, T.otherRusher.fumble);
      const fumbleLost = (rawFum * carries + T.otherRusher.fumble * 60) / (carries + 60);

      let qb: QbRates | null = null;
      if (p.pos === "QB" && p.passing) {
        const ps = p.passing;
        const lgYpc = num(L.ypa, 7) / num(L.cmp_rate, 0.645);
        qb = {
          cmp: num(ps.cmp_rate, num(L.cmp_rate, 0.645)),
          intRate: num(ps.int_rate, num(L.int_rate, 0.022)),
          sackRate: num(ps.sack_rate, num(L.sack_rate, 0.065)),
          sackYds: -Math.abs(num(ps.sack_yds, -7)),
          scrambleRate: num(ps.scramble_rate, num(L.scramble_rate, 0.056)),
          scrambleYpa: num(ps.scramble_ypa, num(L.scramble_ypa, 7.5)),
          ydsPerCmp: num(ps.yds_per_cmp, lgYpc),
        };
        // Blend yards per completion toward league for small samples.
        const db = ps.dropbacks ?? 0;
        qb.ydsPerCmp = (qb.ydsPerCmp * db + lgYpc * 150) / (db + 150);
      }

      const prepared: PreparedPlayer = {
        gi: this.all.length,
        data: p,
        isQB: p.pos === "QB",
        availability: clamp(ov.availability ?? num(p.status?.availability, 1), 0, 1),
        baseTgt: Math.max(0, num(p.usage.base_target_share, 0) * (ov.targetShareMult ?? 1)),
        baseCar: Math.max(0, num(p.usage.base_carry_share, 0) * (ov.carryShareMult ?? 1)),
        catchRate: clamp(num(rec?.catch_rate, num(pl.catch_rate, T.otherReceiver.catch_rate)), 0.3, 0.9),
        catchQ,
        catchScale: ypr / Math.max(1, quantileMean(catchQ)),
        carryQ,
        carryScale: ypc / Math.max(0.5, quantileMean(carryQ)),
        fumbleLost,
        qb,
      };
      players.push(prepared);
      this.all.push(prepared);
    }

    const qbs = players.filter((p) => p.isQB);
    const others = players.filter((p) => !p.isQB);
    const listedStart = qbs.reduce((s, p) => s + p.availability, 0);
    const pace = clamp(num(L.plays_pg, 60) / num(t.offense.plays_pg, num(L.plays_pg, 60)), ...T.paceClamp);
    const passTilt = clamp(num(t.offense.neutral_dropback_rate, 0.55) - num(L.neutral_dropback_rate, 0.55), -0.12, 0.12);

    return {
      code: t.team,
      data: t,
      players,
      qbs,
      others,
      unlistedQbProb: qbs.length === 0 ? 1 : clamp(num(t.unlisted_qb_prob, 1 - Math.min(1, listedStart)), 0, 1),
      pace,
      passTilt,
      efficiency: 1,
      impliedPoints: implied,
    };
  }

  private buildLineup(team: TeamModel, rng: Rng): Lineup {
    const T = ENGINE_TUNING;
    // Starting QB: walk the depth chart, each QB plays with his own availability.
    let qb: PreparedPlayer | null = null;
    for (const cand of team.qbs) {
      if (this.opts.overrides[cand.data.id]?.availability === 0) continue;
      if (rng.chance(cand.availability)) {
        qb = cand;
        break;
      }
    }
    if (qb) this.played[qb.gi] = 1;

    const qbRates: QbRates = qb?.qb ?? {
      cmp: T.unlistedQb.cmp_rate,
      intRate: T.unlistedQb.int_rate,
      sackRate: T.unlistedQb.sack_rate,
      sackYds: T.unlistedQb.sack_yds,
      scrambleRate: T.unlistedQb.scramble_rate,
      scrambleYpa: T.unlistedQb.scramble_ypa,
      ydsPerCmp: T.unlistedQb.yds_per_cmp,
    };

    const n = team.others.length + 2;
    const tgtCum = new Float64Array(n);
    const tgtRef: (PreparedPlayer | null)[] = [];
    const carCum = new Float64Array(n);
    const carRef: (PreparedPlayer | null)[] = [];

    const activeTgt: [PreparedPlayer, number][] = [];
    const activeCar: [PreparedPlayer | null, number][] = [];
    for (const p of team.others) {
      if (rng.chance(p.availability)) {
        this.played[p.gi] = 1;
        if (p.baseTgt > 0) activeTgt.push([p, p.baseTgt]);
        if (p.baseCar > 0) activeCar.push([p, p.baseCar]);
      }
    }
    const qbCarry = qb ? qb.baseCar : T.unlistedQb.carry_share;
    if (qbCarry > 0) activeCar.push([qb, qbCarry]);

    const coverageT = 0.97;
    const coverageC = 0.97;
    let len = 0;
    let sum = activeTgt.reduce((s, [, w]) => s + w, 0);
    let acc = 0;
    if (sum > 0) {
      for (const [p, w] of activeTgt) {
        acc += (w / sum) * coverageT;
        tgtCum[len] = acc;
        tgtRef[len++] = p;
      }
    }
    tgtCum[len] = 1; // remainder goes to unlisted receivers
    tgtRef[len++] = null;
    const tgtLen = len;

    len = 0;
    acc = 0;
    sum = activeCar.reduce((s, [, w]) => s + w, 0);
    if (sum > 0) {
      for (const [p, w] of activeCar) {
        acc += (w / sum) * coverageC;
        carCum[len] = acc;
        carRef[len++] = p;
      }
    }
    carCum[len] = 1;
    carRef[len++] = null;

    return { qb, qbRates, tgtCum, tgtRef, tgtLen, carCum, carRef, carLen: len };
  }

  // -------------------------------------------------------------------------
  // One game
  // -------------------------------------------------------------------------
  private playGame(rng: Rng, log: DriveLog[] | null): void {
    const T = ENGINE_TUNING;
    const PR = T.passRate;
    const L = this.league;
    const pstat = this.pstat;
    const tstat = this.tstat;
    pstat.fill(0);
    tstat.fill(0);
    this.played.fill(0);

    const lineups: [Lineup, Lineup] = [this.buildLineup(this.teams[0], rng), this.buildLineup(this.teams[1], rng)];
    const score = [0, 0];
    const lgCmp = num(L.cmp_rate, 0.645);
    const lgYpcmp = num(L.ypa, 7) / lgCmp;
    const lgRetTd = num(L.return_td_per_turnover, 0.075);

    let period = 1;
    let secLeft = T.halfSeconds;

    const addP = (p: PreparedPlayer | null, key: number, v: number) => {
      if (p) pstat[p.gi * NS + key] += v;
    };
    const addT = (team: number, key: number, v: number) => {
      tstat[team * NT + key] += v;
    };
    const kickoffStart = () => Math.round(clamp(rng.normal(T.kickoffStartMean, T.kickoffStartSd), 55, 85));
    const fgProb = (dist: number) => 1 / (1 + Math.exp((dist - T.fgMid) / T.fgScale));
    const scoreTd = (team: number) => {
      score[team] += 6 + (rng.chance(T.patMake) ? 1 : 0);
    };
    const defTdChance = (o: number, d: number, mult: number) =>
      clamp(
        lgRetTd *
          mult *
          clamp(
            Math.sqrt(num(this.defMult[d].def_td_pg, 1) * num(this.offMult[o].def_td_pg, 1)),
            ...T.defTdMatchupClamp,
          ),
        0,
        0.35,
      );

    const passProb = (o: number, down: number, dist: number, margin: number): number => {
      let base: number;
      if (down === 1) base = PR.firstDown;
      else if (down === 2) base = dist >= 8 ? PR.secondLong : PR.secondShort;
      else if (dist >= 5) base = PR.thirdLong;
      else if (dist >= 2) base = PR.thirdMedium;
      else base = PR.thirdShort;

      const secondHalf = period >= 2;
      if (secondHalf && margin <= -17) base += PR.trailingHuge;
      else if (secondHalf && margin <= -9) base += PR.trailingBig;
      if (secondHalf && margin >= 9 && secLeft < 900) base += PR.leadingLate;
      if (secLeft <= 120 && margin <= 0) base += PR.twoMinute;
      return clamp(base + this.teams[o].passTilt, 0.08, 0.96);
    };

    const clockFor = (o: number, kind: "run" | "inc" | "sack", margin: number): number => {
      if (secLeft <= 120 && margin <= 0) return kind === "inc" ? T.secIncomplete : T.secTwoMinute;
      if (period === 1 && secLeft <= 120) return kind === "inc" ? T.secIncomplete : T.secTwoMinute + 6;
      if (period >= 2 && secLeft <= 300 && margin > 0 && kind !== "inc") return T.secKillClock;
      const base = kind === "run" ? T.secRunningPlay : kind === "inc" ? T.secIncomplete : T.secSack;
      return base * this.teams[o].pace;
    };

    interface DriveOut {
      result: DriveResultType;
      nextYl: number; // starting yardline for the other team (distance to its goal)
      detail: string | null;
    }

    const runDrive = (o: number, startYl: number): DriveOut => {
      const d = 1 - o;
      const team = this.teams[o];
      const lu = lineups[o];
      const qbR = lu.qbRates;
      const dm = this.defMult[d];
      const eff = team.efficiency;
      const qbName = lu.qb ? lu.qb.data.name : "Backup QB";

      let yl = startYl;
      let down = 1;
      let dist = Math.min(10, yl);
      let plays = 0;
      let yards = 0;
      const clockStart = fmtClock(period, secLeft);

      const finish = (result: DriveResultType, nextYl: number, detail: string | null): DriveOut => {
        if (log) {
          log.push({
            period: period === 1 ? "1st half" : period === 2 ? "2nd half" : "OT",
            team: team.code,
            startYardline: startYl,
            plays,
            yards,
            result,
            detail,
            scoreHome: score[0],
            scoreAway: score[1],
            clockStart,
          });
        }
        return { result, nextYl, detail };
      };

      while (secLeft > 0) {
        const margin = score[o] - score[d];
        const fgDist = yl + 17;

        // Kick at the end of a half when in range.
        const lateKick = secLeft <= 10 && fgDist <= T.fgMaxAttempt + 1 && (period === 1 || margin >= -3);
        if (down === 4 || lateKick) {
          let goForIt = false;
          if (!lateKick) {
            const late = period >= 2 && secLeft < 360;
            if (period === 3) {
              goForIt = margin < -3 || (margin === -3 && fgDist > T.fgMaxAttempt) || (margin === 0 && fgDist > T.fgMaxAttempt && yl < 45);
            } else if (late && margin < 0) {
              goForIt = !(margin >= -3 && fgDist <= T.fgMaxAttempt && secLeft < 120);
            } else if (late && margin > 0) {
              goForIt = dist <= 1 && yl <= 40 && rng.chance(0.4);
            } else if (dist <= 1 && yl <= 70) {
              goForIt = rng.chance(0.65);
            } else if (dist <= 2 && yl <= 45) {
              goForIt = rng.chance(0.45);
            }
          }

          if (!goForIt) {
            if (fgDist <= T.fgMaxAttempt) {
              secLeft -= T.secFieldGoal;
              if (rng.chance(fgProb(fgDist))) {
                score[o] += 3;
                return finish("Field goal", kickoffStart(), `${fgDist}-yd FG good`);
              }
              return finish("Missed FG", clamp(100 - (yl + 7), 20, 80), `${fgDist}-yd FG missed`);
            }
            secLeft -= T.secPunt;
            const net = Math.round(rng.normal(T.puntNetMean, T.puntNetSd));
            const land = yl - net;
            const nextYl = land <= 0 ? 80 : clamp(100 - land, 1, 99);
            return finish("Punt", nextYl, null);
          }
        }

        plays++;
        addT(o, T_PLAYS, 1);
        let gained = 0;
        let clockKind: "run" | "inc" | "sack" = "run";
        let scorer: string | null = null;

        if (rng.chance(passProb(o, down, dist, margin))) {
          const sackP = clamp(qbR.sackRate * num(dm.sack_rate, 1), 0.015, 0.16);
          const scrP = clamp(qbR.scrambleRate, 0, 0.15);
          const u = rng.next();

          if (u < sackP) {
            clockKind = "sack";
            gained = Math.min(-1, Math.round(rng.normal(qbR.sackYds, 2.5)));
            addP(lu.qb, S_SACKED, 1);
            addT(d, T_SACKS, 1);
            if (rng.chance(T.stripSackLost)) {
              addT(o, T_TURNOVERS, 1);
              secLeft -= clockFor(o, clockKind, margin);
              if (rng.chance(defTdChance(o, d, T.defTdOnSackFumbleMult))) {
                addT(d, T_DEF_TD, 1);
                scoreTd(d);
                return finish("Fumble return TD", kickoffStart(), `Strip-sack of ${qbName} returned for TD`);
              }
              yards += gained;
              return finish("Fumble", clamp(100 - (yl - gained), 1, 99), `Strip-sack of ${qbName}`);
            }
          } else if (u < sackP + scrP) {
            gained = Math.round(clamp(rng.normal(qbR.scrambleYpa, 6), -3, 60) * eff);
            addP(lu.qb, S_RUSH_ATT, 1);
            if (gained >= yl) {
              gained = yl;
              addP(lu.qb, S_TDS, 1);
              scorer = `${gained}-yd scramble by ${qbName}`;
            }
            addP(lu.qb, S_RUSH_YDS, gained);
          } else {
            const ti = rng.pickCumulative(lu.tgtCum, lu.tgtLen);
            const tgt = ti >= 0 ? lu.tgtRef[ti] : null;
            addP(lu.qb, S_PASS_ATT, 1);
            addP(tgt, S_TARGETS, 1);

            const intP = clamp(qbR.intRate * num(dm.int_rate, 1), 0.005, 0.07);
            if (rng.chance(intP)) {
              addP(lu.qb, S_INTS, 1);
              addT(o, T_TURNOVERS, 1);
              secLeft -= clockFor(o, "inc", margin);
              if (rng.chance(defTdChance(o, d, 1))) {
                addT(d, T_DEF_TD, 1);
                scoreTd(d);
                return finish("Pick-six", kickoffStart(), `${qbName} intercepted and returned for TD`);
              }
              const spot = yl - Math.max(0, Math.round(rng.normal(12, 8)));
              if (spot <= 0) return finish("Interception", 80, `${qbName} intercepted in the end zone`);
              const ret = Math.max(0, Math.round(rng.normal(8, 8)));
              return finish("Interception", clamp(100 - spot - ret, 5, 95), `${qbName} intercepted`);
            }

            const catchRate = tgt ? tgt.catchRate : T.otherReceiver.catch_rate;
            const cmpP = clamp(
              catchRate * Math.sqrt(qbR.cmp / lgCmp) * num(dm.cmp_rate, 1) * (0.97 + 0.03 * eff),
              0.2,
              0.92,
            );
            if (rng.chance(cmpP)) {
              const shapeQ = tgt ? tgt.catchQ : T.genericCatchQ;
              const scale = tgt ? tgt.catchScale : T.otherReceiver.ypr / quantileMean(T.genericCatchQ);
              const defYpc = clamp(num(dm.ypa, 1) / num(dm.cmp_rate, 1), 0.8, 1.2);
              let y = sampleQuantiles(shapeQ, rng.next()) * scale * Math.sqrt(qbR.ydsPerCmp / lgYpcmp) * defYpc;
              if (y > 0) y *= eff;
              gained = Math.round(clamp(y, -5, 99));
              if (gained >= yl) {
                gained = yl;
                addP(tgt, S_TDS, 1);
                addP(lu.qb, S_PASS_TD, 1);
                scorer = `${gained}-yd pass ${qbName} to ${tgt ? tgt.data.name : "teammate"}`;
              }
              addP(lu.qb, S_CMP, 1);
              addP(lu.qb, S_PASS_YDS, gained);
              addP(tgt, S_REC, 1);
              addP(tgt, S_REC_YDS, gained);

              if (!scorer && rng.chance(T.catchFumbleLost)) {
                addT(o, T_TURNOVERS, 1);
                yards += gained;
                secLeft -= clockFor(o, "run", margin);
                if (rng.chance(defTdChance(o, d, 1))) {
                  addT(d, T_DEF_TD, 1);
                  scoreTd(d);
                  return finish("Fumble return TD", kickoffStart(), "Fumble after catch returned for TD");
                }
                return finish("Fumble", clamp(100 - (yl - gained), 1, 99), "Fumble after catch");
              }
            } else {
              clockKind = "inc";
            }
          }
        } else {
          const ci = rng.pickCumulative(lu.carCum, lu.carLen);
          const rusher = ci >= 0 ? lu.carRef[ci] : null;
          const shapeQ = rusher ? rusher.carryQ : T.genericCarryQ;
          const scale = rusher ? rusher.carryScale : T.otherRusher.ypc / quantileMean(T.genericCarryQ);
          let y = sampleQuantiles(shapeQ, rng.next()) * scale;
          if (y > 0) y *= num(dm.ypc, 1) * eff;
          gained = Math.round(clamp(y, -8, 99));
          const rname = rusher ? rusher.data.name : "ball carrier";
          addP(rusher, S_RUSH_ATT, 1);
          if (gained >= yl) {
            gained = yl;
            addP(rusher, S_TDS, 1);
            scorer = `${gained}-yd run by ${rname}`;
          }
          addP(rusher, S_RUSH_YDS, gained);

          const fum = rusher ? rusher.fumbleLost : T.otherRusher.fumble;
          if (!scorer && rng.chance(fum)) {
            addT(o, T_TURNOVERS, 1);
            yards += gained;
            secLeft -= clockFor(o, "run", margin);
            if (rng.chance(defTdChance(o, d, 1))) {
              addT(d, T_DEF_TD, 1);
              scoreTd(d);
              return finish("Fumble return TD", kickoffStart(), `${rname} fumble returned for TD`);
            }
            return finish("Fumble", clamp(100 - (yl - gained), 1, 99), `${rname} fumbled`);
          }
        }

        yards += gained;
        addT(o, T_YARDS, gained);
        secLeft -= clockFor(o, clockKind, margin);

        if (scorer) {
          scoreTd(o);
          return finish("Touchdown", kickoffStart(), scorer);
        }

        yl -= gained;
        if (yl >= 100) {
          score[d] += 2;
          return finish("Safety", 62, `Safety, ${this.teams[d].code} scores 2`);
        }

        dist -= gained;
        if (dist <= 0) {
          down = 1;
          dist = Math.min(10, yl);
        } else {
          down++;
          if (down > 4) return finish("Downs", clamp(100 - yl, 1, 99), null);
        }
      }
      return finish(period === 3 ? "End of game" : "End of half", kickoffStart(), null);
    };

    // Regulation
    const firstReceiver = rng.chance(0.5) ? 0 : 1;
    for (period = 1; period <= 2; period++) {
      secLeft = T.halfSeconds;
      let poss = period === 1 ? firstReceiver : 1 - firstReceiver;
      let yl = kickoffStart();
      while (secLeft > 0) {
        const out = runDrive(poss, yl);
        poss = 1 - poss;
        yl = out.nextYl;
      }
    }

    // Overtime: both teams get a possession, then sudden death.
    if (score[0] === score[1]) {
      period = 3;
      secLeft = T.otSeconds;
      let poss = rng.chance(0.5) ? 0 : 1;
      let yl = kickoffStart();
      let drives = 0;
      while (secLeft > 0) {
        const out = runDrive(poss, yl);
        drives++;
        const after = score[0] - score[1];
        const defScored = out.result === "Pick-six" || out.result === "Fumble return TD" || out.result === "Safety";
        if (drives === 1 && defScored) break;
        if (drives >= 2 && after !== 0) break;
        poss = 1 - poss;
        yl = out.nextYl;
      }
    }

    addT(0, T_POINTS, score[0]);
    addT(1, T_POINTS, score[1]);
  }

  // -------------------------------------------------------------------------
  // Market calibration
  // -------------------------------------------------------------------------
  calibrate(): void {
    if (this.calibrated) return;
    this.calibrated = true;
    const T = ENGINE_TUNING;
    if (!this.opts.calibrateToMarket || this.teams.some((t) => t.impliedPoints === null)) return;

    const w = clamp(this.opts.marketWeight, 0, 1);
    if (w === 0) return;
    const rng = new Rng(hashSeed(this.seed, 0xca11b));
    const n = T.calibrationSims;
    let baseMeans: [number, number] | null = null;

    for (let round = 0; round < T.calibrationRounds; round++) {
      const pts = [0, 0];
      for (let i = 0; i < n; i++) {
        this.playGame(rng, null);
        pts[0] += this.tstat[T_POINTS];
        pts[1] += this.tstat[NT + T_POINTS];
      }
      const means: [number, number] = [pts[0] / n, pts[1] / n];
      if (!baseMeans) baseMeans = means;
      for (let k = 0; k < 2; k++) {
        const team = this.teams[k];
        const target = w * (team.impliedPoints as number) + (1 - w) * baseMeans[k];
        const ratio = target / Math.max(3, means[k]);
        // Points respond faster than yards, so move efficiency by a dampened ratio.
        team.efficiency = clamp(team.efficiency * Math.pow(ratio, 0.5), ...T.efficiencyClamp);
      }
    }
    this.notes.push(
      `Scoring anchored ${Math.round(w * 100)}% toward betting-market implied totals.`,
    );
  }

  // -------------------------------------------------------------------------
  // Batch running (for progress updates in a Web Worker or UI loop)
  // -------------------------------------------------------------------------
  get progress(): number {
    return this.done / this.iterations;
  }

  get isDone(): boolean {
    return this.done >= this.iterations;
  }

  runBatch(count: number): void {
    if (this.done === 0) {
      this.startTime = now();
      this.calibrate();
    }
    const end = Math.min(this.iterations, this.done + count);
    const np = this.all.length;
    for (let i = this.done; i < end; i++) {
      const rng = new Rng(hashSeed(this.seed, i + 1));
      this.playGame(rng, null);
      for (let g = 0; g < np; g++) {
        this.playedDist[g][i] = this.played[g];
        const base = g * NS;
        for (let s = 0; s < NS; s++) this.pDist[base + s][i] = this.pstat[base + s];
      }
      for (let k = 0; k < 2 * NT; k++) this.tDist[k][i] = this.tstat[k];
    }
    this.done = end;
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------
  finish(): SimResult {
    if (!this.isDone) this.runBatch(this.iterations - this.done);
    const N = this.iterations;
    const home = this.teams[0];
    const away = this.teams[1];
    const hp = this.tDist[T_POINTS];
    const ap = this.tDist[NT + T_POINTS];

    let homeWins = 0;
    let ties = 0;
    const margin = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      margin[i] = hp[i] - ap[i];
      if (hp[i] > ap[i]) homeWins++;
      else if (hp[i] === ap[i]) ties++;
    }

    const teamResult = (k: 0 | 1): TeamResult => {
      const m = this.teams[k];
      const col = (key: number) => this.tDist[k * NT + key];
      const sacks = col(T_SACKS);
      const defTd = col(T_DEF_TD);
      let s3 = 0;
      let dtd = 0;
      for (let i = 0; i < N; i++) {
        if (sacks[i] >= 3) s3++;
        if (defTd[i] >= 1) dtd++;
      }
      const wins = k === 0 ? homeWins : N - homeWins - ties;
      return {
        team: m.code,
        isHome: k === 0,
        winProb: round(wins / N, 4),
        points: summarize(col(T_POINTS)),
        sacks: summarize(sacks),
        sacks3PlusProb: round(s3 / N, 4),
        defTdProb: round(dtd / N, 4),
        turnovers: summarize(col(T_TURNOVERS)),
        yards: summarize(col(T_YARDS)),
        plays: summarize(col(T_PLAYS)),
        efficiency: round(m.efficiency, 3),
        impliedPoints: m.impliedPoints,
      };
    };

    const players: PlayerResult[] = this.all.map((p) => {
      const mask = this.playedDist[p.gi];
      let playedCount = 0;
      let tdGames = 0;
      const tds = this.pDist[p.gi * NS + S_TDS];
      for (let i = 0; i < N; i++) {
        if (mask[i]) {
          playedCount++;
          if (tds[i] > 0) tdGames++;
        }
      }
      const keys: StatKey[] = p.isQB
        ? ["passAtt", "cmp", "passYds", "passTd", "ints", "sacked", "rushAtt", "rushYds", "tds"]
        : ["targets", "rec", "recYds", "rushAtt", "rushYds", "tds"];
      const stats: Partial<Record<StatKey, Summary>> = {};
      if (playedCount > 0) {
        for (const key of keys) {
          stats[key] = summarize(this.pDist[p.gi * NS + STAT_KEYS.indexOf(key)], mask);
        }
      }
      return {
        id: p.data.id,
        name: p.data.name,
        pos: p.data.pos,
        team: p.data.team,
        depthRank: p.data.depth_rank,
        headshot: p.data.headshot,
        availability: p.availability,
        playedPct: round(playedCount / N, 4),
        statusNote: p.data.status?.note ?? p.data.status?.report ?? null,
        stats,
        anyTdProb: playedCount ? round(tdGames / playedCount, 4) : 0,
      };
    });

    const featured = this.pickFeatured();
    const elapsedMs = Math.round(now() - this.startTime);

    const result: SimResult = {
      gameId: this.game.game_id,
      home: home.code,
      away: away.code,
      iterations: N,
      seed: this.seed,
      elapsedMs,
      tieProb: round(ties / N, 4),
      teams: { [home.code]: teamResult(0), [away.code]: teamResult(1) },
      players,
      featured,
      notes: [...this.notes],
    };

    if (this.opts.keepDistributions) {
      const pd: Record<string, Partial<Record<StatKey, Float32Array>>> = {};
      for (const p of this.all) {
        const entry: Partial<Record<StatKey, Float32Array>> = {};
        STAT_KEYS.forEach((key, s) => {
          entry[key] = this.pDist[p.gi * NS + s];
        });
        pd[p.data.id] = entry;
      }
      const td: Record<string, Record<TeamKey, Float32Array>> = {};
      [home, away].forEach((m, k) => {
        const entry = {} as Record<TeamKey, Float32Array>;
        TEAM_KEYS.forEach((key, t) => {
          entry[key] = this.tDist[k * NT + t];
        });
        td[m.code] = entry;
      });
      const played: Record<string, Uint8Array> = {};
      for (const p of this.all) played[p.data.id] = this.playedDist[p.gi];
      result.distributions = { players: pd, teams: td, played, margin };
    }
    return result;
  }

  /** Played mask for a player, for use with probOver(). */
  playedMask(playerId: string): Uint8Array | undefined {
    const p = this.all.find((x) => x.data.id === playerId);
    return p ? this.playedDist[p.gi] : undefined;
  }

  /** Replays the simulated game closest to the typical outcome, with a drive log. */
  private pickFeatured(): SimResult["featured"] {
    const N = this.iterations;
    const hp = this.tDist[T_POINTS];
    const ap = this.tDist[NT + T_POINTS];
    const hy = this.tDist[T_YARDS];
    const ay = this.tDist[NT + T_YARDS];
    const med = (a: Float32Array) => summarize(a).median;
    const mhp = med(hp), map = med(ap), mhy = med(hy), may = med(ay);

    let best = 0;
    let bestD = Infinity;
    const scan = Math.min(N, 3000);
    for (let i = 0; i < scan; i++) {
      const dScore = (hp[i] - mhp) ** 2 + (ap[i] - map) ** 2;
      const dYds = ((hy[i] - mhy) / 20) ** 2 + ((ay[i] - may) / 20) ** 2;
      const dist = dScore + dYds;
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    }
    const drives: DriveLog[] = [];
    this.playGame(new Rng(hashSeed(this.seed, best + 1)), drives);
    return { index: best, homePoints: this.tstat[T_POINTS], awayPoints: this.tstat[NT + T_POINTS], drives };
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Convenience: run a full simulation synchronously. */
export function simulateGame(game: GameData, options: SimOptions = {}): SimResult {
  const sim = new GameSimulator(game, options);
  sim.runBatch(sim.iterations);
  return sim.finish();
}
