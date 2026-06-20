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
if [ -x "$chained" ]; then
	"$chained" "$@" || exit $?
fi

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
	// A custom core.hooksPath means a hook manager (husky and the
	// like) or a shared, possibly version-controlled hooks directory
	// owns the hooks. Leave it alone rather than write pi's hook into
	// a directory pi does not own.
	if (hasCustomHooksPath(repoRoot)) {
		return { installed: false, reason: "custom core.hooksPath configured" };
	}

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
		const chained = join(hooksDir, "prepare-commit-msg.pi-chained");
		// A backup already here means a non-pi hook was chained before;
		// renaming over it would lose the original, so refuse instead.
		if (existsSync(chained)) {
			return {
				installed: false,
				reason: "a prepare-commit-msg.pi-chained backup already exists",
			};
		}
		renameSync(target, chained);
	}

	writeFileSync(target, PREPARE_COMMIT_MSG_HOOK, { mode: 0o755 });
	chmodSync(target, 0o755);
	return { installed: true };
}

/** Whether the repo configures a custom core.hooksPath. */
function hasCustomHooksPath(repoRoot: string): boolean {
	try {
		const value = execFileSync(
			"git",
			["-C", repoRoot, "config", "--get", "core.hooksPath"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		return value.length > 0;
	} catch {
		// git config exits non-zero when the key is unset: no custom path.
		return false;
	}
}

/**
 * Ensure the hook is installed in the repo containing dir, at most
 * once per repo root. Resolves the repo, records it in `installed`
 * so later commands in the same repo are skipped, and installs
 * best-effort. A directory outside any git repo is a no-op. This is
 * how hook coverage follows the session into repos it later cds
 * into, rather than only the repo pi started in.
 */
export function ensureCommitHook(dir: string, installed: Set<string>): void {
	const root = repoRootOf(dir);
	if (!root || installed.has(root)) return;
	installed.add(root);
	try {
		installCommitHook(root);
	} catch {
		// Best-effort: never let hook installation break a command.
	}
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
