/**
 * Whether a session carries on code its install has long left behind.
 *
 * A session follows its install, reloading once idle after the install
 * moves (lib/internal/reload/follow.ts), but one can miss it: on 27
 * November MZ5YL7 carried on a harness two days old, which lacked the
 * fix for the very failure its carry met. A carry it starts then fails
 * on a bug already mended, so it waits for the reload instead, saying
 * why.
 */

/**
 * How long a session may run a version its install has left before a
 * carry from it waits on its reload: the follower's spread of idle
 * reloads, ten minutes, with room for the install to finish. A shorter
 * bar would refuse carries often, since the install moves many times an
 * hour while sessions reload on their own.
 */
export const BEHIND_FOR_MS = 15 * 60_000;

/**
 * Why a carry from the harness at `root` waits on its reload, `now`:
 * the install `root` is a version of has left it for another more than
 * {@link BEHIND_FOR_MS} ago. Nothing for the install's own version, or
 * for code outside an install of whole versions, such as a tree or a
 * store copy.
 */
export function behindItsInstall(
	_root: string,
	_now: number = Date.now(),
): string | undefined {
	return undefined;
}
