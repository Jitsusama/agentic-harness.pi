/**
 * Plan-file routing.
 *
 * Public entry point for deciding where plan documents are
 * written. Downstream packages register a PlanRouter to route
 * plans into a custom location; the plan workflow consults the
 * registered routers and falls back to a durable default.
 */

export { registerPlanRouter } from "./register.js";
export type { PlanRouteRequest, PlanRouter } from "./types.js";
