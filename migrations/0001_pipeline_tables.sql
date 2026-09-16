-- Migration: 0001_pipeline_tables
-- Tables written by the Python data pipeline (pipeline/build_data.py).

CREATE TABLE IF NOT EXISTS games (
  game_id      TEXT PRIMARY KEY,
  season       INTEGER NOT NULL,
  week         INTEGER NOT NULL,
  gameday      TEXT,
  gametime     TEXT,
  away_team    TEXT NOT NULL,
  home_team    TEXT NOT NULL,
  spread_home  REAL,
  total        REAL,
  roof         TEXT,
  temp         REAL,
  wind         REAL,
  r2_key       TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_season_week ON games (season, week);

CREATE TABLE IF NOT EXISTS injuries (
  season           INTEGER NOT NULL,
  week             INTEGER NOT NULL,
  team             TEXT NOT NULL,
  gsis_id          TEXT NOT NULL,
  full_name        TEXT,
  position         TEXT,
  report_status    TEXT,
  practice_status  TEXT,
  primary_injury   TEXT,
  availability     REAL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (season, week, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_injuries_team ON injuries (season, week, team);

-- Written later by the Worker news parser (Phase 3). Created now so the
-- API can join against it from day one.
CREATE TABLE IF NOT EXISTS news_adjustments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  season             INTEGER NOT NULL,
  week               INTEGER NOT NULL,
  team               TEXT,
  gsis_id            TEXT,
  player_name        TEXT,
  availability_adj   REAL,
  target_share_adj   REAL,
  carry_share_adj    REAL,
  confidence         REAL,
  summary            TEXT,
  source_url         TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_week ON news_adjustments (season, week, team);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at    TEXT NOT NULL,
  season    INTEGER NOT NULL,
  week      INTEGER NOT NULL,
  games     INTEGER,
  players   INTEGER,
  injuries  INTEGER,
  status    TEXT
);
