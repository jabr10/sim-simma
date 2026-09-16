// Run the simulator from the command line against a pipeline game file.
// Usage:
//   npx tsx scripts/sim-cli.ts build/data/games/2026_02_DET_BUF.json
//   npx tsx scripts/sim-cli.ts build/data/games --iterations 5000 --no-market
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { simulateGame } from "../src/sim/engine";
import type { GameData } from "../src/sim/types";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("Usage: sim-cli <game.json | games-dir> [--iterations N] [--seed N] [--no-market] [--summary]");
  process.exit(1);
}
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const iterations = Number(flag("--iterations") ?? 10000);
const seed = flag("--seed") ? Number(flag("--seed")) : 12345;
const calibrateToMarket = !args.includes("--no-market");
const summaryOnly = args.includes("--summary");

const files = statSync(target).isDirectory()
  ? readdirSync(target).filter((f) => f.endsWith(".json")).sort().map((f) => join(target, f))
  : [target];

const f1 = (v: number) => v.toFixed(1);
let totSim = 0, totVegas = 0, totPlays = 0, n = 0;

for (const file of files) {
  const game = JSON.parse(readFileSync(file, "utf8")) as GameData;
  const r = simulateGame(game, { iterations, seed, calibrateToMarket, keepDistributions: false });
  const h = r.teams[r.home];
  const a = r.teams[r.away];
  const vegasTotal = game.lines.total;
  const simTotal = h.points.mean + a.points.mean;
  totSim += simTotal;
  totVegas += vegasTotal ?? simTotal;
  totPlays += h.plays.mean + a.plays.mean;
  n++;

  console.log(
    `\n${r.away} @ ${r.home}  |  ${r.away} ${f1(a.points.mean)} - ${f1(h.points.mean)} ${r.home}` +
      `  |  total ${f1(simTotal)} (Vegas ${vegasTotal ?? "n/a"})  |  ${r.home} win ${(h.winProb * 100).toFixed(1)}%` +
      `  |  ${r.elapsedMs} ms`,
  );
  if (summaryOnly) continue;

  for (const t of [a, h]) {
    console.log(
      `  ${t.team}: plays ${f1(t.plays.mean)}  yds ${f1(t.yards.mean)}  sacks(def) ${f1(t.sacks.mean)}` +
        `  P(3+ sacks) ${(t.sacks3PlusProb * 100).toFixed(0)}%  P(def TD) ${(t.defTdProb * 100).toFixed(1)}%` +
        `  TO ${f1(t.turnovers.mean)}  eff ${t.efficiency}  implied ${t.impliedPoints ?? "n/a"}`,
    );
  }
  for (const p of r.players) {
    if (p.playedPct === 0) continue;
    const s = p.stats;
    if (p.pos === "QB") {
      if (!s.passAtt || s.passAtt.mean < 3) continue;
      console.log(
        `  ${p.team} QB ${p.name.padEnd(22)} start ${(p.playedPct * 100).toFixed(0)}%  ` +
          `${f1(s.cmp!.mean)}/${f1(s.passAtt.mean)}  ${f1(s.passYds!.mean)} yds (med ${s.passYds!.median}, ${s.passYds!.p25}-${s.passYds!.p75})  ` +
          `${f1(s.passTd!.mean)} TD  ${f1(s.ints!.mean)} INT  rush ${f1(s.rushYds!.mean)}`,
      );
    } else {
      const rec = s.recYds?.mean ?? 0;
      const rush = s.rushYds?.mean ?? 0;
      if (rec < 5 && rush < 5) continue;
      console.log(
        `  ${p.team} ${p.pos}${p.depthRank} ${p.name.padEnd(22)} play ${(p.playedPct * 100).toFixed(0).padStart(3)}%  ` +
          `rec ${f1(s.rec!.mean)}/${f1(s.targets!.mean)} for ${f1(rec)} (med ${s.recYds!.median})  ` +
          `rush ${f1(s.rushAtt!.mean)} for ${f1(rush)}  anyTD ${(p.anyTdProb * 100).toFixed(0)}%`,
      );
    }
  }
  console.log("  Featured game:", `${r.away} ${r.featured.awayPoints} - ${r.featured.homePoints} ${r.home}`);
  for (const d of r.featured.drives) {
    if (["Touchdown", "Field goal", "Pick-six", "Fumble return TD", "Safety"].includes(d.result)) {
      console.log(`    ${d.clockStart} ${d.team} ${d.result}${d.detail ? ": " + d.detail : ""} (${r.away} ${d.scoreAway}-${d.scoreHome} ${r.home})`);
    }
  }
}

if (n > 1) {
  console.log(`\nAverages over ${n} games: sim total ${f1(totSim / n)}  Vegas total ${f1(totVegas / n)}  plays/game ${f1(totPlays / n)}`);
}
