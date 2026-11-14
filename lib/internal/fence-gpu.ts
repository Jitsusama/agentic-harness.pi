/**
 * The GPU inside the fence: its render nodes, which draw and compute,
 * for every fenced command, and never a `card` node, which drives the
 * display and takes its input. On 13 November XY9H5C's recording rig, a
 * headless compositor, could not open renderD128 inside the fence, and
 * a GPU a session must ask for is one more path made harder for work
 * that is meant (ISXEG8 [0ed98522], reversing the opt-in of [8edd0a0c]).
 */

import { join } from "node:path";
import type { Disk } from "./fence-disk.ts";

/** Where the GPU's nodes are, a render node among them. */
const DRI = "/dev/dri";

/** A render node's name: drawing and compute, no display and no input. */
const RENDER_NODE = /^renderD\d+$/;

/**
 * bubblewrap's arguments binding each render node there is into the
 * fence's /dev. Mesa finds a node's driver through /sys, already there
 * inside, so nothing else is needed.
 */
export function renderNodeArgs(disk: Disk): string[] {
	return [...disk.entries(DRI)]
		.filter((name) => RENDER_NODE.test(name))
		.sort()
		.flatMap((name) => {
			const path = join(DRI, name);
			return disk.kind(path) === "file" ? ["--dev-bind", path, path] : [];
		});
}
