/**
 * A backend over a real SessionHost and roster in a private folder, with
 * an engine whose resumes and rollout gate a test holds and lets go, for
 * the tests of waking parked conversations.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { SessionHost } from "../../../../host/engine/index.ts";
import {
	type ConversationEngine,
	hostBackend,
} from "../../../../host/service/backend.ts";
import { parseOpenResult } from "../../../../host/service/protocol.ts";
import type { AdmitAnother } from "../../../../host/service/rollout.ts";
import {
	type HostRoster,
	openRoster,
} from "../../../../host/service/roster.ts";
import { quietFor } from "../../../support/until.ts";

const KEY = "work-attended";
const owner = { pid: process.pid, startedAt: 1 };

/**
 * How soon a resume that may begin does: a wake reaches its place in
 * microtasks, so a few milliseconds is ample.
 */
const BEGINS_WITHIN_MS = 5;

/**
 * A resume's longest, short enough to wait out in a test, and ten times
 * the checks made while one counts, so none lapses during them on a
 * loaded runner.
 */
export const LONGEST_MS = 300;

/** How early by `Date.now()` node may fire a timer, as it rounds. */
export const TIMER_EARLY_MS = 1;

/** A longest no test waits out, so only a place freeing lets a wake on. */
export const NEVER_MS = 60_000;

/** Let a resume that may begin do so, before checking that it didn't. */
export function settle(): Promise<void> {
	return quietFor(BEGINS_WITHIN_MS);
}

/** A window's attach to the conversation, as a screen sends it. */
export const attach = (sessionId: string) =>
	({
		v: 1,
		id: `a-${sessionId}`,
		op: "attach",
		sessionId,
		rows: 40,
		columns: 120,
	}) as const;

/** An attended open in /work. */
export const open = {
	v: 1,
	id: "o",
	op: "open",
	cwd: "/work",
	attended: true,
} as const;

/**
 * A rollout gate that lets every conversation through until `hold`, then
 * keeps the next to ask waiting until `open`.
 */
export function heldGate() {
	let holding = false;
	let opened: (() => void) | undefined;
	const gate: AdmitAnother = async () => {
		if (!holding) return;
		holding = false;
		await new Promise<void>((resolve) => {
			opened = resolve;
		});
	};
	return {
		gate,
		hold: () => {
			holding = true;
		},
		waits: () => opened !== undefined,
		open: () => opened?.(),
	};
}

/**
 * A fresh SessionHost and roster in a private folder for each test of the
 * suite calling it, stopped and removed after, with the helpers that build
 * on them; `host` and `roster` read the current test's.
 */
export function wakeHost() {
	let dir = "";
	let host: SessionHost | undefined;
	let roster: HostRoster | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "wake-"));
		host = new SessionHost({ key: KEY, owner, registryDir: dir });
		roster = await openRoster({
			key: KEY,
			dir: join(dir, "rosters"),
			owner: { ...owner, startTicks: 1 },
		});
	});
	afterEach(async () => {
		const ending = theHost();
		for (const { id } of ending.list()) await ending.stop(id);
		ending.dispose();
		await theRoster().close();
		await rm(dir, { recursive: true, force: true });
	});

	function theHost(): SessionHost {
		if (!host) throw new Error("the host is made before each test");
		return host;
	}

	function theRoster(): HostRoster {
		if (!roster) throw new Error("the roster is opened before each test");
		return roster;
	}

	function register(conversation: {
		sessionId: string;
		file: string;
		cwd: string;
	}) {
		theHost().register({
			id: conversation.sessionId,
			file: conversation.file,
			cwd: conversation.cwd,
			env: {},
			close: () => {},
		});
	}

	/** An engine registering with the real SessionHost, as the engine does. */
	function engine(overrides: Partial<ConversationEngine> = {}) {
		const fake: ConversationEngine = {
			prepare: vi.fn(async () => ({
				sessionId: randomUUID(),
				file: join(dir, `${randomUUID()}.jsonl`),
				cwd: "/work",
			})),
			start: vi.fn(async (prepared) => register(prepared)),
			discard: vi.fn(async () => {}),
			resume: vi.fn(async (entry) => register(entry)),
			abort: vi.fn(async () => {}),
			backgroundOf: () => 0,
			dropped: vi.fn(async () => {}),
			handsOn: vi.fn(),
			...overrides,
		};
		return fake;
	}

	function backendWith(
		fake: ConversationEngine,
		admitAnother?: AdmitAnother,
		say?: (line: string) => void,
		wakes: { wakePlaces?: number; wakeLongestMs?: number } = {},
	) {
		const current = theHost();
		return hostBackend({
			identity: { key: current.key, owner: current.owner },
			host: current,
			roster: theRoster(),
			engine: fake,
			...(admitAnother ? { admitAnother } : {}),
			...(say ? { say } : {}),
			...wakes,
		});
	}

	/**
	 * An engine whose resumes each wait to be let through: `begun` lists the
	 * conversations whose resume has started, in order, `begunAt` when each
	 * did, and `finish` lets one end. Each registers as it begins, as the
	 * engine's does before its first await.
	 */
	function heldResumes() {
		const begun: string[] = [];
		const begunAt: number[] = [];
		const finishes = new Map<string, () => void>();
		const fake = engine({
			resume: vi.fn(async (entry) => {
				begun.push(entry.sessionId);
				begunAt.push(Date.now());
				register(entry);
				await new Promise<void>((resolve) => {
					finishes.set(entry.sessionId, resolve);
				});
			}),
		});
		const finish = (sessionId: string): void => {
			const done = finishes.get(sessionId);
			if (!done) throw new Error(`${sessionId}'s resume hasn't begun`);
			done();
		};
		return { fake, begun, begunAt, finish };
	}

	/** Open a conversation, then park it as the engine does: a host stop, keeping its hold. */
	async function parked(backend: ReturnType<typeof backendWith>) {
		const { sessionId } = parseOpenResult(await backend.execute(open));
		await theHost().stop(sessionId, "parked while idle");
		return sessionId;
	}

	return {
		get host() {
			return theHost();
		},
		get roster() {
			return theRoster();
		},
		register,
		engine,
		backendWith,
		heldResumes,
		parked,
	};
}
