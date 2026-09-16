"""
Sim Simma data pipeline.

Pulls nflverse data (via nflreadpy), builds team profiles, player baselines,
availability, and usage projections, then writes JSON + SQL files that
publish.py uploads to Cloudflare Workers KV and D1.

Output layout (under --out):
  meta.json
  league/{season}.json
  weeks/{season}/{week}.json
  games/{game_id}.json
  d1/week_{season}_{week}.sql

Usage:
  python pipeline/build_data.py --out build/data
  python pipeline/build_data.py --out build/data --season 2026 --week 3
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
from pathlib import Path

import nflreadpy as nfl
import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C  # noqa: E402

SKILL_POS = ["QB", "RB", "FB", "WR", "TE"]


def log(msg: str) -> None:
    print(f"[build] {msg}", flush=True)


def clean(value, digits: int = 4):
    """Make a value JSON friendly (round floats, drop NaN/inf)."""
    if value is None:
        return None
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return round(value, digits)
    return value


def safe_div(num, den, default=None):
    if num is None or den is None or den == 0:
        return default
    return num / den


def regress(rate, weight, league_rate, k):
    """Shrink a rate toward the league rate using a pseudo-sample of size k."""
    if league_rate is None:
        return rate
    if rate is None or weight is None or weight <= 0:
        return league_rate
    return (rate * weight + league_rate * k) / (weight + k)


# ---------------------------------------------------------------------------
# Arguments and week detection
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Build Sim Simma data files")
    ap.add_argument("--out", default="build/data", help="Output directory")
    ap.add_argument("--season", type=int, default=int(os.environ["SEASON"]) if os.environ.get("SEASON") else None)
    ap.add_argument("--week", type=int, default=int(os.environ["WEEK"]) if os.environ.get("WEEK") else None)
    return ap.parse_args()


def detect_target_week(schedule: pl.DataFrame, season: int) -> int | None:
    """First regular-season week that still has an unplayed game."""
    pending = schedule.filter(
        (pl.col("season") == season)
        & (pl.col("game_type") == "REG")
        & pl.col("result").is_null()
    )
    if pending.is_empty():
        return None
    return int(pending["week"].min())


# ---------------------------------------------------------------------------
# Play-level table
# ---------------------------------------------------------------------------
def build_plays(pbp: pl.DataFrame, season: int, prior_w: float) -> pl.DataFrame:
    p = pbp.filter(
        (pl.col("season_type") == "REG")
        & pl.col("play_type").is_in(["pass", "run"])
        & (pl.col("two_point_attempt").fill_null(0) == 0)
        & pl.col("posteam").is_not_null()
    )
    return p.with_columns(
        pl.when(pl.col("season") == season).then(1.0).otherwise(prior_w).alias("w"),
        (pl.col("qb_dropback").fill_null(0) == 1).alias("is_dropback"),
        (pl.col("sack").fill_null(0) == 1).alias("is_sack"),
        (pl.col("qb_scramble").fill_null(0) == 1).alias("is_scramble"),
        ((pl.col("rush_attempt").fill_null(0) == 1) & (pl.col("qb_scramble").fill_null(0) != 1)).alias("is_design_run"),
        ((pl.col("pass_attempt").fill_null(0) == 1) & (pl.col("sack").fill_null(0) != 1)).alias("is_attempt"),
        (pl.col("complete_pass").fill_null(0) == 1).alias("is_complete"),
        (pl.col("interception").fill_null(0) == 1).alias("is_int"),
        (pl.col("fumble_lost").fill_null(0) == 1).alias("is_fumble_lost"),
        ((pl.col("touchdown").fill_null(0) == 1) & (pl.col("td_team") == pl.col("posteam"))).alias("is_off_td"),
        ((pl.col("return_touchdown").fill_null(0) == 1) & (pl.col("td_team") == pl.col("defteam"))).alias("is_def_td"),
        (
            pl.col("wp").is_between(C.NEUTRAL_WP_LOW, C.NEUTRAL_WP_HIGH)
            & pl.col("down").is_in([1, 2])
        ).fill_null(False).alias("is_neutral"),
        pl.col("yards_gained").fill_null(0.0).alias("yds"),
    )


# ---------------------------------------------------------------------------
# Team profiles
# ---------------------------------------------------------------------------
TEAM_GAME_AGGS = [
    pl.len().alias("plays"),
    pl.col("is_dropback").sum().alias("dropbacks"),
    pl.col("is_sack").sum().alias("sacks"),
    pl.col("is_scramble").sum().alias("scrambles"),
    pl.col("is_attempt").sum().alias("attempts"),
    (pl.col("is_attempt") & pl.col("is_complete")).sum().alias("completions"),
    pl.when(pl.col("is_attempt") & pl.col("is_complete")).then(pl.col("yds")).otherwise(0.0).sum().alias("pass_yds"),
    (pl.col("is_attempt") & pl.col("is_int")).sum().alias("ints"),
    (pl.col("is_attempt") & pl.col("is_off_td")).sum().alias("pass_tds"),
    pl.col("is_design_run").sum().alias("design_runs"),
    pl.when(pl.col("is_design_run")).then(pl.col("yds")).otherwise(0.0).sum().alias("rush_yds"),
    (pl.col("is_design_run") & pl.col("is_off_td")).sum().alias("rush_tds"),
    pl.when(pl.col("is_scramble")).then(pl.col("yds")).otherwise(0.0).sum().alias("scramble_yds"),
    pl.col("is_fumble_lost").sum().alias("fumbles_lost"),
    pl.col("is_def_td").sum().alias("def_tds"),
    pl.col("is_neutral").sum().alias("neutral_plays"),
    (pl.col("is_neutral") & pl.col("is_dropback")).sum().alias("neutral_dropbacks"),
    pl.col("w").first().alias("w"),
    pl.col("season").first().alias("season"),
    pl.col("week").first().alias("week"),
]

TEAM_SUM_COLS = [
    "plays", "dropbacks", "sacks", "scrambles", "attempts", "completions", "pass_yds",
    "ints", "pass_tds", "design_runs", "rush_yds", "rush_tds", "scramble_yds",
    "fumbles_lost", "def_tds", "neutral_plays", "neutral_dropbacks",
]


def team_game_table(plays: pl.DataFrame, side: str) -> pl.DataFrame:
    key = "posteam" if side == "off" else "defteam"
    return plays.group_by(["game_id", key]).agg(TEAM_GAME_AGGS).rename({key: "team"})


def weighted_totals(tg: pl.DataFrame, by: list[str] | None) -> pl.DataFrame:
    aggs = [(pl.col(c) * pl.col("w")).sum().alias(c) for c in TEAM_SUM_COLS]
    aggs.append(pl.col("w").sum().alias("games_w"))
    aggs.append(pl.len().alias("games"))
    if by:
        return tg.group_by(by).agg(aggs)
    return tg.select(aggs)


def rates_from_totals(r: dict) -> dict:
    g = r["games_w"]
    return {
        "games_w": g,
        "plays_pg": safe_div(r["plays"], g),
        "dropback_rate": safe_div(r["dropbacks"], r["plays"]),
        "neutral_dropback_rate": safe_div(r["neutral_dropbacks"], r["neutral_plays"]),
        "sack_rate": safe_div(r["sacks"], r["dropbacks"]),
        "scramble_rate": safe_div(r["scrambles"], r["dropbacks"]),
        "scramble_ypa": safe_div(r["scramble_yds"], r["scrambles"]),
        "cmp_rate": safe_div(r["completions"], r["attempts"]),
        "ypa": safe_div(r["pass_yds"], r["attempts"]),
        "int_rate": safe_div(r["ints"], r["attempts"]),
        "pass_td_rate": safe_div(r["pass_tds"], r["attempts"]),
        "ypc": safe_div(r["rush_yds"], r["design_runs"]),
        "rush_td_rate": safe_div(r["rush_tds"], r["design_runs"]),
        "fumble_lost_rate": safe_div(r["fumbles_lost"], r["plays"]),
        "def_td_pg": safe_div(r["def_tds"], g),
        "turnovers_pg": safe_div((r["ints"] or 0) + (r["fumbles_lost"] or 0), g),
        "return_td_per_turnover": safe_div(r["def_tds"], (r["ints"] or 0) + (r["fumbles_lost"] or 0)),
    }


RATE_KEYS_FOR_MULT = [
    "plays_pg", "dropback_rate", "neutral_dropback_rate", "sack_rate", "scramble_rate",
    "cmp_rate", "ypa", "int_rate", "pass_td_rate", "ypc", "rush_td_rate",
    "fumble_lost_rate", "def_td_pg", "turnovers_pg",
]


def with_multipliers(team_rates: dict, league_rates: dict) -> dict:
    """Add a regressed multiplier vs league (1.0 = league average)."""
    g = team_rates.get("games_w") or 0.0
    shrink = g / (g + C.TEAM_REG_GAMES) if g > 0 else 0.0
    mult = {}
    for k in RATE_KEYS_FOR_MULT:
        t, lg = team_rates.get(k), league_rates.get(k)
        if t is None or not lg:
            mult[k] = 1.0
        else:
            mult[k] = clean(1.0 + (t / lg - 1.0) * shrink)
    out = {k: clean(v) for k, v in team_rates.items()}
    out["vs_league"] = mult
    return out


def points_per_game(schedule: pl.DataFrame, season: int, prior_w: float) -> dict:
    played = schedule.filter((pl.col("game_type") == "REG") & pl.col("result").is_not_null())
    home = played.select(
        pl.col("season"), pl.col("home_team").alias("team"),
        pl.col("home_score").alias("pf"), pl.col("away_score").alias("pa"),
    )
    away = played.select(
        pl.col("season"), pl.col("away_team").alias("team"),
        pl.col("away_score").alias("pf"), pl.col("home_score").alias("pa"),
    )
    both = pl.concat([home, away]).with_columns(
        pl.when(pl.col("season") == season).then(1.0).otherwise(prior_w).alias("w")
    )
    agg = both.group_by("team").agg(
        ((pl.col("pf") * pl.col("w")).sum() / pl.col("w").sum()).alias("pf_pg"),
        ((pl.col("pa") * pl.col("w")).sum() / pl.col("w").sum()).alias("pa_pg"),
    )
    return {r["team"]: {"pf_pg": clean(r["pf_pg"]), "pa_pg": clean(r["pa_pg"])} for r in agg.iter_rows(named=True)}


# ---------------------------------------------------------------------------
# Player baselines
# ---------------------------------------------------------------------------
def weighted_sd(values: pl.Expr, weights: pl.Expr) -> pl.Expr:
    mean = (values * weights).sum() / weights.sum()
    return (((values - mean) ** 2 * weights).sum() / weights.sum()).sqrt()


def quantile_list(df: pl.DataFrame, id_col: str, val_col: str) -> dict:
    if df.is_empty():
        return {}
    exprs = [pl.col(val_col).quantile(q, "linear").alias(f"q{int(q * 100)}") for q in C.QUANTILES]
    qdf = df.group_by(id_col).agg(exprs)
    cols = [f"q{int(q * 100)}" for q in C.QUANTILES]
    return {r[id_col]: [clean(r[c], 1) for c in cols] for r in qdf.iter_rows(named=True)}


def receiving_baselines(plays: pl.DataFrame) -> dict:
    t = plays.filter(pl.col("is_attempt") & pl.col("receiver_player_id").is_not_null())
    agg = t.group_by("receiver_player_id").agg(
        pl.col("w").sum().alias("targets_w"),
        pl.len().alias("targets_n"),
        (pl.col("w") * pl.col("is_complete")).sum().alias("catches_w"),
        (pl.col("w") * pl.col("is_complete") * pl.col("yds")).sum().alias("rec_yds_w"),
        (pl.col("w") * (pl.col("is_complete") & pl.col("is_off_td"))).sum().alias("rec_tds_w"),
        (pl.col("w") * pl.col("air_yards").fill_null(0.0)).sum().alias("air_w"),
    )
    catches = t.filter(pl.col("is_complete"))
    sd = catches.group_by("receiver_player_id").agg(
        weighted_sd(pl.col("yds"), pl.col("w")).alias("ypr_sd"),
        (pl.col("w") * (pl.col("yds") >= C.EXPLOSIVE_REC_YARDS)).sum().alias("explosive_w"),
    )
    q = quantile_list(catches, "receiver_player_id", "yds")
    out = {}
    for r in agg.join(sd, on="receiver_player_id", how="left").iter_rows(named=True):
        pid = r["receiver_player_id"]
        out[pid] = {
            "targets_w": r["targets_w"],
            "targets_n": r["targets_n"],
            "catch_rate": safe_div(r["catches_w"], r["targets_w"]),
            "ypr": safe_div(r["rec_yds_w"], r["catches_w"]),
            "ypr_sd": r["ypr_sd"],
            "td_rate": safe_div(r["rec_tds_w"], r["targets_w"]),
            "adot": safe_div(r["air_w"], r["targets_w"]),
            "explosive_rate": safe_div(r["explosive_w"], r["catches_w"]),
            "catch_yds_q": q.get(pid),
        }
    return out


def rushing_baselines(plays: pl.DataFrame) -> dict:
    t = plays.filter(pl.col("is_design_run") & pl.col("rusher_player_id").is_not_null())
    agg = t.group_by("rusher_player_id").agg(
        pl.col("w").sum().alias("carries_w"),
        pl.len().alias("carries_n"),
        (pl.col("w") * pl.col("yds")).sum().alias("rush_yds_w"),
        (pl.col("w") * pl.col("is_off_td")).sum().alias("rush_tds_w"),
        (pl.col("w") * pl.col("is_fumble_lost")).sum().alias("fumbles_w"),
        (pl.col("w") * (pl.col("yds") >= C.EXPLOSIVE_RUSH_YARDS)).sum().alias("explosive_w"),
        weighted_sd(pl.col("yds"), pl.col("w")).alias("ypc_sd"),
    )
    q = quantile_list(t, "rusher_player_id", "yds")
    out = {}
    for r in agg.iter_rows(named=True):
        pid = r["rusher_player_id"]
        out[pid] = {
            "carries_w": r["carries_w"],
            "carries_n": r["carries_n"],
            "ypc": safe_div(r["rush_yds_w"], r["carries_w"]),
            "ypc_sd": r["ypc_sd"],
            "td_rate": safe_div(r["rush_tds_w"], r["carries_w"]),
            "fumble_lost_rate": safe_div(r["fumbles_w"], r["carries_w"]),
            "explosive_rate": safe_div(r["explosive_w"], r["carries_w"]),
            "carry_yds_q": q.get(pid),
        }
    return out


def passing_baselines(plays: pl.DataFrame) -> dict:
    # Attempts and sacks carry passer_player_id. Scrambles carry rusher_player_id.
    dropbacks = plays.filter(pl.col("is_dropback")).with_columns(
        pl.when(pl.col("is_scramble"))
        .then(pl.col("rusher_player_id"))
        .otherwise(pl.col("passer_player_id"))
        .alias("qb_id")
    ).filter(pl.col("qb_id").is_not_null())

    agg = dropbacks.group_by("qb_id").agg(
        pl.col("w").sum().alias("dropbacks_w"),
        pl.len().alias("dropbacks_n"),
        (pl.col("w") * pl.col("is_attempt")).sum().alias("att_w"),
        (pl.col("w") * (pl.col("is_attempt") & pl.col("is_complete"))).sum().alias("cmp_w"),
        (pl.col("w") * pl.when(pl.col("is_attempt") & pl.col("is_complete")).then(pl.col("yds")).otherwise(0.0)).sum().alias("pass_yds_w"),
        (pl.col("w") * (pl.col("is_attempt") & pl.col("is_int"))).sum().alias("int_w"),
        (pl.col("w") * (pl.col("is_attempt") & pl.col("is_off_td"))).sum().alias("td_w"),
        (pl.col("w") * pl.col("is_sack")).sum().alias("sack_w"),
        (pl.col("w") * pl.col("is_scramble")).sum().alias("scramble_w"),
        (pl.col("w") * pl.when(pl.col("is_scramble")).then(pl.col("yds")).otherwise(0.0)).sum().alias("scramble_yds_w"),
        (pl.col("w") * pl.when(pl.col("is_sack")).then(pl.col("yds")).otherwise(0.0)).sum().alias("sack_yds_w"),
    )
    comps = dropbacks.filter(pl.col("is_attempt") & pl.col("is_complete"))
    sd = comps.group_by("qb_id").agg(weighted_sd(pl.col("yds"), pl.col("w")).alias("ypcmp_sd"))

    out = {}
    for r in agg.join(sd, on="qb_id", how="left").iter_rows(named=True):
        out[r["qb_id"]] = {
            "dropbacks_w": r["dropbacks_w"],
            "dropbacks_n": r["dropbacks_n"],
            "cmp_rate": safe_div(r["cmp_w"], r["att_w"]),
            "ypa": safe_div(r["pass_yds_w"], r["att_w"]),
            "yds_per_cmp": safe_div(r["pass_yds_w"], r["cmp_w"]),
            "yds_per_cmp_sd": r["ypcmp_sd"],
            "int_rate": safe_div(r["int_w"], r["att_w"]),
            "td_rate": safe_div(r["td_w"], r["att_w"]),
            "sack_rate": safe_div(r["sack_w"], r["dropbacks_w"]),
            "sack_yds": safe_div(r["sack_yds_w"], r["sack_w"]),
            "scramble_rate": safe_div(r["scramble_w"], r["dropbacks_w"]),
            "scramble_ypa": safe_div(r["scramble_yds_w"], r["scramble_w"]),
        }
    return out


def position_league_averages(rec: dict, rush: dict, pos_of: dict) -> dict:
    """Volume-weighted league averages by position for regression targets."""
    acc: dict[str, dict[str, float]] = {}
    for pid, r in rec.items():
        pos = pos_of.get(pid)
        if pos not in SKILL_POS or not r["targets_w"]:
            continue
        a = acc.setdefault(pos, {})
        tw = r["targets_w"]
        cw = tw * (r["catch_rate"] or 0)
        a["tw"] = a.get("tw", 0) + tw
        a["cw"] = a.get("cw", 0) + cw
        a["ryds"] = a.get("ryds", 0) + cw * (r["ypr"] or 0)
        a["rtd"] = a.get("rtd", 0) + tw * (r["td_rate"] or 0)
    for pid, r in rush.items():
        pos = pos_of.get(pid)
        if pos not in SKILL_POS or not r["carries_w"]:
            continue
        a = acc.setdefault(pos, {})
        cw = r["carries_w"]
        a["cr"] = a.get("cr", 0) + cw
        a["cyds"] = a.get("cyds", 0) + cw * (r["ypc"] or 0)
        a["ctd"] = a.get("ctd", 0) + cw * (r["td_rate"] or 0)
    out = {}
    for pos, a in acc.items():
        out[pos] = {
            "catch_rate": safe_div(a.get("cw"), a.get("tw")),
            "ypr": safe_div(a.get("ryds"), a.get("cw")),
            "rec_td_rate": safe_div(a.get("rtd"), a.get("tw")),
            "ypc": safe_div(a.get("cyds"), a.get("cr")),
            "rush_td_rate": safe_div(a.get("ctd"), a.get("cr")),
        }
    return out


# ---------------------------------------------------------------------------
# Usage shares (per game, portable across team changes)
# ---------------------------------------------------------------------------
def usage_shares(plays: pl.DataFrame, snaps: pl.DataFrame, id_map: pl.DataFrame,
                 season: int, prior_w: float) -> dict:
    team_game = plays.group_by(["game_id", "posteam"]).agg(
        pl.col("is_attempt").sum().alias("team_targets"),
        pl.col("is_design_run").sum().alias("team_carries"),
        pl.col("is_dropback").sum().alias("team_dropbacks"),
    ).rename({"posteam": "team"})

    tgt = plays.filter(pl.col("is_attempt") & pl.col("receiver_player_id").is_not_null()) \
        .group_by(["game_id", "receiver_player_id"]).agg(pl.len().alias("targets")) \
        .rename({"receiver_player_id": "gsis_id"})
    car = plays.filter(pl.col("is_design_run") & pl.col("rusher_player_id").is_not_null()) \
        .group_by(["game_id", "rusher_player_id"]).agg(pl.len().alias("carries")) \
        .rename({"rusher_player_id": "gsis_id"})
    db = plays.filter(pl.col("is_dropback")).with_columns(
        pl.when(pl.col("is_scramble")).then(pl.col("rusher_player_id")).otherwise(pl.col("passer_player_id")).alias("gsis_id")
    ).filter(pl.col("gsis_id").is_not_null()).group_by(["game_id", "gsis_id"]).agg(pl.len().alias("dropbacks"))

    games = snaps.filter((pl.col("game_type") == "REG") & (pl.col("offense_snaps") > 0)) \
        .join(id_map, left_on="pfr_player_id", right_on="pfr_id", how="inner") \
        .select(["game_id", "season", "week", "team", "gsis_id", "offense_pct"]) \
        .unique(subset=["game_id", "gsis_id"])

    g = (
        games.join(team_game, on=["game_id", "team"], how="inner")
        .join(tgt, on=["game_id", "gsis_id"], how="left")
        .join(car, on=["game_id", "gsis_id"], how="left")
        .join(db, on=["game_id", "gsis_id"], how="left")
        .with_columns(
            pl.col("targets").fill_null(0),
            pl.col("carries").fill_null(0),
            pl.col("dropbacks").fill_null(0),
            pl.when(pl.col("season") == season).then(1.0).otherwise(prior_w).alias("w"),
        )
        .with_columns(
            (pl.col("targets") / pl.col("team_targets")).fill_nan(0.0).alias("tgt_share"),
            (pl.col("carries") / pl.col("team_carries")).fill_nan(0.0).alias("car_share"),
            (pl.col("dropbacks") / pl.col("team_dropbacks")).fill_nan(0.0).alias("db_share"),
        )
        .sort(["gsis_id", "season", "week"])
    )

    season_avg = g.group_by("gsis_id").agg(
        pl.len().alias("games"),
        (pl.col("season") == season).sum().alias("games_current"),
        pl.col("w").sum().alias("games_w"),
        ((pl.col("tgt_share") * pl.col("w")).sum() / pl.col("w").sum()).alias("target_share"),
        ((pl.col("car_share") * pl.col("w")).sum() / pl.col("w").sum()).alias("carry_share"),
        ((pl.col("db_share") * pl.col("w")).sum() / pl.col("w").sum()).alias("dropback_share"),
        ((pl.col("offense_pct") * pl.col("w")).sum() / pl.col("w").sum()).alias("snap_pct"),
        pl.col("team").last().alias("last_team"),
    )
    recent = g.group_by("gsis_id").agg(
        pl.col("tgt_share").tail(C.RECENT_GAMES).mean().alias("recent_target_share"),
        pl.col("car_share").tail(C.RECENT_GAMES).mean().alias("recent_carry_share"),
        pl.col("offense_pct").tail(C.RECENT_GAMES).mean().alias("recent_snap_pct"),
    )
    return {r["gsis_id"]: r for r in season_avg.join(recent, on="gsis_id", how="left").iter_rows(named=True)}


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------
def availability_for(pid: str, inj_week: dict, inj_prev: dict, roster_status: str | None) -> dict:
    if roster_status in C.INACTIVE_ROSTER_STATUSES:
        return {"availability": 0.0, "report": None, "practice": None, "injury": None,
                "note": f"Roster status {roster_status}"}

    row = inj_week.get(pid)
    if row:
        report = row["report_status"]
        practice = row["practice_status"]
        injury = row["report_primary_injury"] or row["practice_primary_injury"]
        resting = (row["practice_primary_injury"] or "").lower().startswith("not injury related")
        if report == "Questionable":
            a = C.QUESTIONABLE_BY_PRACTICE.get(practice, C.REPORT_AVAILABILITY["Questionable"])
        elif report in C.REPORT_AVAILABILITY:
            a = C.REPORT_AVAILABILITY[report]
        elif resting:
            a = 1.0
        else:
            a = C.PRACTICE_AVAILABILITY.get(practice, 1.0)
        note = "Rest day, not injury related" if resting and not report else None
        return {"availability": a, "report": report, "practice": practice, "injury": injury, "note": note}

    prev = inj_prev.get(pid)
    if prev and prev["report_status"] == "Out":
        return {"availability": C.CARRIED_OUT_AVAILABILITY, "report": None, "practice": None,
                "injury": prev["report_primary_injury"],
                "note": "Out last week, no report yet this week"}

    return {"availability": 1.0, "report": None, "practice": None, "injury": None, "note": None}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    args = parse_args()
    out = Path(args.out)
    season = args.season or nfl.get_current_season()
    prior = season - 1
    log(f"season={season} prior={prior}")

    schedule = nfl.load_schedules([prior, season])
    week = args.week or detect_target_week(schedule, season)
    if week is None:
        log("No unplayed regular-season games found. Nothing to build.")
        return
    log(f"target week={week}")

    pbp = nfl.load_pbp([prior, season])
    cur_weeks_played = int(
        pbp.filter((pl.col("season") == season) & (pl.col("season_type") == "REG") & (pl.col("week") < week))["week"].max() or 0
    )
    # Only use data from before the target week (keeps re-runs of past weeks honest).
    pbp = pbp.filter((pl.col("season") < season) | (pl.col("week") < week))
    prior_w = max(
        C.PRIOR_SEASON_WEIGHT_FLOOR,
        C.PRIOR_SEASON_WEIGHT * max(0.0, 1.0 - cur_weeks_played / C.PRIOR_FADE_WEEKS),
    )
    log(f"current weeks played={cur_weeks_played} prior-season weight={prior_w:.3f}")

    plays = build_plays(pbp, season, prior_w)
    log(f"plays used={plays.height}")

    snaps = nfl.load_snap_counts([prior, season]).filter(
        (pl.col("season") < season) | (pl.col("week") < week)
    )
    players = nfl.load_players()
    id_map = players.select(["gsis_id", "pfr_id"]).drop_nulls().unique(subset=["pfr_id"])
    pos_of = dict(players.select(["gsis_id", "position"]).drop_nulls().iter_rows())
    headshot_of = dict(players.select(["gsis_id", "headshot"]).drop_nulls().iter_rows())

    injuries = nfl.load_injuries([season])
    inj_week = {r["gsis_id"]: r for r in injuries.filter(pl.col("week") == week).iter_rows(named=True)}
    inj_prev = {r["gsis_id"]: r for r in injuries.filter(pl.col("week") == week - 1).iter_rows(named=True)}

    rosters = nfl.load_rosters_weekly([season])
    roster_week = rosters.filter(pl.col("week") == min(week, int(rosters["week"].max())))
    roster_status = dict(roster_week.select(["gsis_id", "status"]).drop_nulls().iter_rows())

    depth = nfl.load_depth_charts([season])
    latest_dt = depth.group_by("team").agg(pl.col("dt").max().alias("max_dt"))
    depth = depth.join(latest_dt, on="team").filter(pl.col("dt") == pl.col("max_dt"))
    missing_ids = depth.filter(pl.col("pos_abb").is_in(SKILL_POS) & pl.col("gsis_id").is_null()).height
    depth = (
        depth.filter(pl.col("pos_abb").is_in(SKILL_POS) & pl.col("gsis_id").is_not_null())
        .sort(["team", "pos_abb", "pos_rank"])
        .unique(subset=["team", "gsis_id"], keep="first", maintain_order=True)
    )
    if missing_ids:
        log(f"warning: {missing_ids} depth chart rows without gsis_id skipped")
    depth_dt = str(depth["dt"].max()) if depth.height else None

    # ---- Team profiles -----------------------------------------------------
    off_tg = team_game_table(plays, "off")
    def_tg = team_game_table(plays, "def")
    league_tot = weighted_totals(off_tg, None).row(0, named=True)
    league = rates_from_totals(league_tot)
    league_rates_clean = {k: clean(v) for k, v in league.items()}

    off_rates = {r["team"]: rates_from_totals(r) for r in weighted_totals(off_tg, ["team"]).iter_rows(named=True)}
    def_rates = {r["team"]: rates_from_totals(r) for r in weighted_totals(def_tg, ["team"]).iter_rows(named=True)}
    ppg = points_per_game(schedule, season, prior_w)

    # ---- Player baselines --------------------------------------------------
    rec = receiving_baselines(plays)
    rush = rushing_baselines(plays)
    qb = passing_baselines(plays)
    pos_avg = position_league_averages(rec, rush, pos_of)
    usage = usage_shares(plays, snaps, id_map, season, prior_w)
    log(f"baselines: receivers={len(rec)} rushers={len(rush)} qbs={len(qb)} usage={len(usage)}")

    lg_qb = {
        "cmp_rate": league["cmp_rate"], "ypa": league["ypa"], "int_rate": league["int_rate"],
        "td_rate": league["pass_td_rate"], "sack_rate": league["sack_rate"],
        "scramble_rate": league["scramble_rate"],
    }

    def player_block(pid: str, name: str, pos: str, rank: int, team: str) -> dict:
        pa = pos_avg.get(pos, {})
        u = usage.get(pid)
        r = rec.get(pid)
        ru = rush.get(pid)
        q = qb.get(pid)
        slot = rank - 1

        def default(table):
            vals = table.get(pos, [])
            return vals[slot] if 0 <= slot < len(vals) else 0.0

        def_tgt, def_car = default(C.DEFAULT_TARGET_SHARE), default(C.DEFAULT_CARRY_SHARE)
        if u:
            games = u["games"]
            tgt = (1 - C.SHARE_RECENT_BLEND) * u["target_share"] + C.SHARE_RECENT_BLEND * (u["recent_target_share"] or 0)
            car = (1 - C.SHARE_RECENT_BLEND) * u["carry_share"] + C.SHARE_RECENT_BLEND * (u["recent_carry_share"] or 0)
            if games < C.SHARE_MIN_GAMES:
                k = C.SHARE_DEFAULT_PSEUDO_GAMES
                tgt = (games * tgt + k * def_tgt) / (games + k)
                car = (games * car + k * def_car) / (games + k)
            usage_out = {
                "games": games, "games_current": u["games_current"],
                "target_share": clean(u["target_share"]), "carry_share": clean(u["carry_share"]),
                "dropback_share": clean(u["dropback_share"]),
                "recent_target_share": clean(u["recent_target_share"]),
                "recent_carry_share": clean(u["recent_carry_share"]),
                "snap_pct": clean(u["snap_pct"]), "recent_snap_pct": clean(u["recent_snap_pct"]),
                "last_team": u["last_team"], "changed_team": u["last_team"] != team,
                "base_target_share": clean(tgt), "base_carry_share": clean(car),
                "source": "history",
            }
        else:
            usage_out = {
                "games": 0, "games_current": 0,
                "base_target_share": clean(def_tgt), "base_carry_share": clean(def_car),
                "source": "depth_default",
            }

        receiving = None
        if pos != "QB":
            tw = r["targets_w"] if r else 0.0
            receiving = {
                "targets": r["targets_n"] if r else 0,
                "catch_rate": clean(regress(r and r["catch_rate"], tw, pa.get("catch_rate"), C.REC_REG_TARGETS)),
                "ypr": clean(regress(r and r["ypr"], tw, pa.get("ypr"), C.REC_REG_TARGETS)),
                "ypr_sd": clean(r["ypr_sd"]) if r else None,
                "td_rate": clean(regress(r and r["td_rate"], tw, pa.get("rec_td_rate"), C.REC_REG_TARGETS)),
                "adot": clean(r["adot"]) if r else None,
                "explosive_rate": clean(r["explosive_rate"]) if r else None,
                "catch_yds_q": r["catch_yds_q"] if r else None,
            }

        cw = ru["carries_w"] if ru else 0.0
        rushing = {
            "carries": ru["carries_n"] if ru else 0,
            "ypc": clean(regress(ru and ru["ypc"], cw, pa.get("ypc"), C.RUSH_REG_CARRIES)),
            "ypc_sd": clean(ru["ypc_sd"]) if ru else None,
            "td_rate": clean(regress(ru and ru["td_rate"], cw, pa.get("rush_td_rate"), C.RUSH_REG_CARRIES)),
            "fumble_lost_rate": clean(ru["fumble_lost_rate"]) if ru else None,
            "explosive_rate": clean(ru["explosive_rate"]) if ru else None,
            "carry_yds_q": ru["carry_yds_q"] if ru else None,
        }

        passing = None
        if pos == "QB":
            dw = q["dropbacks_w"] if q else 0.0
            passing = {
                "dropbacks": q["dropbacks_n"] if q else 0,
                **{k: clean(regress(q and q[k], dw, lg_qb[k], C.QB_REG_DROPBACKS)) for k in lg_qb},
                "yds_per_cmp": clean(q["yds_per_cmp"]) if q else None,
                "yds_per_cmp_sd": clean(q["yds_per_cmp_sd"]) if q else None,
                "sack_yds": clean(q["sack_yds"]) if q else None,
                "scramble_ypa": clean(q["scramble_ypa"]) if q else clean(league["scramble_ypa"]),
            }

        return {
            "id": pid, "name": name, "pos": pos, "depth_rank": rank, "team": team,
            "headshot": headshot_of.get(pid),
            "status": availability_for(pid, inj_week, inj_prev, roster_status.get(pid)),
            "usage": usage_out, "receiving": receiving, "rushing": rushing, "passing": passing,
        }

    def team_block(team: str) -> dict:
        tdepth = depth.filter(pl.col("team") == team)
        plist = []
        for pos in SKILL_POS:
            rows = tdepth.filter(pl.col("pos_abb") == pos).sort("pos_rank").head(C.DEPTH_LIMITS[pos])
            for i, r in enumerate(rows.iter_rows(named=True), start=1):
                plist.append(player_block(r["gsis_id"], r["player_name"], pos, i, team))

        # Expected shares: availability-adjusted, normalized to coverage.
        for key, cov in (("target", C.TARGET_COVERAGE), ("carry", C.CARRY_COVERAGE)):
            raw = [p["usage"][f"base_{key}_share"] * p["status"]["availability"] for p in plist]
            total = sum(raw)
            for p, v in zip(plist, raw):
                p["usage"][f"expected_{key}_share"] = clean(v / total * cov) if total > 0 else 0.0

        # QB start probabilities. Anything left over goes to an unlisted QB.
        qbs = [p for p in plist if p["pos"] == "QB"]
        remaining = 1.0
        for p in qbs:
            prob = remaining * p["status"]["availability"]
            p["usage"]["start_prob"] = clean(prob)
            remaining -= prob
        unlisted_qb_prob = clean(max(0.0, remaining))

        off = with_multipliers(off_rates.get(team, {"games_w": 0}), league)
        dfn = with_multipliers(def_rates.get(team, {"games_w": 0}), league)
        return {
            "team": team,
            "points": ppg.get(team),
            "unlisted_qb_prob": unlisted_qb_prob,
            "offense": off,
            "defense": dfn,
            "players": plist,
        }

    # ---- Game files --------------------------------------------------------
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    games = schedule.filter((pl.col("season") == season) & (pl.col("week") == week) & (pl.col("game_type") == "REG")).sort(["gameday", "gametime"])
    week_index = []
    d1_games = []
    player_count = 0

    for g in games.iter_rows(named=True):
        spread, total = g["spread_line"], g["total_line"]
        implied = None
        if spread is not None and total is not None:
            # nflverse: positive spread_line = home team favored.
            implied = {"home": clean(total / 2 + spread / 2, 2), "away": clean(total / 2 - spread / 2, 2)}

        home, away = team_block(g["home_team"]), team_block(g["away_team"])
        player_count += len(home["players"]) + len(away["players"])
        key = f"{C.DATA_VERSION}/games/{g['game_id']}.json"
        game_doc = {
            "game_id": g["game_id"], "season": season, "week": week,
            "gameday": g["gameday"], "gametime": g["gametime"],
            "home_team": g["home_team"], "away_team": g["away_team"],
            "played": g["result"] is not None,
            "lines": {"spread_home": spread, "total": total, "implied_points": implied,
                      "home_moneyline": g["home_moneyline"], "away_moneyline": g["away_moneyline"]},
            "venue": {"stadium": g["stadium"], "roof": g["roof"], "surface": g["surface"],
                      "temp": g["temp"], "wind": g["wind"]},
            "context": {"div_game": bool(g["div_game"]), "home_rest": g["home_rest"], "away_rest": g["away_rest"],
                        "home_qb_listed": g["home_qb_name"], "away_qb_listed": g["away_qb_name"]},
            "teams": {g["home_team"]: home, g["away_team"]: away},
            "league": league_rates_clean,
            "position_league": {p: {k: clean(v) for k, v in d.items()} for p, d in pos_avg.items()},
            "data": {"generated_at": now, "weeks_played": cur_weeks_played,
                     "prior_season_weight": clean(prior_w), "depth_chart_as_of": depth_dt},
        }
        write_json(out / "games" / f"{g['game_id']}.json", game_doc)
        week_index.append({
            "game_id": g["game_id"], "gameday": g["gameday"], "gametime": g["gametime"],
            "away_team": g["away_team"], "home_team": g["home_team"],
            "spread_home": spread, "total": total, "roof": g["roof"], "r2_key": key,
        })
        d1_games.append({**week_index[-1], "season": season, "week": week,
                         "temp": g["temp"], "wind": g["wind"]})

    write_json(out / "weeks" / str(season) / f"{week}.json",
               {"season": season, "week": week, "generated_at": now, "games": week_index})
    write_json(out / "league" / f"{season}.json",
               {"season": season, "through_week": cur_weeks_played, "league": league_rates_clean,
                "position_league": {p: {k: clean(v) for k, v in d.items()} for p, d in pos_avg.items()},
                "generated_at": now})
    write_json(out / "meta.json",
               {"data_version": C.DATA_VERSION, "season": season, "week": week,
                "generated_at": now, "games": len(week_index), "players": player_count,
                "sources": ["nflverse via nflreadpy"]})

    # ---- D1 SQL ------------------------------------------------------------
    teams_this_week = set(games["home_team"].to_list()) | set(games["away_team"].to_list())
    inj_rows = []
    for pid, r in inj_week.items():
        if r["team"] not in teams_this_week or not pid:
            continue
        a = availability_for(pid, inj_week, inj_prev, roster_status.get(pid))
        inj_rows.append({
            "season": season, "week": week, "team": r["team"], "gsis_id": pid,
            "full_name": r["full_name"], "position": r["position"],
            "report_status": r["report_status"], "practice_status": r["practice_status"],
            "primary_injury": r["report_primary_injury"] or r["practice_primary_injury"],
            "availability": a["availability"],
        })
    write_sql(out / "d1" / f"week_{season}_{week}.sql", season, week, now, d1_games, inj_rows, player_count)

    log(f"done: {len(week_index)} games, {player_count} players, {len(inj_rows)} injury rows -> {out}")


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------
def write_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, separators=(",", ":"), default=str), encoding="utf-8")


def sql_val(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return "NULL"
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def write_sql(path: Path, season: int, week: int, now: str, games: list, injuries: list, players: int) -> None:
    lines = [
        f"DELETE FROM games WHERE season = {season} AND week = {week};",
        f"DELETE FROM injuries WHERE season = {season} AND week = {week};",
    ]
    gcols = ["game_id", "season", "week", "gameday", "gametime", "away_team", "home_team",
             "spread_home", "total", "roof", "temp", "wind", "r2_key"]
    for g in games:
        vals = ", ".join(sql_val(g.get(c)) for c in gcols)
        lines.append(f"INSERT INTO games ({', '.join(gcols)}, updated_at) VALUES ({vals}, {sql_val(now)});")
    icols = ["season", "week", "team", "gsis_id", "full_name", "position",
             "report_status", "practice_status", "primary_injury", "availability"]
    for r in injuries:
        vals = ", ".join(sql_val(r.get(c)) for c in icols)
        lines.append(f"INSERT INTO injuries ({', '.join(icols)}, updated_at) VALUES ({vals}, {sql_val(now)});")
    lines.append(
        "INSERT INTO pipeline_runs (run_at, season, week, games, players, injuries, status) "
        f"VALUES ({sql_val(now)}, {season}, {week}, {len(games)}, {players}, {len(injuries)}, 'ok');"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
