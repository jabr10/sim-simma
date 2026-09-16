import { useEffect, useState } from "react";
import type { WeekGame } from "../api";
import { kickoff } from "../format";
import { expectedWeather, type WeatherSummary } from "../weather";

interface Props {
  games: WeekGame[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}

export default function GamePicker({ games, selectedId, disabled, onSelect }: Props) {
  const [weather, setWeather] = useState<Record<string, WeatherSummary>>({});

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        games.map(async (g) => {
          const home = g.home_team;
          const summary = await expectedWeather({
            gameId: g.game_id,
            homeTeam: home,
            gameday: g.gameday,
            roof: g.roof,
            signal: ac.signal,
          });
          return [g.game_id, summary] as const;
        }),
      );
      if (!cancelled) setWeather(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [games]);

  return (
    <nav className="games" aria-label="Games this week">
      {games.map((g) => {
        const w = weather[g.game_id];
        return (
          <button
            key={g.game_id}
            type="button"
            className="game-chip"
            aria-pressed={g.game_id === selectedId}
            disabled={disabled && g.game_id !== selectedId}
            onClick={() => onSelect(g.game_id)}
          >
            <div className="teams">
              {g.away_team} at {g.home_team}
            </div>
            <div className="when">{kickoff(g.gameday, g.gametime)}</div>
            <div className="wx" title={w?.label}>
              {w ? (
                <>
                  <span className="wx-emoji" aria-hidden="true">
                    {w.emoji}
                  </span>
                  <span className="wx-label">{w.label}</span>
                </>
              ) : (
                <span className="wx-label muted">Weather…</span>
              )}
            </div>
          </button>
        );
      })}
    </nav>
  );
}
