// Legacy Workers + Static Assets entry. Superseded by Pages + Pages Functions
// (see functions/api/[[path]].ts and wrangler.jsonc pages_build_output_dir).
// Kept so the shared API in ./api.ts can still be exercised via `wrangler dev`
// if you temporarily restore a Workers main config.

import { handleApiRequest, type Env as ApiEnv } from "./api";

export interface Env extends ApiEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    return handleApiRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
