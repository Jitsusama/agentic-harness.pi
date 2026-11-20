/** A child host's slot, its roster and the life its watch follows. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import {
	type ChildLifeOptions,
	childLife,
	childSlot,
	HEAP_EVERY_MS,
	type HostedConversation,
	oneConversation,
	scrubSystemd,
	seedChildRoster,
} from "../../../host/service/child.ts";
import { jsonLines } from "../../../host/service/framing.ts";
import {
	parseWatchLine,
	parseWatchResult,
	type WatchLine,
} from "../../../host/service/protocol.ts";
import { listenControl } from "../../../host/service/server.ts";
import { rosterPath } from "../../../lib/core/session/roster.ts";

const KEY = "work-background";
const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";
const OWNER = { pid: process.pid, startedAt: 1 };
const SINCE = "2026-11-19T21:00:00.000Z";
// A resume's slot is its conversation's id, but any name serves, and a
// short one keeps a test's socket within a Unix address however deep
// its temporary folder.
const SLOT = "r1";

let runtime: string;
beforeEach(async () => {
	runtime = await mkdtemp(join(tmpdir(), "child-"));
});
afterEach(async () => {
	await rm(runtime, { recursive: true, force: true });
});

/** The folder a key's children listen in, made, and an entry for `id`. */
async function children() {
	const folder = join(runtime, "pi-host", `${KEY}.d`);
	await mkdir(folder, { recursive: true });
	return folder;
}

function entry(id = A) {
	return {
		sessionId: id,
		file: join(runtime, `${id}.jsonl`),
		cwd: runtime,
		attended: false,
		since: "2026-11-19T21:00:00.000Z",
	};
}

function env(socket: string): NodeJS.ProcessEnv {
	return {
		PI_HOST_CHILD_KEY: KEY,
		PI_HOST_CHILD_SOCKET: socket,
		XDG_RUNTIME_DIR: runtime,
	};
}

describe("a child's slot", () => {
	it("resumes the roster entry its slot file holds", async () => {
		const folder = await children();
		await writeFile(
			join(folder, `${SLOT}.json`),
			JSON.stringify({ session: entry() }),
		);
		const slot = childSlot(env(join(folder, `${SLOT}.sock`)));
		expect(slot).toMatchObject({
			key: KEY,
			realm: "work",
			kind: "background",
			slot: SLOT,
			folder: join(folder, `${SLOT}.d`),
			held: entry(),
		});
		expect(slot.woken, "not woken unless the slot says so").toBeUndefined();
	});

	it("says a resume its supervisor woke is woken", async () => {
		const folder = await children();
		await writeFile(
			join(folder, `${SLOT}.json`),
			JSON.stringify({ session: entry(), woken: true }),
		);
		expect(childSlot(env(join(folder, `${SLOT}.sock`)))).toMatchObject({
			held: entry(),
			woken: true,
		});
	});

	it("holds nothing for an open, whose slot file is empty", async () => {
		const folder = await children();
		await writeFile(join(folder, "fresh.json"), "{}");
		const slot = childSlot(env(join(folder, "fresh.sock")));
		expect(slot.held).toBeUndefined();
	});

	it("refuses a socket outside its key's folder, or misnamed", async () => {
		const folder = await children();
		for (const socket of [
			join(runtime, "elsewhere.sock"),
			join(folder, "no spaces.sock"),
			join(folder, "fresh.json"),
			"",
		])
			expect(() => childSlot(env(socket)), socket).toThrow(
				/PI_HOST_CHILD_SOCKET/,
			);
	});

	it("refuses a key no host goes by", async () => {
		const folder = await children();
		expect(() =>
			childSlot({ ...env(join(folder, "x.sock")), PI_HOST_CHILD_KEY: "work" }),
		).toThrow(/host key/);
	});

	it("refuses a slot file it can't read, or whose entry no roster holds", async () => {
		const folder = await children();
		expect(() => childSlot(env(join(folder, "gone.sock")))).toThrow(
			/can't be read/,
		);
		await writeFile(
			join(folder, "bad.json"),
			JSON.stringify({ session: { sessionId: "not-a-uuid" } }),
		);
		expect(() => childSlot(env(join(folder, "bad.sock")))).toThrow(
			/holds no roster entry/,
		);
	});

	it("seeds its own roster with the slot's one entry, over what was there", async () => {
		const folder = await children();
		await writeFile(
			join(folder, `${SLOT}.json`),
			JSON.stringify({ session: entry() }),
		);
		const slot = childSlot(env(join(folder, `${SLOT}.sock`)));
		await mkdir(slot.folder, { recursive: true });
		await writeFile(rosterPath(KEY, slot.folder), "stale");
		seedChildRoster(slot);
		const roster: unknown = JSON.parse(
			await readFile(rosterPath(KEY, slot.folder), "utf8"),
		);
		expect(roster).toEqual({ v: 1, key: KEY, sessions: [entry()] });
	});
});

