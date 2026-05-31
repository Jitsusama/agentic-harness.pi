/**
 * Public types for plan-file routing. Downstream packages
 * implement a PlanRouter to decide where plan documents are
 * written, so a personal setup can route plans into its own
 * structured home without that structure ever being baked into
 * this package.
 */

/** What a router is told about a plan that needs a home. */
export interface PlanRouteRequest {
	/** The plan's stable id (PLAN-YYYYMMDD-xxx). */
	id: string;
	/** The plan's human title (the document's H1). */
	title: string;
	/** The session's working directory. */
	cwd: string;
	/** The main worktree root, or null when not in a git repo. */
	repoRoot: string | null;
}

/**
 * Decide the directory a plan document should be written to.
 * Return an absolute directory to claim the plan, or undefined
 * to defer to the next router or the durable default.
 */
export type PlanRouter = (
	request: PlanRouteRequest,
) => string | undefined | Promise<string | undefined>;
