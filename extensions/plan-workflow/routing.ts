/**
 * Plan-file routing for the extension: turning a plan into a
 * filename, resolving the durable default directory, and
 * consulting any registered routers to decide the destination.
 *
 * The default is anchored to the main worktree root rather than
 * the session's cwd, so a plan written from inside a linked
 * worktree still lands in the main checkout and survives the
 * worktree being reaped.
 */

import * as path from "node:path";
import { planRouters } from "../../lib/internal/plan-routing/registry.js";
import type { PlanRouteRequest } from "../../lib/plan-routing/types.js";

/** Longest slug we put in a filename, to keep paths sane. */
const MAX_SLUG = 60;

/** Lowercase, hyphenate and trim a title into a filename slug. */
export function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG)
		.replace(/-+$/, "");
}

/** The filename for a plan: its id, plus a slug of the title. */
export function planFileName(id: string, title: string): string {
	const slug = slugify(title);
	return slug ? `${id}-${slug}.md` : `${id}.md`;
}

/**
 * The durable default plan directory, derived from the common
 * git directory (`git rev-parse --git-common-dir`). That path
 * is the main `.git` for every worktree, so its parent is the
 * main worktree root and the plan never lands somewhere
 * reapable.
 */
export function defaultPlanDir(gitCommonDir: string): string {
	return path.join(path.dirname(gitCommonDir), ".pi", "plans");
}

/**
 * Resolve the directory a plan should be written to. Consults
 * registered routers in order, taking the first that returns a
 * directory, and falls back to the durable default otherwise.
 */
export async function resolvePlanDir(
	request: PlanRouteRequest,
	fallbackDir: string,
): Promise<string> {
	for (const router of planRouters()) {
		const dir = await router(request);
		if (dir) return dir;
	}
	return fallbackDir;
}
