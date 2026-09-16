# Sim Simma

An NFL game simulator.

Pick an upcoming NFL game, press Simulate, and the app plays it 10,000 times in
your browser. It projects passing, rushing, and receiving yards per player, team
sacks, and the chance each defense scores a touchdown.

Best-guess model. Not betting advice.

## How it fits together

| Part | Where it runs | What it does |
|---|---|---|
| `pipeline/` | GitHub Actions (Python) | Pulls nflverse data, builds game files, uploads to Workers KV and D1 |
| `functions/` + `worker/api.ts` | Cloudflare Pages Functions | `/api/*` routes that serve game data from KV and D1 |
| `worker/index.ts` | (superseded) | Old Workers+assets entry; kept for reference |
| `src/sim/` | Browser (Web Worker) | The simulation engine |
| `src/app/` | Browser (React) | The UI |
| `migrations/` | Cloudflare D1 | Database tables |

## One-time setup

1. Install tools: Node 20 or newer, Python 3.12, and `npm install`.
2. Log in: `npx wrangler login`
3. Create storage:
   - `npx wrangler d1 create sim-simma-db` then paste the returned `database_id` into `wrangler.jsonc`
   - `npx wrangler kv namespace create sim-simma-data` then paste the returned `id` into `wrangler.jsonc` under `kv_namespaces`
4. Create tables: `npx wrangler d1 migrations apply sim-simma-db --remote`
5. In the Cloudflare dashboard, create an API token with **D1 Edit** and **Workers KV Edit** (add **Workers Scripts Edit** if your deploy tool uses the same token).
6. In GitHub, add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
7. In GitHub Actions, run **data-pipeline** once (leave dry run unchecked) so data exists.

## Deploy

Build command: `npm run build`
Deploy command: `npx wrangler pages deploy dist --project-name sim-simma`

Or both at once: `npm run deploy`

Live URL: https://sim-simma.pages.dev/

The data pipeline runs separately on its own schedule and does not need a redeploy.

## Run locally

```bash
pip install -r pipeline/requirements.txt
npm run data          # build this week's data into build/data
npm run seed:local    # load it into local D1/KV
npm run preview       # build the app and serve app + API via Pages dev
```

For hot reload while editing the UI, run `npm run dev:api` in one terminal and
`npm run dev` in another, then open the Vite URL.

## Command-line sims

```bash
npm run sim -- build/data/games/2026_02_DET_BUF.json
npm run sim -- build/data/games --summary --no-market
```

## API

| Route | Returns |
|---|---|
| `GET /api/health` | Liveness check |
| `GET /api/meta` | Current season, week, and data timestamp |
| `GET /api/status` | Last pipeline run |
| `GET /api/weeks?season=2026` | Weeks with published games |
| `GET /api/weeks/2026/2` | Games in a week |
| `GET /api/games/2026_02_DET_BUF` | Full game file plus news adjustments |

Responses are edge-cached for up to 5 minutes, so new data can take that long to appear.

## Tuning

- `pipeline/config.py`: season weighting, injury discounts, default usage shares
- `src/sim/engine.ts` (`ENGINE_TUNING`): clock, kickoffs, 4th-down calls, Vegas weight

## News adjustments (Phase 3)

Rows in the D1 `news_adjustments` table are applied automatically:

- `availability_adj`: replacement chance the player plays (0 to 1)
- `target_share_adj`, `carry_share_adj`: multipliers (0.9 = 10% fewer)
- `confidence`: 0 to 1, scales how much of the change is applied
