"""Assemble the standalone test page: engine bundle + one week of game files."""
import json, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
games_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "build/data/games"
engine_js = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "build/nflsim.min.js"
out = Path(sys.argv[3]) if len(sys.argv) > 3 else root / "build/sim-lab.html"

games = [json.loads(p.read_text()) for p in sorted(games_dir.glob("*.json"))]
games.sort(key=lambda g: (g["gameday"], g["gametime"] or "", g["game_id"]))
week = games[0]["week"]
data_date = games[0]["data"]["generated_at"][:10]

tpl = (root / "demo/template.html").read_text()
html = (
    tpl.replace("__WEEK__", str(week))
    .replace("__DATA_DATE__", data_date)
    .replace("__GAMES_JSON__", json.dumps(games, separators=(",", ":")).replace("</", "<\\/"))
    .replace("/*__ENGINE__*/", engine_js.read_text().replace("</script", "<\\/script"))
)
out.write_text(html)
print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB, {len(games)} games)")