describe("what a child answers systemd", () => {
	it("takes systemd's notify, watchdog and socket variables out of its environment", () => {
		const given: NodeJS.ProcessEnv = {
			NOTIFY_SOCKET: "/run/notify",
			WATCHDOG_PID: "1",
			WATCHDOG_USEC: "120000000",
			LISTEN_FDS: "1",
			LISTEN_PID: "1",
			LISTEN_FDNAMES: "x",
			PATH: "/bin",
		};
		scrubSystemd(given);
		expect(given).toEqual({ PATH: "/bin" });
	});

	it("refuses every second conversation", async () => {
		await expect(oneConversation()).rejects.toThrow(/runs one conversation/);
	});
});

/** A life over conversations a case sets, with timers it fires by hand. */
function following(more: Partial<ChildLifeOptions> = {}) {
	let held: HostedConversation[] = [];
	let known = true;
	const timers = new Map<number, () => void>();
	const lines: WatchLine[] = [];
	const life = childLife({
		version: "/harness",
		identity: () => ({ key: KEY, owner: OWNER }),
		conversations: () => held,
		entry: (id) => (known ? entry(id) : undefined),
		heap: () => ({ used: 10, limit: 100 }),
		every: (ms, run) => {
			timers.set(ms, run);
			return () => timers.delete(ms);
		},
		after: (ms, run) => {
			timers.set(ms, run);
			return () => timers.delete(ms);
		},
		firstWithin: 1,
		...more,
	});
	life.watch.follow((line) => lines.push(parseWatchLine(line)));
	return {
		life,
		lines,
		timers,
		hold(...now: HostedConversation[]) {
			held = now;
			life.changed();
		},
		/** Whether the child's roster holds an entry for what it runs. */
		rostered(now: boolean) {
			known = now;
		},
	};
}

function conversation(
	id: string,
	state: HostedConversation["state"] = "idle",
): HostedConversation {
	return { id, file: `/s/${id}`, cwd: "/", state, since: SINCE };
}

