/**
 * A folder transport whose arrivals the machine's mycelium node says:
 * each message reaches a peer whole over the node's watch, kept here by
 * its id, so hearing one reads no file (see node-messages.ts for why).
 *
 * Only hearing moves. A message is still sent as its file, since the
 * folder is what the node and every older reader follow, and the
 * minute's look still lists the folder, which is the backstop should a
 * node stay connected but miss a message: what it finds unseen is read
 * from its file as before. Where no node answers, or its watch ends, the
 * folder's own watch hears in its place, and the node is asked again a
 * while later, each process at its own moment.
 */

import { join } from "node:path";
import { sessionRealm } from "../internal/machine/realm.ts";
import { stateDir } from "../internal/paths.ts";
import type { Message } from "./message.ts";
import { homeNodeSocket } from "./node.ts";
import { type MessageWatch, watchMessages } from "./node-messages.ts";
import { folderTransport, type Transport } from "./transport.ts";

/** How long after a node's watch is lost before it is asked again. */
const NODE_AGAIN_MS = 30_000;

/** How long a node has to take a watch before it counts as not answering. */
const NODE_READY_MS = 10_000;

/**
 * How many messages heard are kept: far more than land between two of a
 * peer's looks, as the node's own watch keeps 4096 events for one.
 */
const KEPT = 4096;

/** How long a node transport waits, for a test that can't wait. */
export interface NodeTimes {
	readonly againMs?: number;
	readonly readyMs?: number;
}

/** A wait, spread over up to half as long again, so many don't land together. */
function spread(ms: number): number {
	return ms + Math.random() * (ms / 2);
}

/**
 * The transport of the mesh kept at `mesh`: its messages folder, heard
 * through the home realm's node where `mesh` is the home realm's own,
 * hosted or not, and read from the folder alone anywhere else. A pi in
 * a terminal of its own lives as long as a hosted one, and a folder
 * watch wakes it at every message any peer sends; a test's mesh, though
 * it sits where its state dir says, is no folder the machine's node
 * follows; and another realm's node may follow a folder of its own, so
 * its sessions read theirs, as their presence does. `PI_MESH_NODE=off`
 * hears by the folder, should the node's word ever be doubted, without
 * stopping the node.
 */
export function meshTransport(mesh: string): Transport {
	const folder = folderTransport(join(mesh, "messages"));
	return nodeTransport(folder, () => {
		if (process.env.PI_MESH_NODE === "off") return undefined;
		if (sessionRealm().kind !== "home") return undefined;
		if (mesh !== stateDir("mesh-workflow")) return undefined;
		return homeNodeSocket();
	});
}

/**
 * The folder transport `folder`, hearing through the node whose socket
 * `socket` names, or the folder itself while none is named or answers.
 */
export function nodeTransport(
	folder: Transport,
	socket: () => string | undefined,
	times: NodeTimes = {},
): Transport {
	const againMs = times.againMs ?? NODE_AGAIN_MS;
	const readyMs = times.readyMs ?? NODE_READY_MS;
	const kept = new Map<string, Message>();
	const keep = (message: Message): void => {
		kept.delete(message.id);
		kept.set(message.id, message);
		// The oldest heard goes first: a read of it reaches its file.
		if (kept.size > KEPT) {
			const oldest = kept.keys().next().value;
			if (oldest !== undefined) kept.delete(oldest);
		}
	};
	return {
		...folder,
		send(draft) {
			const message = folder.send(draft);
			keep(message);
			return message;
		},
		read: (id) => kept.get(id) ?? folder.read(id),
		readOff: async (id) => kept.get(id) ?? folder.readOff(id),
		watch(arrived) {
			// Watched by the folder first, so what lands before the node takes
			// over is heard; a folder that can't be watched throws, as before.
			let folderWatch: (() => void) | undefined = folder.watch(arrived);
			let node: MessageWatch | undefined;
			let stopped = false;
			let clock: ReturnType<typeof setTimeout> | undefined;
			const byFolder = (): void => {
				if (folderWatch !== undefined || stopped) return;
				try {
					folderWatch = folder.watch(arrived);
				} catch {
					// Unwatchable now: the minute's look hears until the node does.
				}
			};
			const askLater = (): void => {
				if (stopped) return;
				clearTimeout(clock);
				// Asked again later, each process at its own moment.
				clock = setTimeout(ask, spread(againMs));
				clock.unref();
			};
			const lost = (): void => {
				node?.close();
				node = undefined;
				byFolder();
				askLater();
			};
			const ask = (): void => {
				if (stopped) return;
				const at = socket();
				if (at === undefined) {
					askLater();
					return;
				}
				let ready = false;
				const watch = watchMessages(at, {
					ready() {
						if (node !== watch) return;
						ready = true;
						clearTimeout(clock);
						folderWatch?.();
						folderWatch = undefined;
					},
					heard(message) {
						if (node !== watch) return;
						keep(message);
						arrived(message.id);
					},
					ended() {
						if (node === watch) lost();
					},
				});
				node = watch;
				// A node that never takes the watch isn't answering.
				clock = setTimeout(() => {
					if (node === watch && !ready) lost();
				}, readyMs);
				clock.unref();
			};
			ask();
			return () => {
				stopped = true;
				clearTimeout(clock);
				node?.close();
				node = undefined;
				folderWatch?.();
				folderWatch = undefined;
			};
		},
	};
}
