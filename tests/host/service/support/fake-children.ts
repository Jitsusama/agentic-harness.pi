/** Children in the test's own process, started by fake units as systemd would start a host's. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
	type Slot,
	slotOf,
	type Units,
} from "../../../../host/service/child-units.ts";
import type { HostIdentity } from "../../../../host/service/dispatch.ts";
import { jsonLines } from "../../../../host/service/framing.ts";
import type { SessionIdentity } from "../../../../host/service/protocol.ts";
import type { RosterEntry } from "../../../../lib/core/session/roster.ts";

// How late a fake child listens after its unit starts, so the
// supervisor has to wait for it as it waits for a real one.
export const LISTENS_AFTER_MS = 150;

/** A conversation as a child in `folder` lists it. */
export function conversationIn(
	folder: string,
	sessionId: string,
): SessionIdentity {
	return {
		sessionId,
		file: join(folder, `${sessionId}.jsonl`),
		cwd: folder,
		state: "idle",
		since: "2026-11-20T02:00:00.000Z",
	};
}

/** A conversation as a roster in `folder` holds it. */
export function entryIn(folder: string, sessionId: string): RosterEntry {
	return {
		sessionId,
		file: join(folder, `${sessionId}.jsonl`),
		cwd: folder,
		attended: false,
		since: "2026-11-20T02:00:00.000Z",
	};
}

/** What an open's child derives for its conversation, launch and all. */
export function derivedIn(folder: string, sessionId: string): RosterEntry {
	return {
		...entryIn(folder, sessionId),
		attended: true,
		launch: { PI_ARM: "b" },
	};
}

/** One JSON line. */
export function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/** One child as a test runs it: what it was asked, and what it says. */
export interface FakeChild {
	readonly slot: Slot;
	readonly identity: HostIdentity;
	readonly asked: Record<string, unknown>[];
	conversation: SessionIdentity | undefined;
	entry: RosterEntry | undefined;
	/** Say a line on every watch. */
	say(value: unknown): void;
	/** Say it ends, then exit. */
	end(why: string): Promise<void>;
	/** Exit without a word. */
	exit(): Promise<void>;
}

/** How a fake child answers. */
export interface ChildTraits {
	/** Refuse its open. */
	refuses?: boolean;
	/** Take every request and answer none. */
	silent?: boolean;
	/** Refuse every request past its open and watch, as one that lives on. */
	refusesAsks?: boolean;
}

/** Units that start fake children, and what they were asked. */
export interface FakeUnits extends Units {
	readonly started: string[];
	readonly stopped: string[];
	/** Each unit systemd was asked to forget, in order. */
	readonly forgotten: string[];
	/** Each unit running, with its child once it listens. */
	readonly children: Map<string, FakeChild | undefined>;
	/** What the next child started does, when a test says. */
	next?: ChildTraits & { diesBeforeListening?: boolean };
	/** The slot a unit names. */
	slotNamed(unit: string): Slot;
	/** The child running `sessionId`, throwing when none does. */
	childOf(sessionId: string): FakeChild;
}

/** Run a child in `slot`, as its unit would once its extensions load. */
async function runChild(
	units: FakeUnits,
	folder: string,
	key: string,
	slot: Slot,
	{ refuses, silent, refusesAsks }: ChildTraits,
	pid: number,
): Promise<FakeChild> {
	const held = JSON.parse(await readFile(slot.file, "utf8"));
	await mkdir(slot.folder, { recursive: true });
	await writeFile(join(slot.folder, "roster.json"), "{}\n");
	const watchers = new Set<Socket>();
	const sockets = new Set<Socket>();
	let server: Server | undefined;
	const child: FakeChild = {
		slot,
		identity: { key, owner: { pid, startedAt: pid } },
		asked: [],
		conversation: held.session
			? conversationIn(folder, held.session.sessionId)
			: undefined,
		entry: held.session,
		say(value) {
			for (const watcher of watchers) watcher.write(line(value));
		},
		async end(why) {
			child.say({ type: "ending", why });
			await child.exit();
		},
		async exit() {
			for (const socket of sockets) socket.end();
			await new Promise<void>((resolve) =>
				server ? server.close(() => resolve()) : resolve(),
			);
			units.children.delete(slot.unit);
		},
	};
	server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		const frames = jsonLines();
		socket.on("data", (chunk: Buffer) => {
			for (const value of frames.push(chunk)) {
				const request = value as Record<string, unknown>;
				child.asked.push(request);
				if (silent) continue;
				const id = request.id;
				if (request.op === "open") {
					if (refuses) {
						socket.write(
							line({
								v: 1,
								id,
								ok: false,
								error: { code: "invalid_request", message: "no such folder" },
							}),
						);
						continue;
					}
					const sessionId = randomUUID();
					child.conversation = conversationIn(folder, sessionId);
					child.entry = derivedIn(folder, sessionId);
					socket.write(
						line({ v: 1, id, ok: true, result: child.conversation }),
					);
				} else if (request.op === "watch") {
					watchers.add(socket);
					socket.write(
						line({
							v: 1,
							id,
							ok: true,
							result: {
								version: "test",
								host: child.identity,
								conversation: child.conversation,
								entry: child.entry,
							},
						}),
					);
				} else if (refusesAsks) {
					socket.write(
						line({
							v: 1,
							id,
							ok: false,
							error: { code: "invalid_request", message: "refused" },
						}),
					);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(slot.socket, resolve));
	return child;
}

/**
 * Units over `folder` for the host keyed `key`, each starting a child a
 * little after its start; what goes wrong in one goes to `report`.
 */
export function fakeUnits(
	folder: string,
	key: string,
	report: (error: unknown) => void,
): FakeUnits {
	let pid = 100;
	const fake: FakeUnits = {
		started: [],
		stopped: [],
		forgotten: [],
		children: new Map(),
		slotNamed(unit) {
			const name = unit.slice(unit.indexOf("@") + 1, -".service".length);
			return slotOf(folder, key, name);
		},
		childOf(sessionId) {
			for (const child of fake.children.values())
				if (child?.conversation?.sessionId === sessionId) return child;
			throw new Error(`No child runs ${sessionId}`);
		},
		async start(unit) {
			fake.started.push(unit);
			const next = fake.next ?? {};
			fake.next = undefined;
			// Held as running from the start, as systemd holds a unit it runs.
			fake.children.set(unit, undefined);
			pid += 1;
			const own = pid;
			// Late on purpose: a real unit's child listens a while after its
			// start, and the supervisor must wait that out.
			setTimeout(() => {
				if (next.diesBeforeListening) {
					fake.children.delete(unit);
					return;
				}
				runChild(fake, folder, key, fake.slotNamed(unit), next, own).then(
					(child) => fake.children.set(unit, child),
					report,
				);
			}, LISTENS_AFTER_MS);
		},
		async gone(unit) {
			return !fake.children.has(unit);
		},
		async stop(unit) {
			fake.stopped.push(unit);
			await fake.children.get(unit)?.exit();
			fake.children.delete(unit);
		},
		async forget(unit) {
			fake.forgotten.push(unit);
		},
		// A systemd that keeps no CPU account, so a slow child nobody waits on is
		// asked of for two listen times, or two answer times, and given up then.
		async cpuSpentMs() {
			return undefined;
		},
	};
	return fake;
}
