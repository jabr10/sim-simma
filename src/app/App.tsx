import { useCallback, useEffect, useRef, useState } from "react";
import { runSimulation } from "../sim/client";
import type { SimResult } from "../sim/engine";
import { api, overridesFrom } from "./api";
import type { GameWithAdjustments, Meta, WeekIndex } from "./api";
import { GAME_UNAVAILABLE, isUpcomingGame, upcomingGames } from "../lib/upcoming";
import GamePicker from "./components/GamePicker";
import Matchup from "./components/Matchup";
import Results from "./components/Results";
import InstallTip from "./components/InstallTip";

const GAME_ID = /^(\d{4})_(\d{2})_[A-Z]{2,3}_[A-Z]{2,3}$/;

function gameFromUrl(): { id: string; season: number; week: number } | null {
  const id = new URLSearchParams(window.location.search).get("game");
  const m = id ? GAME_ID.exec(id) : null;
  return m && id ? { id, season: Number(m[1]), week: Number(m[2]) } : null;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export default function App() {
  const initial = useRef(gameFromUrl());
  const [meta, setMeta] = useState<Meta | null>(null);
  const [weeks, setWeeks] = useState<number[]>([]);
  const [week, setWeek] = useState<number | null>(null);
  const [index, setIndex] = useState<WeekIndex | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [game, setGame] = useState<GameWithAdjustments | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [iterations, setIterations] = useState(10000);
  const [market, setMarket] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const simAbort = useRef<AbortController | null>(null);

  // 1. Meta and available weeks
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    api
      .meta(ac.signal)
      .then(async (m) => {
        setMeta(m);
        const fromUrl = initial.current;
        setWeek(fromUrl && fromUrl.season === m.season ? fromUrl.week : m.week);
        try {
          const w = await api.weeks(m.season, ac.signal);
          const list = w.weeks.map((x) => x.week);
          setWeeks(list.length ? list : [m.week]);
        } catch (err) {
          if (!isAbort(err)) setWeeks([m.week]);
        }
      })
      .catch((err) => {
        if (!isAbort(err)) setError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [reloadKey]);

  // 2. Week index — only keep games that have not kicked off yet
  useEffect(() => {
    if (!meta || week === null) return;
    const ac = new AbortController();
    setIndex(null);
    api
      .week(meta.season, week, ac.signal)
      .then((idx) => {
        const games = upcomingGames(idx.games);
        setIndex({ ...idx, games });
        const requested = initial.current;
        const requestedId =
          requested && requested.season === meta.season && requested.week === week ? requested.id : null;
        if (requested && requested.season === meta.season && requested.week === week) initial.current = null;
        if (requestedId && !games.some((g) => g.game_id === requestedId)) {
          setUnavailable(GAME_UNAVAILABLE);
        }
        setGameId((current) => {
          const want = current && games.some((g) => g.game_id === current) ? current : requestedId;
          if (want && games.some((g) => g.game_id === want)) return want;
          return games[0]?.game_id ?? null;
        });
      })
      .catch((err) => {
        if (!isAbort(err)) setError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [meta, week]);

  // 3. Selected game
  useEffect(() => {
    if (!gameId) {
      setGame(null);
      setResult(null);
      setProgress(0);
      const url = new URL(window.location.href);
      if (url.searchParams.has("game")) {
        url.searchParams.delete("game");
        window.history.replaceState(null, "", url);
      }
      return;
    }
    const ac = new AbortController();
    simAbort.current?.abort();
    setGame(null);
    setResult(null);
    setProgress(0);
    api
      .game(gameId, ac.signal)
      .then((g) => {
        if (!isUpcomingGame(g)) {
          setUnavailable(GAME_UNAVAILABLE);
          setGame(null);
          setGameId(null);
          return;
        }
        setGame(g);
      })
      .catch((err) => {
        if (isAbort(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message === GAME_UNAVAILABLE) {
          setUnavailable(GAME_UNAVAILABLE);
          setGame(null);
          setGameId(null);
          return;
        }
        setError(message);
      });

    const url = new URL(window.location.href);
    url.searchParams.set("game", gameId);
    window.history.replaceState(null, "", url);
    return () => ac.abort();
  }, [gameId]);

  useEffect(() => () => simAbort.current?.abort(), []);

  const simulate = useCallback(async () => {
    if (!game || running) return;
    if (!isUpcomingGame(game)) {
      setUnavailable(GAME_UNAVAILABLE);
      setGame(null);
      setResult(null);
      setGameId(null);
      return;
    }
    simAbort.current?.abort();
    const ac = new AbortController();
    simAbort.current = ac;
    setRunning(true);
    setProgress(0);
    setError(null);
    try {
      const r = await runSimulation(game, {
        iterations,
        calibrateToMarket: market,
        overrides: overridesFrom(game),
        onProgress: setProgress,
        signal: ac.signal,
      });
      if (!ac.signal.aborted) setResult(r);
    } catch (err) {
      if (!isAbort(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (simAbort.current === ac) setRunning(false);
    }
  }, [game, running, iterations, market]);

  const goHome = useCallback(() => {
    simAbort.current?.abort();
    setRunning(false);
    setResult(null);
    setProgress(0);
    setError(null);
    setUnavailable(null);
    initial.current = null;
    const homeWeek = meta?.week ?? week;
    if (homeWeek !== null && homeWeek !== undefined) setWeek(homeWeek);
    const first = index?.games[0]?.game_id ?? null;
    // If week changes, the week effect will pick a game; if not, reset to first chip.
    if (homeWeek === week) setGameId(first);
    else setGameId(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [meta, week, index]);

  const refresh = useCallback(() => {
    simAbort.current?.abort();
    setRunning(false);
    setResult(null);
    setProgress(0);
    setError(null);
    setUnavailable(null);
    setReloadKey((k) => k + 1);
  }, []);

  const selectGame = useCallback((id: string) => {
    setUnavailable(null);
    setGameId(id);
  }, []);

  const noData = error !== null && meta === null;
  const canSim = game !== null && isUpcomingGame(game);

  return (
    <div className="wrap">
      <InstallTip />
      <header className="top">
        <div className="topline">
          <div className="brand">
            <h1>Sim Simma</h1>
            <p className="tagline">Play every NFL game 10,000 times</p>
          </div>
          <div className="top-actions">
            <div className="nav-btns" role="group" aria-label="Navigation">
              <button type="button" className="nav-btn" onClick={goHome} title="Home">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M4 11.5 12 4l8 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M7 10.5V20h10v-9.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Home</span>
              </button>
              <button type="button" className="nav-btn" onClick={refresh} disabled={running} title="Refresh data">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M20 12a8 8 0 1 1-2.2-5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Refresh</span>
              </button>
            </div>
            {meta && week !== null && weeks.length > 1 ? (
              <label className="week-select">
                Week
                <select value={week} disabled={running} onChange={(e) => setWeek(Number(e.target.value))}>
                  {weeks.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              meta && week !== null && <span className="week-tag">Week {week}</span>
            )}
          </div>
        </div>
        <p>
          Pick a game and run it. Each run plays the game thousands of times using nflverse data
          {meta ? ` updated ${new Date(meta.generated_at).toLocaleString()}` : ""}.
        </p>
      </header>

      {noData && (
        <div className="banner error" role="alert">
          <p>{error}</p>
          <p className="pmeta">If this is a new setup, run the data-pipeline workflow in GitHub Actions first.</p>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </button>
        </div>
      )}

      {unavailable && (
        <div className="banner" role="status">
          <p>{unavailable}</p>
          <button type="button" onClick={() => setUnavailable(null)}>
            Dismiss
          </button>
        </div>
      )}

      {meta && !index && !error && <p className="skeleton">Loading games</p>}
      {index && <GamePicker games={index.games} selectedId={gameId} disabled={running} onSelect={selectGame} />}

      {game && canSim ? <Matchup game={game} /> : gameId && index ? <p className="skeleton">Loading matchup</p> : null}

      {game && canSim && (
        <>
          <div className="controls run-row">
            <button className="run" type="button" onClick={simulate} disabled={running}>
              {running ? "Simulating" : result ? "Simulate again" : "Simulate game"}
            </button>
            <label>
              Games
              <select value={iterations} disabled={running} onChange={(e) => setIterations(Number(e.target.value))}>
                <option value={2000}>2,000</option>
                <option value={5000}>5,000</option>
                <option value={10000}>10,000</option>
              </select>
            </label>
            <label>
              <input type="checkbox" checked={market} disabled={running} onChange={(e) => setMarket(e.target.checked)} />
              Lean on Vegas lines
            </label>
          </div>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${(progress * 100).toFixed(1)}%` }} />
          </div>
        </>
      )}

      {error && !noData && (
        <div className="banner error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {result && game && canSim && result.gameId === game.game_id ? (
        <Results result={result} />
      ) : (
        game &&
        canSim && (
          <section className="results">
            <p className="empty">
              Tap Simulate game to see projected scores, player yards, sacks, and defensive TD chances.
            </p>
          </section>
        )
      )}
    </div>
  );
}
