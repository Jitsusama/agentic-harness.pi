/**
 * The folders above what the fence closes, pinned so a fenced command
 * can't move them. A read-only bind keeps its own folder from writes,
 * but in a writable folder above it a command could still rename that
 * folder away and put one of its own in its place, which pi outside the
 * fence then reads as its own: `~/.local/state` renamed takes pi's state
 * with it, the host's record of each session's fence among it (ISXEG8,
 * 19 November). A mount can't be renamed or replaced ("Device or
 * resource busy"), so each such folder is bound over itself, writable
 * as it was, before anything is bound inside it.
 *
 * A folder that is a link can't be pinned: bubblewrap binds where it
 * leads, which may lie outside the home folder in ground bound writable,
 * and a link could be swapped for another. So the walk leaves the link
 * itself unbound and pins the folders above it as any other, which
 * leaves the link replaceable; a host whose records lie past a link,
 * now or as it started, names no session's fence in them
 * (session-host.ts), so the node refuses their carries. Any other folder
 * the fence closes past such a link, and the folders its target lies
 * in, stay movable by a fenced command (04TNWT, 20 November).
 */

import { dirname, relative, sep } from "node:path";
import type { Disk } from "./fence-disk.ts";

/** How many values each of bubblewrap's options the fence gives takes. */
const TAKES: Readonly<Record<string, number>> = {
	"--die-with-parent": 0,
	"--new-session": 0,
	"--unshare-pid": 0,
	"--dev": 1,
	"--proc": 1,
	"--perms": 1,
	"--tmpfs": 1,
	"--remount-ro": 1,
	"--overlay-src": 1,
	"--tmp-overlay": 1,
	"--bind": 2,
	"--ro-bind": 2,
	"--ro-bind-try": 2,
	"--dev-bind": 2,
};

/** One option in bubblewrap's arguments, with where it is and what it mounts. */
interface Mount {
	readonly at: number;
	readonly option: string;
	readonly from?: string;
	readonly to?: string;
}

/** `args` read as bubblewrap reads them, each option with its values. */
function mountsOf(args: readonly string[]): Mount[] {
	const mounts: Mount[] = [];
	// Where the sources of the overlay still to come begin: an overlay and
	// its sources are one mount, so nothing may go between them.
	let sources: number | undefined;
	for (let at = 0; at < args.length; ) {
		const option = args[at] ?? "";
		const takes = TAKES[option];
		if (takes === undefined) {
			// Pinning past what it can't read would leave a folder movable.
			throw new Error(`the fence can't pin past bubblewrap's ${option}`);
		}
		const values = args.slice(at + 1, at + 1 + takes);
		if (values.length < takes) {
			throw new Error(
				`${option} wants ${takes} values, the fence gave ${values.length}`,
			);
		}
		if (option === "--overlay-src") {
			sources ??= at;
			at += 1 + takes;
			continue;
		}
		const to = takes === 0 ? undefined : values[takes - 1];
		const from = takes === 2 ? values[0] : undefined;
		const starts = option === "--tmp-overlay" ? (sources ?? at) : at;
		if (option === "--tmp-overlay") sources = undefined;
		mounts.push({
			at: starts,
			option,
			...(from ? { from } : {}),
			...(to ? { to } : {}),
		});
		at += 1 + takes;
	}
	return mounts;
}

/** Whether `path` lies strictly within `folder`. */
function below(path: string, folder: string): boolean {
	const at = relative(folder, path);
	return at !== "" && !at.startsWith("..") && !at.startsWith(sep);
}

/** Whether a mount closes its path: read-only, emptied or stood in for. */
function closes(mount: Mount): boolean {
	if (mount.option === "--bind") return mount.from !== mount.to;
	return [
		"--ro-bind",
		"--ro-bind-try",
		"--tmpfs",
		"--remount-ro",
		"--tmp-overlay",
	].includes(mount.option);
}

/** Whether a mount leaves what's under it writable on the disk outside. */
function writableOutside(mount: Mount): boolean {
	return (
		(mount.option === "--bind" || mount.option === "--dev-bind") &&
		mount.from === mount.to
	);
}

/**
 * `args` with each folder in the home folder above a path they close
 * pinned, where a command could move it: one lying in a folder bound
 * writable, not already a mount, and no link. Each pin goes before the
 * first mount within its folder laid after the one holding it, so it
 * hides none of them.
 */
export function pinnedAbove(
	args: readonly string[],
	home: string,
	disk: Disk,
): string[] {
	const mounts = mountsOf(args);
	// Keyed on the folder each binds, so one is never bound twice.
	const pins = new Map<string, { at: number; args: string[] }>();
	const mountedBefore = (folder: string, at: number) =>
		mounts.some((mount) => mount.at < at && mount.to === folder);
	const holderBefore = (folder: string, at: number) =>
		mounts
			.filter(
				(mount) =>
					mount.at < at && mount.to !== undefined && below(folder, mount.to),
			)
			.at(-1);
	// The first mount within `folder` laid after its holder, which a pin
	// goes before.
	const firstWithin = (folder: string, after: number) =>
		mounts.find(
			(mount) =>
				mount.at > after && mount.to !== undefined && below(mount.to, folder),
		)?.at ?? args.length;
	for (const mount of mounts) {
		if (!closes(mount) || mount.to === undefined) continue;
		if (!below(mount.to, home)) continue;
		for (
			let folder = dirname(mount.to);
			below(folder, home);
			folder = dirname(folder)
		) {
			if (mountedBefore(folder, mount.at)) continue;
			const holder = holderBefore(folder, mount.at);
			if (!holder || !writableOutside(holder)) continue;
			if (disk.kind(folder) !== "folder" || pins.has(folder)) continue;
			pins.set(folder, {
				at: firstWithin(folder, holder.at),
				args: ["--bind", folder, folder],
			});
		}
	}
	const laid = [...pins.values()].sort(
		(a, b) => a.at - b.at || depth(a.args[1]) - depth(b.args[1]),
	);
	const out: string[] = [];
	let next = 0;
	for (const pin of laid) {
		out.push(...args.slice(next, pin.at), ...pin.args);
		next = pin.at;
	}
	out.push(...args.slice(next));
	return out;
}

/** How deep `path` lies, so a folder is pinned before the ones inside it. */
function depth(path: string | undefined): number {
	return path?.split(sep).length ?? 0;
}
