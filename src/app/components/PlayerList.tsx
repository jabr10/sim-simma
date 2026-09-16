import { useMemo, useState } from "react";
import { probOver } from "../../sim/engine";
import type { PlayerResult, SimResult, StatKey } from "../../sim/engine";
import { f1, pct } from "../format";

const PRIMARY: Record<string, StatKey> = { QB: "passYds", RB: "rushYds", FB: "rushYds", WR: "recYds", TE: "recYds" };
const LABEL: Record<StatKey, string> = {
  passYds: "pass yds", passAtt: "attempts", cmp: "completions", passTd: "pass TD", ints: "INT", sacked: "sacked",
  rushYds: "rush yds", rushAtt: "carries", recYds: "rec yds", rec: "catches", targets: "targets", tds: "total TD",
};
const CHECK_KEYS: Record<string, StatKey[]> = {
  QB: ["passYds", "cmp", "passAtt", "passTd", "rushYds"],
  RB: ["rushYds", "rushAtt", "recYds", "rec"],
  FB: ["rushYds", "recYds"],
  WR: ["recYds", "rec", "targets", "rushYds"],
  TE: ["recYds", "rec", "targets"],
};

function orderValue(p: PlayerResult): number {
  const s = p.stats;
  const y = (s.passYds?.mean ?? 0) + (s.rushYds?.mean ?? 0) + (s.recYds?.mean ?? 0);
  return (p.pos === "QB" ? 1000 : 0) + y * p.playedPct;
}

export default function PlayerList({ result }: { result: SimResult }) {
  const [tab, setTab] = useState(result.away);
  const [open, setOpen] = useState<string | null>(null);

  const { list, maxY } = useMemo(() => {
    const rows = result.players
      .filter((p) => p.team === tab && p.playedPct > 0)
      .filter((p) => {
        const main = p.stats[PRIMARY[p.pos]];
        const other = p.pos === "RB" ? p.stats.recYds : p.stats.rushYds;
        return (main && main.mean >= 3) || (other && other.mean >= 8);
      })
      .sort((a, b) => orderValue(b) - orderValue(a));
    let max = 1;
    for (const p of rows) max = Math.max(max, p.stats[PRIMARY[p.pos]]?.p75 ?? 0);
    return { list: rows, maxY: max };
  }, [result, tab]);

  return (
    <>
      <h3 className="section">Player projections</h3>
      <div className="tabs" role="tablist">
        {[result.away, result.home].map((t) => (
          <button key={t} type="button" role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="head-row">
        <span>Player</span>
        <span>Median yards</span>
        <span>TD</span>
      </div>
      <ul className="players">
        {list.map((p) => (
          <PlayerRow
            key={p.id}
            player={p}
            result={result}
            maxY={maxY}
            open={open === p.id}
            onToggle={() => setOpen(open === p.id ? null : p.id)}
          />
        ))}
      </ul>
    </>
  );
}

interface RowProps {
  player: PlayerResult;
  result: SimResult;
  maxY: number;
  open: boolean;
  onToggle: () => void;
}

function PlayerRow({ player: p, result, maxY, open, onToggle }: RowProps) {
  const key = PRIMARY[p.pos];
  const s = p.stats[key] ?? { median: 0, p25: 0, p75: 0, mean: 0, p10: 0, p90: 0 };
  const lo = (Math.max(0, s.p25) / maxY) * 100;
  const hi = (Math.max(0, s.p75) / maxY) * 100;
  const flags: string[] = [];
  if (p.playedPct < 0.995) flags.push(`${p.pos === "QB" ? "starts" : "plays"} ${pct(p.playedPct)}`);

  return (
    <li className={`prow${open ? " open" : ""}`}>
      <button type="button" aria-expanded={open} onClick={onToggle}>
        <span>
          <span className="pname">{p.name}</span>
          <span className="pmeta">
            {p.pos}
            {p.depthRank}
            {p.statusNote && <span className="flag"> {p.statusNote}.</span>}
            {flags.length > 0 && <span className="flag"> {flags.join(", ")}</span>}
          </span>
        </span>
        <span className="pnum">
          <span className="big">{s.median}</span>
          <span className="unit">{LABEL[key]}</span>
          <span className="range" title={`Middle half: ${s.p25} to ${s.p75}`}>
            <span style={{ left: `${lo}%`, width: `${Math.max(2, hi - lo)}%` }} />
          </span>
        </span>
        {p.pos === "QB" && p.stats.passTd ? (
          <span className="ptd">
            <span className="big">{f1(p.stats.passTd.mean)}</span>
            <span className="unit">pass TD</span>
          </span>
        ) : (
          <span className="ptd">
            <span className="big">{pct(p.anyTdProb)}</span>
            <span className="unit">any TD</span>
          </span>
        )}
      </button>
      {open && (
        <div className="detail">
          <div className="statgrid">
            {(Object.keys(p.stats) as StatKey[]).map((k) => (
              <div key={k}>
                <span>{LABEL[k]}</span>
                <span>{f1(p.stats[k]!.mean)}</span>
              </div>
            ))}
          </div>
          <LineChecker player={p} result={result} />
        </div>
      )}
    </li>
  );
}

function LineChecker({ player: p, result }: { player: PlayerResult; result: SimResult }) {
  const options = (CHECK_KEYS[p.pos] ?? []).filter((k) => p.stats[k]);
  const [stat, setStat] = useState<StatKey | undefined>(options[0]);
  const [line, setLine] = useState(() => (options[0] ? Math.floor(p.stats[options[0]]!.median) + 0.5 : 0.5).toString());

  if (!stat || !result.distributions) return null;
  const dist = result.distributions.players[p.id]?.[stat];
  const played = result.distributions.played[p.id];
  const value = Number.parseFloat(line);
  const over = dist && Number.isFinite(value) ? probOver(dist, value, played) : null;

  return (
    <div className="checker">
      <label>
        Line check{" "}
        <select
          value={stat}
          onChange={(e) => {
            const next = e.target.value as StatKey;
            setStat(next);
            const m = p.stats[next];
            if (m) setLine((Math.floor(m.median) + 0.5).toString());
          }}
        >
          {options.map((k) => (
            <option key={k} value={k}>
              {LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <input
        type="number"
        inputMode="decimal"
        step="0.5"
        aria-label="Line"
        value={line}
        onChange={(e) => setLine(e.target.value)}
      />
      <output>{over === null ? "Enter a line" : `Over ${pct(over, 1)}, under ${pct(1 - over, 1)}`}</output>
    </div>
  );
}
