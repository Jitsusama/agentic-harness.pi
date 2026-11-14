/**
 * Watching a parked peer's steer inboxes, so a steer that waits on it
 * running (steerWakes in parked.ts) wakes it as it lands rather than at
 * the next once-a-minute pass a running peer makes (wakeSteered), which
 * stays as the backstop. Super+S, the launcher's Talk, the void and a
 * steer the node brings from another machine each waited up to 60 s for
 * that pass on 14 Nov 2026.
 *
 * Each address's inbox is watched where it is. An inbox made after the
 * watch starts, or swept by forgetInboxes and made again, is heard
 * through a watch on the steer root that heeds only these addresses'
 * folders. Each waking steer is asked for once, and the steer stays
 * where it is for the peer to take as it starts.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { steerWakes } from "./parked.ts";
import { inboxOf, waitingSteers } from "./steer.ts";

/** A steer file's ending once it is whole in its inbox. */
const READY = ".json";

/** A watch of a parked peer's steer inboxes, until it is closed. */
export interface SteerWatch {
	/** Stop watching: no steer landing after asks for anything. */
	close(): void;
}

/**
 * Watch the inboxes under `root` of every address in `addresses`, and
 * say `waking` with a steer's file each time one lands that waits on
 * the peer running, one already waiting included. Any steers waking at
 * once are said once, by the first of them.
 */
export function watchWakingSteers(options: {
	readonly root: string;
	readonly addresses: readonly string[];
	readonly waking: (file: string) => void;
	readonly report: (error: unknown) => void;
}): SteerWatch {
	const { root, report } = options;
	const addresses = new Set(options.addresses.map((one) => one.toUpperCase()));
	const inboxes = new Map<string, FSWatcher>();
	const asked = new Set<string>();
	let closed = false;
	let rootWatch: FSWatcher | undefined;

	function look(address: string): void {
		if (closed) return;
		const fresh = waitingSteers(inboxOf(root, address)).filter(
			(steer) => steerWakes(steer) && !asked.has(steer.file),
		);
		const first = fresh[0];
		if (first === undefined) return;
		for (const steer of fresh) asked.add(steer.file);
		options.waking(first.file);
	}

	function heed(address: string): void {
		if (closed) return;
		inboxes.get(address)?.close();
		inboxes.delete(address);
		try {
			const watcher = watch(inboxOf(root, address), (_, name) => {
				if (name?.endsWith(READY)) look(address);
			});
			watcher.unref();
			// A swept inbox ends its watch; the root's watch heeds it made again.
			watcher.on("error", () => {
				watcher.close();
				if (inboxes.get(address) === watcher) inboxes.delete(address);
			});
			inboxes.set(address, watcher);
		} catch {
			// No inbox yet: the root's watch heeds it once it is made.
		}
		// One landing before its watch began.
		look(address);
	}

	try {
		mkdirSync(root, { recursive: true });
		rootWatch = watch(root, (_, name) => {
			const address = name?.toUpperCase();
			if (address !== undefined && addresses.has(address)) heed(address);
		});
		rootWatch.unref();
		rootWatch.on("error", report);
	} catch (error) {
		// Only its inboxes there now are heard, and the backstop pass the rest.
		report(error);
	}
	for (const address of addresses) heed(address);

	return {
		close() {
			closed = true;
			rootWatch?.close();
			for (const watcher of inboxes.values()) watcher.close();
			inboxes.clear();
		},
	};
}
