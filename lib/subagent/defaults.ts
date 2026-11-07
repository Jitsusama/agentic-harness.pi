/**
 * Engine-wide default extensions and skills.
 *
 * Pi extensions that need to be present in every
 * subagent spawned in the current session register their
 * paths here. {@link runReviewer} prepends the registered
 * defaults onto each call's `extraExtensions` and
 * `extraSkills` lists, so the defaults survive an
 * `isolated: true` flag, since pi honours explicit
 * `--extension` / `--skill` injections even when ambient
 * inheritance is disabled.
 *
 * The registry must be genuinely process-global. Pi loads
 * each extension as its own module instance, so a plain
 * module-level Set would give each extension a separate
 * registry: an extension registering a default (e.g. a
 * credentials helper) would land it in its own copy, while
 * a reviewer spawned from a different extension would read
 * an empty one. Holding it on globalThis via processGlobal
 * makes registration in any instance visible to every
 * runReviewer.
 *
 * An outside pi extension adds a default over the bus,
 * both ways at once, since it cannot know whether it
 * activates before the host or after (see `./events.ts`):
 * it emits `subagent:register-default-extension:v1`,
 * which reaches a host already listening, and listens for
 * `subagent:ready:v1`, calling the registration methods
 * on the `SubagentWorkflowApi` it carries, which covers a
 * host activating later. Direct imports of the functions
 * below are supported too, primarily for tests and
 * tightly-coupled internal callers.
 *
 * Each default is held by what it is, its package and its
 * path inside that package, rather than by where it was
 * loaded from. A reload onto a worktree and back loads the
 * registering extension once from each root, and pi's bus
 * keeps every load's listeners, so the same file arrives
 * from each root; held by its path, a subagent loaded every
 * copy, and once a tree was released pi refused the run.
 * The latest registration wins, and the newest load is the
 * last to hear an event. The slots are new ones, since a
 * module loaded before this change still writes paths into
 * the old.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { processGlobal } from "../internal/process-global.ts";
import { isRecord } from "../internal/record.ts";

const defaultExtensions = processGlobal(
	"pi:subagent-default-extensions:v2",
	() => new Map<string, string>(),
);
const defaultSkills = processGlobal(
	"pi:subagent-default-skills:v2",
	() => new Map<string, string>(),
);

/**
 * What a path is, whichever root it was loaded from: its package's
 * name and its path inside the package, or the path itself when no
 * package holds it.
 */
export function defaultKey(path: string): string {
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const name = packageName(manifest);
			return name === undefined ? path : `${name}:${relative(dir, path)}`;
		}
		if (dirname(dir) === dir) return path;
	}
}

function packageName(manifest: string): string | undefined {
	try {
		const body: unknown = JSON.parse(readFileSync(manifest, "utf8"));
		const name = isRecord(body) ? body.name : undefined;
		return typeof name === "string" && name !== "" ? name : undefined;
	} catch {
		// A manifest that won't read names nothing; the path stands for
		// itself, as one outside any package does.
		return undefined;
	}
}

/**
 * Register an extension file that should be loaded into
 * every subagent run for the rest of the session.
 *
 * Paths must be absolute and accepted by pi's
 * `--extension` flag (a `.ts` or `.mjs` file, or a
 * directory containing an `index.ts`). Registering the
 * same file again, from this root or another, replaces it.
 */
export function registerSubagentDefaultExtension(path: string): void {
	defaultExtensions.set(defaultKey(path), path);
}

/**
 * Register a skill file that should be loaded into every
 * subagent run for the rest of the session.
 *
 * Paths must be absolute and accepted by pi's `--skill`
 * flag (typically a `SKILL.md` file). Registering the
 * same file again, from this root or another, replaces it.
 */
export function registerSubagentDefaultSkill(path: string): void {
	defaultSkills.set(defaultKey(path), path);
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
		extensions: Array.from(defaultExtensions.values()),
		skills: Array.from(defaultSkills.values()),
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
