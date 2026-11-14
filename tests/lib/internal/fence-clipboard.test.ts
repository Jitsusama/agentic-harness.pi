/**
 * The fence's own `wl-copy` and `wl-paste`: named for a fenced
 * command's path only where the machine has them, and kept read-only
 * inside so no command plants a program there for another session's.
 */

import { describe, expect, it } from "vitest";
import { fenceArgs } from "../../../lib/internal/fence.ts";
import { fenceShims } from "../../../lib/internal/fence-clipboard.ts";
import type { Disk } from "../../../lib/internal/fence-disk.ts";

describe("the fence's clipboard", () => {
	const place = { home: "/home/someone", runtimeDir: "/run/user/1000" };

	it("keeps the fence's wl-copy and wl-paste read-only", () => {
		const everything: Disk = {
			kind: () => "folder",
			entries: (folder) => (folder === place.home ? [".local"] : []),
		};
		const args = fenceArgs(place, everything);
		const pairs = (flag: string) =>
			args.flatMap((arg, at) => (arg === flag ? [args[at + 1]] : []));
		const shims = "/home/someone/.local/share/pi-fence";
		expect(pairs("--ro-bind"), "the shims aren't read-only").toContain(shims);
		expect(pairs("--bind"), "the shims are writable").not.toContain(shims);
	});

	it("names the fence's shims only where the machine has them", () => {
		const shims = "/home/someone/.local/share/pi-fence/bin";
		const only = (path: string): Disk => ({
			kind: (given) => (given === path ? "file" : undefined),
			entries: () => [],
		});
		expect(
			[
				fenceShims(place.home, only(shims)),
				fenceShims(place.home, only("/elsewhere")),
			],
			"there, not there",
		).toEqual([shims, undefined]);
	});
});
