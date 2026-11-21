/**
 * What keeps a subagent from carrying code past the fence.
 *
 * A subagent's pi runs outside the fence its parent's commands run in,
 * and an extension it loads runs there too, as the person. So the model
 * may not name the extensions it loads: a fenced command could write one
 * anywhere it may write, and a subagent asked to load it would run it
 * unfenced. Only this package's own files may be named, since the fence
 * holds the install. Nor may the model lift isolation in a folder whose
 * `.pi` holds code, since the subagent's pi would load that code as its
 * own, unpinned.
 */

import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** One job as the model asked for it, as far as this reads it. */
interface AskedJob {
	readonly id: string;
	readonly cwd: string;
	readonly isolated?: boolean;
	readonly extraExtensions?: readonly string[];
	readonly verify?: { readonly extensionPath: string };
}

/** What in a folder's `.pi` a pi would load as code. */
const PROJECT_CODE = ["extensions", "settings.json"] as const;

/** This package's own folder, the one place a named extension may lie. */
function packageRoot(): string {
	return realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
}

/** Whether `path`, links followed, lies inside `root`. */
function liesIn(path: string, root: string): boolean {
	try {
		const real = realpathSync(path);
		return real === root || real.startsWith(root + sep);
	} catch {
		// A path that can't be followed can't be shown to be the
		// package's own, so it counts as lying outside it.
		return false;
	}
}

/** What in `cwd`'s `.pi` a pi would load as code, by name. */
function projectCodeIn(cwd: string): string[] {
	return PROJECT_CODE.filter((name) => existsSync(join(cwd, ".pi", name)));
}

/**
 * Why these jobs may not run, or undefined when each keeps the fence:
 * every extension it names is this package's own, and it keeps
 * isolation wherever the folder's `.pi` holds code.
 */
export function fenceRefusal(
	jobs: readonly AskedJob[],
	root: string = packageRoot(),
): string | undefined {
	const reasons: string[] = [];
	for (const job of jobs) {
		const named = [
			...(job.extraExtensions ?? []),
			...(job.verify ? [job.verify.extensionPath] : []),
		];
		for (const path of named.filter((each) => !liesIn(each, root))) {
			reasons.push(
				`${job.id}: ${path} isn't this package's own, and a subagent's pi runs outside the fence, so it can't load an extension from anywhere else.`,
			);
		}
		const code = job.isolated === false ? projectCodeIn(job.cwd) : [];
		if (code.length > 0) {
			reasons.push(
				`${job.id}: ${join(job.cwd, ".pi")} holds ${code.join(" and ")}, which an unisolated subagent would load outside the fence; keep it isolated.`,
			);
		}
	}
	return reasons.length === 0
		? undefined
		: `No subagent started:\n${reasons.join("\n")}`;
}
