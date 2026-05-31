/**
 * Public registration for plan routers.
 */

import { recordPlanRouter } from "../internal/plan-routing/registry.js";
import type { PlanRouter } from "./types.js";

/**
 * Register a router that decides where plan documents are
 * written. Call from a downstream extension to route plans into
 * a custom location. Routers are consulted in registration
 * order; the first to return a directory wins, and returning
 * undefined defers to the next router or the durable default.
 */
export function registerPlanRouter(router: PlanRouter): void {
	recordPlanRouter(router);
}
