/**
 * The prepare-commit-msg hook that attributes every commit made
 * under pi, not just a typed `git commit`. Command-level injection
 * only sees a literal git commit; cherry-pick, revert, rebase,
 * merge and editor commits reach attribution only through this
 * hook.
 *
 * The hook keys off PI_CO_AUTHOR, which pi sets to the full trailer
 * line for its own commands. A commit made outside pi has no such
 * variable and is left untouched. The hook is idempotent (it never
 * adds a second AI co-author) and chains to any prepare-commit-msg
 * the repo already had, so it never shadows existing behaviour.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/** Marker identifying a hook file as pi's, for idempotent installs. */
const HOOK_MARKER = "pi-commit-attribution-hook";

/** The prepare-commit-msg script pi installs. */
export const PREPARE_COMMIT_MSG_HOOK = `#!/bin/sh
# ${HOOK_MARKER}
# Appends the AI co-author trailer to commits made under Pi.
# PI_CO_AUTHOR is set by Pi's attribution extension to the full
# trailer line; commits made outside Pi have no such variable and
# are left untouched. Idempotent and chains to any displaced hook.

msg_file="$1"

chained="$(CDPATH= cd "$(dirname "$0")" && pwd)/prepare-commit-msg.pi-chained"
[ -x "$chained" ] && "$chained" "$@"

[ -n "$PI_CO_AUTHOR" ] || exit 0
[ -f "$msg_file" ] || exit 0

if grep -qi 'co-authored-by[: ]*ai' "$msg_file"; then
	exit 0
fi

git interpret-trailers --in-place --trailer "$PI_CO_AUTHOR" "$msg_file"
`;

/** The outcome of trying to install the hook. */
export interface HookInstall {
	readonly installed: boolean;
	readonly reason?: string;
}

/**
 * Install the prepare-commit-msg hook into a repo's hooks
 * directory, honouring core.hooksPath and chaining any existing
 * hook. A no-op when pi's hook is already installed.
 */
export function installCommitHook(repoRoot: string): HookInstall {
	let hooksDir: string;
	try {
		hooksDir = resolveHooksDir(repoRoot);
	} catch (error) {
		return { installed: false, reason: `not a git repo: ${String(error)}` };
	}

	const target = join(hooksDir, "prepare-commit-msg");
	if (
		existsSync(target) &&
		readFileSync(target, "utf8").includes(HOOK_MARKER)
	) {
		return { installed: false, reason: "already installed" };
	}

	if (existsSync(target)) {
		renameSync(target, join(hooksDir, "prepare-commit-msg.pi-chained"));
	}

	writeFileSync(target, PREPARE_COMMIT_MSG_HOOK, { mode: 0o755 });
	chmodSync(target, 0o755);
	return { installed: true };
}

/** Resolve the active hooks directory, honouring core.hooksPath. */
function resolveHooksDir(repoRoot: string): string {
	const path = execFileSync(
		"git",
		["-C", repoRoot, "rev-parse", "--git-path", "hooks"],
		{ encoding: "utf8" },
	).trim();
	return isAbsolute(path) ? path : join(repoRoot, path);
}

/** The git repository root containing dir, or null when there is none. */
export function repoRootOf(dir: string): string | null {
	try {
		return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// Not a git repository (or git unavailable): no hook to install.
		return null;
	}
}
