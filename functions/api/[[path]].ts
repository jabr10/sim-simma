// Pages Functions catch-all for /api/* — ports the Worker router via shared logic.
import { handleApiRequest, type Env } from "../../worker/api";

export const onRequest: PagesFunction<Env> = async (context) => {
  return handleApiRequest(context.request, context.env, context);
};
