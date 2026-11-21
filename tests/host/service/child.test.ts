/** A child host's slot, its roster and the life its watch follows. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import {
	type ChildLifeOptions,
	childLife,
	childRosterSeed,
	childSlot,
	HEAP_EVERY_MS,
	type HostedConversation,
	oneConversation,
	scrubSystemd,
} from "../../../host/service/child.ts";
import { jsonLines } from "../../../host/service/framing.ts";
import {
	parseWatchLine,
	parseWatchResult,
	type WatchLine,
} from "../../../host/service/protocol.ts";
import { listenControl } from "../../../host/service/server.ts";

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

	it.each([
		["a list", []],
		["a string", "x"],
		["a number", 42],
		["null", null],
		["a misspelt field", { sesion: { sessionId: SLOT } }],
	])(
		"refuses a slot file holding %s rather than reading it as an open",
		async (_, given) => {
			const folder = await children();
			await writeFile(join(folder, "odd.json"), JSON.stringify(given));
			expect(() => childSlot(env(join(folder, "odd.sock")))).toThrow(
				/must hold \{\} for an open/,
			);
		},
	);

	it("seeds its roster with the slot's one entry, or none for an open", async () => {
		const folder = await children();
		await writeFile(
			join(folder, `${SLOT}.json`),
			JSON.stringify({ session: entry() }),
		);
		await writeFile(join(folder, "fresh.json"), "{}");
		expect(
			childRosterSeed(childSlot(env(join(folder, `${SLOT}.sock`)))),
		).toEqual([entry()]);
		expect(childRosterSeed(childSlot(env(join(folder, "fresh.sock"))))).toEqual(
			[],
		);
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

	it("says how many viewers its conversation has, as they come and go", () => {
		const { life, lines, hold } = following();
		hold(conversation(A));
		life.viewers(A, 2);
		life.viewers(A, 2);
		life.viewers(A, 1);
		hold(conversation(A, "busy"));
		expect(
			lines.map((line) => line.type === "state" && [line.state, line.viewers]),
		).toEqual([
			["idle", 2],
			["idle", 1],
			["busy", 1],
		]);
	});

	/** Park the conversation it runs as the host does: listed parked, then gone, then left. */
	function parkAway(
		child: ReturnType<typeof following>,
		id = A,
		why = "parked while idle",
	) {
		child.hold(conversation(id, "parked"));
		child.hold();
		child.life.left("signalled", why);
	}

	it("stays while a window views its parked conversation, ending parked once none has for its grace", async () => {
		const child = following({ aloneWithin: 2 });
		child.hold(conversation(A));
		child.life.viewers(A, 1);
		parkAway(child);
		expect(child.timers.has(2), "no grace while a window views it").toBe(false);
		child.life.viewers(A, 0);
		child.timers.get(2)?.();
		expect(await child.life.ending).toBe("parked");
		expect(child.lines.at(-1)).toEqual({ type: "ending", why: "parked" });
	});

	it("stays while a viewer comes back within the grace, or its conversation wakes", () => {
		const child = following({ aloneWithin: 2 });
		child.hold(conversation(A));
		parkAway(child);
		expect(child.timers.has(2), "a grace once parked with nobody").toBe(true);
		child.life.viewers(A, 1);
		expect(child.timers.has(2), "a viewer back ends the grace").toBe(false);
		child.life.viewers(A, 0);
		child.hold(conversation(A));
		expect(child.timers.has(2), "a wake ends the grace").toBe(false);
	});

	it("never arms its grace for a conversation listed parked only while it closes", async () => {
		const child = following({ aloneWithin: 2 });
		child.hold(conversation(A));
		child.hold(conversation(A, "parked"));
		expect(child.timers.has(2), "no grace while it is still listed").toBe(
			false,
		);
		child.hold();
		child.life.left("closed", "closed, asked by the launcher");
		expect(await child.life.ending).toBe("closed");
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
		["closed", "closed, asked by the launcher", "closed"],
		["released", "released, asked by the launcher", "released"],
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

	it("answers a watch that comes after it ended, then says its ending at once", async () => {
		const { life, hold } = following();
		hold(conversation(A));
		hold();
		life.left("released", "released, asked by the launcher");
		await life.ending;
		const late: unknown[] = [];
		life.watch.follow((line) => late.push(line));
		expect(
			parseWatchResult(await life.watch.answer()).conversation,
		).toMatchObject({
			sessionId: A,
		});
		expect(late).toEqual([{ type: "ending", why: "released" }]);
	});

	it("ends failed when nothing comes within its first wait, refusing its watch", async () => {
		const { life, timers } = following();
		const answer = life.watch.answer();
		timers.get(1)?.();
		expect(await life.ending).toBe("failed");
		await expect(answer).rejects.toThrow("The child ended: failed");
	});

	// F39: a resume slow under load ended its child as failed, which then
	// parked what had just come up; its own end settles it instead.
	it("keeps no first wait for a slot it resumes, however long the resume takes", async () => {
		const { life, timers, hold } = following({ resumes: true });
		expect(timers.has(1), "no first wait for a resume").toBe(false);
		const answer = life.watch.answer();
		hold(conversation(A));
		life.resumed("resumed");
		expect(parseWatchResult(await answer).conversation.sessionId).toBe(A);
	});

	// F38: a supervisor restarted after a became was told the old one.
	it("answers a later watch with what its conversation became", async () => {
		const { life, hold } = following();
		hold(conversation(A));
		await life.watch.answer();
		life.becoming(A, B);
		hold(conversation(A), conversation(B));
		hold(conversation(B));
		const later = parseWatchResult(await life.watch.answer());
		expect(later.conversation.sessionId).toBe(B);
		expect(later.entry).toEqual(entry(B));
	});

	// F34: the backend tells it of a close of one parked away.
	it("ends closed at once when its conversation parked away is closed", async () => {
		const child = following({ aloneWithin: 2 });
		child.hold(conversation(A));
		parkAway(child);
		child.life.left("closed", "closed, asked by the launcher");
		expect(await child.life.ending).toBe("closed");
		expect(child.timers.has(2), "its grace ends with it").toBe(false);
	});

	it("waits for the wake of a conversation that rests parked for its grace, then ends parked without one", async () => {
		const { life, timers } = following({ aloneWithin: 2 });
		life.resumed("parked");
		expect(timers.has(2), "the grace, not the first wait, bounds a rest").toBe(
			true,
		);
		timers.get(2)?.();
		expect(await life.ending).toBe("parked");
	});

	it("clears every timer as it is disposed, its grace among them", () => {
		const child = following({ aloneWithin: 2 });
		child.hold(conversation(A));
		parkAway(child);
		child.life.dispose();
		expect([...child.timers.keys()]).toEqual([]);
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

/**
 * A child's life over a real SessionHost, its watch served on a socket,
 * with `more` of the life's options; `run` gets the host, the socket's
 * path and the life, and everything is taken down after.
 */
async function overSocket(
	more: Partial<ChildLifeOptions>,
	run: (child: {
		host: SessionHost;
		path: string;
		life: ReturnType<typeof childLife>;
	}) => Promise<void>,
) {
	// The host tells its life of a change as it is made, before it is set.
	let made: SessionHost | undefined;
	const life = childLife({
		version: "/harness",
		identity: () => made && { key: made.key, owner: made.owner },
		conversations: () => made?.list() ?? [],
		entry,
		heap: () => ({ used: 1, limit: 2 }),
		...more,
	});
	const host: SessionHost = new SessionHost({
		key: KEY,
		owner: OWNER,
		registryDir: join(runtime, "registry"),
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
		await run({ host, path, life });
	} finally {
		life.dispose();
		await listener.close();
		host.dispose();
	}
}

/** A watch asked on a fresh connection to `path`, and what it hears. */
function watchOn(path: string) {
	const socket = createConnection(path);
	socket.write(`${JSON.stringify({ v: 1, id: "w", op: "watch" })}\n`);
	return { socket, heard: messages(socket) };
}

/** Register conversation A in `host`, as a start or open does. */
function registerA(host: SessionHost) {
	host.register({
		id: A,
		file: join(runtime, A),
		cwd: runtime,
		env: {},
		close: () => undefined,
	});
}

/** Every line heard up to and with the ending. */
async function untilEnding(heard: AsyncGenerator<unknown>) {
	const rest: unknown[] = [];
	for await (const line of heard) {
		rest.push(line);
		if (parseWatchLine(line).type === "ending") break;
	}
	return rest;
}

describe("a child's watch over its socket", () => {
	it("answers once its host holds the conversation, then streams its lines to its ending", async () => {
		await overSocket({ aloneWithin: 10 }, async ({ host, path }) => {
			const { socket, heard } = watchOn(path);
			registerA(host);
			const answer = await heard.next();
			expect(answer.value).toMatchObject({
				v: 1,
				id: "w",
				ok: true,
				result: { conversation: { sessionId: A } },
			});
			await host.stop(A, "parked while idle");
			expect((await untilEnding(heard)).at(-1)).toEqual({
				type: "ending",
				why: "parked",
			});
			socket.destroy();
		});
	});

	it("says released for a close that hands the conversation on, as the host says it", async () => {
		await overSocket({}, async ({ host, path }) => {
			const { socket, heard } = watchOn(path);
			registerA(host);
			await heard.next();
			await host.close(A, "let go to plain pi", true);
			expect((await untilEnding(heard)).at(-1)).toEqual({
				type: "ending",
				why: "released",
			});
			socket.destroy();
		});
	});

	it("refuses a watch it never answered, then sends the ending as a line and hangs up", async () => {
		await overSocket({ aloneWithin: 10 }, async ({ path, life }) => {
			const { heard } = watchOn(path);
			life.resumed("parked");
			const all: unknown[] = [];
			for await (const line of heard) all.push(line);
			expect(all).toEqual([
				expect.objectContaining({
					id: "w",
					ok: false,
					error: expect.objectContaining({ code: "ending" }),
				}),
				{ type: "ending", why: "parked" },
			]);
		});
	});
});
