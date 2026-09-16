"""
Tunable settings for the Sim Simma data pipeline.

Everything in here is a modeling assumption, not a fact. Treat these as
starting values and tune them once you have backtesting in place (Phase 4).
"""

# ---------------------------------------------------------------------------
# Output layout
# ---------------------------------------------------------------------------
DATA_VERSION = "v1"          # KV key prefix, bump when the JSON shape changes
KV_NAMESPACE = "sim-simma-data"  # wrangler kv namespace title; binding DATA in wrangler.jsonc
D1_DATABASE = "sim-simma-db"   # must match wrangler.jsonc d1_databases.database_name

# ---------------------------------------------------------------------------
# Season blending
# ---------------------------------------------------------------------------
# Weight applied to each prior-season game relative to a current-season game.
PRIOR_SEASON_WEIGHT = 0.5
# Prior-season weight fades linearly to the floor over this many current weeks.
PRIOR_FADE_WEEKS = 8
# Prior-season data never fully disappears (helps players returning from injury).
PRIOR_SEASON_WEIGHT_FLOOR = 0.05

# ---------------------------------------------------------------------------
# Regression toward league / position averages (pseudo-sample sizes)
# Bigger number = more skeptical of small samples.
# ---------------------------------------------------------------------------
REC_REG_TARGETS = 40
RUSH_REG_CARRIES = 60
QB_REG_DROPBACKS = 150
TEAM_REG_GAMES = 6

# ---------------------------------------------------------------------------
# Usage shares
# ---------------------------------------------------------------------------
# Blend between the season-weighted share and the last-N-games share.
RECENT_GAMES = 3
SHARE_RECENT_BLEND = 0.35
# Players with fewer games than this are shrunk toward the depth-slot default.
SHARE_MIN_GAMES = 3
SHARE_DEFAULT_PSEUDO_GAMES = 2
# Listed players typically do not capture 100% of a team's volume.
TARGET_COVERAGE = 0.97
CARRY_COVERAGE = 0.97

# Depth-chart slots pulled into each game file.
DEPTH_LIMITS = {"QB": 2, "RB": 4, "FB": 1, "WR": 6, "TE": 3}

# Default shares for players with no NFL history, by position and depth rank.
DEFAULT_TARGET_SHARE = {
    "QB": [0.0, 0.0],
    "RB": [0.10, 0.05, 0.02, 0.01],
    "FB": [0.02],
    "WR": [0.22, 0.17, 0.12, 0.05, 0.03, 0.02],
    "TE": [0.15, 0.06, 0.03],
}
DEFAULT_CARRY_SHARE = {
    "QB": [0.06, 0.0],
    "RB": [0.50, 0.25, 0.08, 0.03],
    "FB": [0.01],
    "WR": [0.02, 0.01, 0.01, 0.0, 0.0, 0.0],
    "TE": [0.0, 0.0, 0.0],
}

# ---------------------------------------------------------------------------
# Availability (probability the player suits up and plays a normal role)
# ---------------------------------------------------------------------------
# Game-status designation from the final injury report.
REPORT_AVAILABILITY = {
    "Out": 0.0,
    "Doubtful": 0.15,
    "Questionable": 0.80,
}
# Practice participation when no final game status exists yet (Wed/Thu).
PRACTICE_AVAILABILITY = {
    "Did Not Participate In Practice": 0.70,
    "Limited Participation in Practice": 0.90,
    "Full Participation in Practice": 1.0,
}
# Questionable players, adjusted by their last practice status.
QUESTIONABLE_BY_PRACTICE = {
    "Did Not Participate In Practice": 0.55,
    "Limited Participation in Practice": 0.80,
    "Full Participation in Practice": 0.92,
}
# Player listed Out last week with no report yet this week.
CARRIED_OUT_AVAILABILITY = 0.50
# Roster statuses that mean the player is not available at all.
INACTIVE_ROSTER_STATUSES = {"RES", "INA", "CUT", "RET", "EXE", "DEV"}

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------
EXPLOSIVE_RUSH_YARDS = 20
EXPLOSIVE_REC_YARDS = 20
QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90]
NEUTRAL_WP_LOW = 0.20
NEUTRAL_WP_HIGH = 0.80
