import { useEffect, useState } from "react";
import type { SimResult, TeamResult } from "../../sim/engine";
import { f1, pct } from "../format";
import PlayerList from "./PlayerList";
import TeamMark from "./TeamMark";

const SCORING = new Set(["Touchdown", "Field goal", "Pick-six", "Fumble return TD", "Safety"]);
const DEFENSIVE = new Set(["Pick-six", "Fumble return TD", "Safety"]);

export default function Results({ result }: { result: SimResult }) {
  const home = result.teams[result.home];
  const away = result.teams[result.away];

  return (
    <section className="results">
      <div className="scoreboard">
        <ScoreSide team={away} />
        <ScoreSide team={home} />
      </div>
      <Field result={result} home={home} away={away} />
      <div className="defense">
        <DefenseCard team={away} opponent={home} />
        <DefenseCard team={home} opponent={away} />
      </div>
      <PlayerList key={`${result.gameId}-${result.seed}`} result={result} />
      <TypicalGame result={result} />
      <div className="notes">
        <p>
          Ran {result.iterations.toLocaleString()} games in {(result.elapsedMs / 1000).toFixed(1)} seconds. Player numbers
          count only games the player suited up for.
        </p>
        {result.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
        <p>Best-guess model built on historical play-by-play, depth charts, and injury reports. Not betting advice.</p>
      </div>
    </section>
  );
}

function ScoreSide({ team }: { team: TeamResult }) {
  return (
    <div className="score-side">
      <div className="code">
        <TeamMark team={team.team} size="sm" />
        {team.isHome ? <span className="home-tag">home</span> : null}
      </div>
      <div className="pts">{f1(team.points.mean)}</div>
      <div className="sub">
        Middle half of games: {team.points.p25} to {team.points.p75}
      </div>
    </div>
  );
}

function Field({ result, home, away }: { result: SimResult; home: TeamResult; away: TeamResult }) {
  const homeWin = home.winProb + result.tieProb / 2;
  const target = 9 + homeWin * 82;
  const [left, setLeft] = useState(50);
  useEffect(() => {
    setLeft(50);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setLeft(target)));
    return () => cancelAnimationFrame(id);
  }, [target, result.seed]);

  const fav = homeWin >= 0.5 ? home : away;
  return (
    <div className="field-wrap">
      <div className="field" role="img" aria-label={`${fav.team} wins ${pct(fav.winProb)} of simulations`}>
        <div className="ez left">{away.team}</div>
        <div className="mid" />
        <div className="ez right">{home.team}</div>
        <div className="ball" style={{ left: `${left}%` }} />
      </div>
      <div className="field-caption">
        <span>
          <b>{pct(away.winProb)}</b> {away.team} wins
        </span>
        {result.tieProb > 0.001 && <span>Tie {pct(result.tieProb, 1)}</span>}
        <span>
          {home.team} wins <b>{pct(home.winProb)}</b>
        </span>
      </div>
    </div>
  );
}

function DefenseCard({ team, opponent }: { team: TeamResult; opponent: TeamResult }) {
  return (
    <div className="def-card">
      <h3>{team.team} defense</h3>
      <dl>
        <dt>Sacks</dt>
        <dd>{f1(team.sacks.mean)}</dd>
        <dt>3 or more sacks</dt>
        <dd>{pct(team.sacks3PlusProb)}</dd>
        <dt>Scores a TD</dt>
        <dd>{pct(team.defTdProb, 1)}</dd>
        <dt>Takeaways forced</dt>
        <dd>{f1(opponent.turnovers.mean)}</dd>
      </dl>
    </div>
  );
}

function TypicalGame({ result }: { result: SimResult }) {
  const { featured } = result;
  const plays = featured.drives.filter((d) => SCORING.has(d.result));
  return (
    <>
      <h3 className="section">Most typical simulated game</h3>
      <p className="pmeta">
        Final {result.away} {featured.awayPoints}, {result.home} {featured.homePoints}. Scoring plays:
      </p>
      <ul className="drives">
        {plays.map((d, i) => {
          const defScore = DEFENSIVE.has(d.result);
          const scorer = defScore ? (d.team === result.home ? result.away : result.home) : d.team;
          return (
            <li key={i}>
              <span className="clock">{d.clockStart}</span>
              <span>
                <span className="tm">{scorer}</span> {defScore && <span className="def">{d.result} </span>}
                {d.detail ?? d.result}
              </span>
              <span className="sc">
                {d.scoreAway} to {d.scoreHome}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
