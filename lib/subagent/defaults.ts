/**
 * Engine-wide default extensions and skills.
 *
 * Pi extensions that need to be present in every
 * subagent spawned in the current session register their
 * paths here. {@link runReviewer} prepends the registered
 * defaults onto each call's `extraExtensions` and
 * `extraSkills` lists, so the defaults survive an
 * `isolated: true` flag — pi honours explicit
 * `--extension` / `--skill` injections even when ambient
 * inheritance is disabled.
 *
 * The registry is process-global on purpose. Pi loads
 * every extension into one Node process, so module-level
 * state is the right scope: one credentials helper, one
 * registry, every subagent picks it up.
 *
 * The canonical way for an outside pi extension to add a
 * default is to listen for the `subagent-workflow:ready:v1`
 * event (see the `subagent-workflow` extension) and call
 * the registration methods on the `SubagentWorkflowApi`
 * object the event carries. Direct imports of the
 * functions below are supported too, primarily for tests
 * and tightly-coupled internal callers.
 */

const defaultExtensions = new Set<string>();
const defaultSkills = new Set<string>();

/**
 * Register an extension file that should be loaded into
 * every subagent run for the rest of the session.
 *
 * Paths must be absolute and accepted by pi's
 * `--extension` flag (a `.ts` or `.mjs` file, or a
 * directory containing an `index.ts`). Registering the
 * same path twice is a no-op.
 */
export function registerSubagentDefaultExtension(path: string): void {
	defaultExtensions.add(path);
}

/**
 * Register a skill file that should be loaded into every
 * subagent run for the rest of the session.
 *
 * Paths must be absolute and accepted by pi's `--skill`
 * flag (typically a `SKILL.md` file). Registering the
 * same path twice is a no-op.
 */
export function registerSubagentDefaultSkill(path: string): void {
	defaultSkills.add(path);
}

/**
 * Snapshot of the currently-registered defaults. The
 * arrays preserve insertion order so consumers can rely
 * on deterministic command-line argument shape.
 */
export function getSubagentDefaults(): {
	readonly extensions: readonly string[];
	readonly skills: readonly string[];
} {
	return {
		extensions: Array.from(defaultExtensions),
		skills: Array.from(defaultSkills),
	};
}

/**
 * Drop every registered default. Intended for test
 * isolation between cases that exercise the registry;
 * production code should not call this.
 */
export function clearSubagentDefaults(): void {
	defaultExtensions.clear();
	defaultSkills.clear();
}
