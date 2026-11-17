/**
 * The fence's clipboard: `wl-copy` and `wl-paste` of its own, first on a
 * fenced command's `PATH`, which ask core's clipboard door outside
 * (`modules/pi/clipboard-door`) rather than a display. The door copies
 * and pastes through data control, so the person's focus never moves,
 * answers only commands bubblewrap fenced, and never reads what a
 * password manager marked secret. The door's own folder is let through
 * with the fence's other doors (`LET_THROUGH` in fence.ts).
 *
 * The shims live in the home folder, read-only inside
 * (`READ_ONLY` in fence-home.ts), so no command plants a program there
 * for another session's to run.
 */

import { join } from "node:path";
import { DISK, type Disk } from "./fence-disk.ts";

/** Where core links the fence's `wl-copy` and `wl-paste`, in the home folder. */
const FENCE_SHIMS = ".local/share/pi-fence/bin";

/**
 * The folder holding the fence's `wl-copy` and `wl-paste`, for the front
 * of `PATH` inside, when it's there; without it a fenced command finds
 * whatever `wl-copy` its path holds, which reaches no display inside.
 */
export function fenceShims(
	home: string,
	disk: Disk = DISK,
): string | undefined {
	const path = join(home, FENCE_SHIMS);
	return disk.kind(path) === undefined ? undefined : path;
}
