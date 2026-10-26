/**
 * Project detection for the verify domain: walk up to the nearest
 * package.json and read its scripts, so the check command can be
 * resolved without the caller having to name a project directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ProjectInfo {
	readonly dir: string;
	readonly scripts: Readonly<Record<string, string>>;
	readonly packageManager: string;
}

/** Walk up from startDir to the nearest package.json, reading its scripts. */
export function findProject(startDir: string): ProjectInfo | null {
	let dir = startDir;
	while (true) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
					scripts?: Record<string, string>;
					packageManager?: string;
				};
				return {
					dir,
					scripts: pkg.scripts ?? {},
					packageManager: detectPackageManager(dir, pkg.packageManager),
				};
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Infer the package manager: an explicit Corepack `packageManager`
 * field wins, then the lockfile present in dir. Falls back to npm,
 * not pnpm, when neither is present: npm ships with Node itself, so
 * it is the one manager guaranteed to exist, unlike a guess that
 * turns "no lockfile yet" (a freshly scaffolded project, before the
 * first install) into a false "command not found" failure.
 */
export function detectPackageManager(dir: string, declared?: string): string {
	const fromField = declared?.split("@")[0]?.trim();
	if (fromField) return fromField;
	if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(dir, "yarn.lock"))) return "yarn";
	return "npm";
}
