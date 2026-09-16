import { useEffect, useState } from "react";
import type { GameWithAdjustments } from "../api";
import { favoriteText, kickoff } from "../format";
import { expectedWeather, type WeatherSummary } from "../weather";
import TeamMark from "./TeamMark";

export default function Matchup({ game }: { game: GameWithAdjustments }) {
  const implied = game.lines.implied_points;
  const news = game.adjustments ?? [];
  const [wx, setWx] = useState<WeatherSummary | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setWx(null);
    expectedWeather({
      gameId: game.game_id,
      homeTeam: game.home_team,
      gameday: game.gameday,
      roof: game.venue?.roof ?? null,
      temp: game.venue?.temp ?? null,
      wind: game.venue?.wind ?? null,
      signal: ac.signal,
    }).then(setWx);
    return () => ac.abort();
  }, [game]);

  return (
    <section className="matchup" aria-live="polite">
      <h2 className="matchup-title">
        <TeamMark team={game.away_team} size="lg" />
        <span className="at">at</span>
        <TeamMark team={game.home_team} size="lg" />
      </h2>
      <ul className="facts">
        <li>
          Kickoff <b>{kickoff(game.gameday, game.gametime)}</b>
        </li>
        <li>
          Spread <b>{favoriteText(game.home_team, game.away_team, game.lines.spread_home)}</b>
        </li>
        <li>
          Total <b>{game.lines.total ?? "none"}</b>
        </li>
        {implied && (
          <li>
            Vegas implies{" "}
            <b>
              {game.away_team} {implied.away}, {game.home_team} {implied.home}
            </b>
          </li>
        )}
        {game.venue.stadium && <li>{game.venue.stadium}</li>}
        <li className="wx-fact">
          Weather{" "}
          {wx ? (
            <b>
              <span className="wx-emoji" aria-hidden="true">
                {wx.emoji}
              </span>{" "}
              {wx.label}
            </b>
          ) : (
            <b>Loading…</b>
          )}
        </li>
      </ul>
      {news.length > 0 && (
        <details>
          <summary>
            {news.length} news update{news.length === 1 ? "" : "s"} applied
          </summary>
          <ul className="news">
            {news.map((n, i) => (
              <li key={`${n.gsis_id}-${i}`}>
                <b>{n.player_name ?? n.gsis_id}</b> {n.summary}{" "}
                {n.source_url && (
                  <a href={n.source_url} target="_blank" rel="noreferrer">
                    Source
                  </a>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