describe("a child's life", () => {
	it("answers its watch once it holds its conversation", async () => {
		const { life, hold } = following();
		const answer = life.watch.answer();
		hold(conversation(A));
		expect(parseWatchResult(await answer)).toEqual({
			version: "/harness",
			host: { key: KEY, owner: OWNER },
			conversation: {
				sessionId: A,
				file: `/s/${A}`,
				cwd: "/",
				state: "idle",
				since: SINCE,
			},
			entry: entry(A),
		});
	});

	it("waits to answer until its roster holds the conversation's entry", async () => {
		const { life, hold, rostered } = following();
		const answer = life.watch.answer();
		rostered(false);
		hold(conversation(A));
		rostered(true);
		hold(conversation(A, "busy"));
		expect(parseWatchResult(await answer).conversation.state).toBe("busy");
	});

	it("says each turn busy or idle once, with the heap, and the heap on its timer", () => {
		const { lines, hold, timers } = following();
		hold(conversation(A));
		hold(conversation(A, "busy"));
		hold(conversation(A, "busy"));
		hold(conversation(A));
		timers.get(HEAP_EVERY_MS)?.();
		expect(lines.map((line) => line.type === "state" && line.state)).toEqual([
			"busy",
			"idle",
			"idle",
		]);
		expect(lines[0]).toMatchObject({ heap: { used: 10, limit: 100 } });
	});

	it("says a conversation became another, and doesn't end as the old one leaves", () => {
		const { life, lines, hold } = following();
		hold(conversation(A));
		life.becoming(A, B);
		hold(conversation(A), conversation(B));
		hold(conversation(B));
		life.left("closed", "replaced");
		expect(lines).toEqual([
			{
				type: "became",
				previousId: A,
				conversation: expect.objectContaining({ sessionId: B }),
				entry: entry(B),
			},
		]);
	});

	it.each([
		["signalled", "host stopped", "parked"],
		["closed", "closed, asked by the launcher", "closed"],
		["closed", "released, asked by the launcher", "released"],
	] as const)(
		"ends %s (%s) as %s once its conversation has gone",
		async (how, why, ending) => {
			const { life, lines, hold } = following();
			hold(conversation(A));
			hold();
			life.left(how, why);
			expect(await life.ending).toBe(ending);
			expect(lines.at(-1)).toEqual({ type: "ending", why: ending });
		},
	);

	it("ends failed when nothing comes within its first wait, refusing its watch", async () => {
		const { life, timers } = following();
		const answer = life.watch.answer();
		timers.get(1)?.();
		expect(await life.ending).toBe("failed");
		await expect(answer).rejects.toThrow("The child ended: failed");
	});

	it("waits for the wake of a conversation that rests parked, then ends parked without one", async () => {
		const { life, timers } = following();
		life.resumed("parked");
		timers.get(1)?.();
		expect(await life.ending).toBe("parked");
	});

	it("ends failed when its conversation couldn't be resumed", async () => {
		const { life } = following();
		life.resumed("unresumed");
		expect(await life.ending).toBe("failed");
	});

	it("ends parked on a stop once it held one, and failed before", async () => {
		const held = following();
		held.hold(conversation(A));
		held.life.stopping();
		expect(await held.life.ending).toBe("parked");
		const never = following();
		never.life.stopping();
		expect(await never.life.ending).toBe("failed");
	});
});

async function* messages(socket: Socket) {
	const frames = jsonLines();
	for await (const chunk of socket)
		for (const value of frames.push(
			typeof chunk === "string" ? Buffer.from(chunk) : chunk,
		))
			yield value;
	frames.end();
}

describe("a child's watch over its socket", () => {
	it("answers once its host holds the conversation, then streams its lines to its ending", async () => {
		const registry = join(runtime, "registry");
		// The host tells its life of a change as it is made, before it is set.
		let made: SessionHost | undefined;
		const life = childLife({
			version: "/harness",
			identity: () => made && { key: made.key, owner: made.owner },
			conversations: () => made?.list() ?? [],
			entry,
			heap: () => ({ used: 1, limit: 2 }),
		});
		const host: SessionHost = new SessionHost({
			key: KEY,
			owner: OWNER,
			registryDir: registry,
			changes: life,
		});
		made = host;
		const path = join(runtime, "child.sock");
		const listener = await listenControl({
			path,
			backend: {
				identity: { key: host.key, owner: host.owner },
				execute: async () => null,
			},
			watch: life.watch,
			report: vi.fn(),
		});
		try {
			const socket = createConnection(path);
			socket.write(`${JSON.stringify({ v: 1, id: "w", op: "watch" })}\n`);
			const heard = messages(socket);
			host.register({
				id: A,
				file: join(runtime, A),
				cwd: runtime,
				env: {},
				close: () => undefined,
			});
			const answer = await heard.next();
			expect(answer.value).toMatchObject({
				v: 1,
				id: "w",
				ok: true,
				result: { conversation: { sessionId: A } },
			});
			await host.stop(A);
			const rest: unknown[] = [];
			for await (const line of heard) {
				rest.push(line);
				if (parseWatchLine(line).type === "ending") break;
			}
			expect(rest.at(-1)).toEqual({ type: "ending", why: "parked" });
			socket.destroy();
		} finally {
			life.dispose();
			await listener.close();
			host.dispose();
		}
	});
});
