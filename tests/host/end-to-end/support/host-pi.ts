/**
 * The pi a real host runs, built with the host's patches, found where
 * the E checks look for it: PI_HOST_PACKAGE_DIR when set, else under the
 * link H2 keeps to the latest piHostRuntime build, a GC root so the store
 * never collects it, at $XDG_STATE_HOME/pi-host/runtime.
 *
 * A test run sandboxes every XDG folder (tests/setup/xdg-sandbox.ts), so
 * a check can't read the person's link from its own environment. `pnpm
 * test:host` resolves the link in its shell, before vitest starts, and
 * passes it as PI_HOST_RUNTIME; it sets PI_HOST_REQUIRED too, so there a
 * missing pi fails the check rather than skipping it, since no CI runs
 * these. An ordinary run skips each check, saying how to run it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The variable that names a host's pi outright. */
export const HOST_PI_VARIABLE = "PI_HOST_PACKAGE_DIR";

/** The variable `pnpm test:host` sets, so a missing pi fails rather than skips. */
export const HOST_PI_REQUIRED = "PI_HOST_REQUIRED";

/** The variable `pnpm test:host` names H2's link in, resolved outside the sandbox. */
const HOST_RUNTIME_VARIABLE = "PI_HOST_RUNTIME";

/** Where H2 links the latest piHostRuntime build. */
export function hostRuntimeLink(env: NodeJS.ProcessEnv = process.env): string {
	const named = env[HOST_RUNTIME_VARIABLE];
	if (named) return named;
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(state, "pi-host", "runtime");
}

/** The pi-monorepo folder inside a piHostRuntime build. */
function monorepoIn(build: string): string {
	return join(build, "lib", "node_modules", "pi-monorepo");
}

/** What finds no host's pi, and how to get one. */
export function hostPiMissing(env: NodeJS.ProcessEnv = process.env): string {
	const named = env[HOST_PI_VARIABLE];
	const looked = named
		? `${HOST_PI_VARIABLE} names ${named}, which doesn't exist`
		: `nothing is linked at ${hostRuntimeLink(env)}`;
	return (
		`No pi built with the host's patches: ${looked}. ` +
		"Run pnpm test:host, which finds the link H2 keeps, " +
		`or set ${HOST_PI_VARIABLE} to a build's pi-monorepo folder; ` +
		"to make one, tec build //home/joel-gerber/dotfiles:piHostRuntime " +
		"and link it at ~/.local/state/pi-host/runtime."
	);
}

/** The host's pi's package folder, the pi-monorepo root, or nothing found. */
export function hostPackageDir(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const found = env[HOST_PI_VARIABLE] || monorepoIn(hostRuntimeLink(env));
	return existsSync(found) ? found : undefined;
}

/**
 * The host's pi for a check: found, or the check skipped saying how to
 * get one, or failed where PI_HOST_REQUIRED asks for it.
 */
export function hostPiFor(
	skip: (note: string) => never,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const found = hostPackageDir(env);
	if (found) return found;
	if (env[HOST_PI_REQUIRED]) throw new Error(hostPiMissing(env));
	return skip(hostPiMissing(env));
}
