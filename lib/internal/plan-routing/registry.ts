/**
 * Process-global registry of plan routers. Mirrors the guardian
 * registry pattern: downstream extensions register routers
 * through the public surface, and the plan workflow consults
 * them here when placing a plan document.
 */

import type { PlanRouter } from "../../plan-routing/types.js";

let routers: PlanRouter[] = [];

/** Record a router. Routers are consulted in registration order. */
export function recordPlanRouter(router: PlanRouter): void {
	routers.push(router);
}

/** The registered routers, in registration order. */
export function planRouters(): PlanRouter[] {
	return routers;
}

/** Clear all registered routers. For tests. */
export function resetPlanRouters(): void {
	routers = [];
}
