/** A host's life: refuse before listening, resume what it holds, keep holds on stop. */
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHost } from "../../../host/engine/index.ts";
import type {
	ConversationEngine,
	ConversationEvents,
} from "../../../host/service/backend.ts";
import { slotFolder } from "../../../host/service/child-units.ts";
import { controlRequest } from "../../../host/service/client.ts";
import {
	parseListResult,
	parseOpenResult,
} from "../../../host/service/protocol.ts";
import { serveHost } from "../../../host/service/serve.ts";
import { heldSessionStatus } from "../../../lib/core/session/roster.ts";
import { until } from "../../support/until.ts";
import {
	conversationIn,
	derivedIn,
	fakeUnits,
} from "./support/fake-children.ts";

// The net is process-wide, so the worker running these tests keeps its
// own handling; what is checked is that a host sets it, and where.
const { spared } = vi.hoisted(() => ({ spared: vi.fn() }));
vi.mock("../../../lib/internal/reload/stale-rejections.ts", () => ({
	spareStaleRejections: spared,
}));

let dir: string;
// The runtime folder, made apart from `dir` and short, since a child's
// socket sits three names below it and a Unix socket's path can't pass
// 107 bytes.
let run: string;
let report: ReturnType<typeof vi.fn<(error: unknown) => void>>;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-serve-"));
	run = await mkdtemp(join(tmpdir(), "r"));
	report = vi.fn();
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	await rm(run, { recursive: true, force: true });
});

function places() {
	return {
		realm: "work",
		kind: "attended" as const,
		runtimeDir: run,
		rosterDir: join(dir, "rosters"),
		registryDir: join(dir, "hosts"),
		rejectionLog: join(dir, "stale-rejections.jsonl"),
		report,
	};
}

async function opened(path: string, id: string) {
	return controlRequest(path, {
		v: 1,
		id,
		op: "open",
		cwd: "/work",
		attended: true,
	});
}

/**
 * A fake engine over the real SessionHost, as H1's registers, which
 * fails to resume each conversation in `refused`.
 */
function engine(
	host: SessionHost,
	refused = new Set<string>(),
): ConversationEngine {
	const register = (c: { sessionId: string; file: string; cwd: string }) =>
		host.register({
			id: c.sessionId,
			file: c.file,
			cwd: c.cwd,
			env: {},
			close: () => {},
		});
	return {
		prepare: async (request) => ({
			sessionId: randomUUID(),
			file: join(dir, `${randomUUID()}.jsonl`),
			cwd: request.op === "open" ? request.cwd : dir,
		}),
		start: async (prepared) => register(prepared),
		discard: async () => {},
		resume: async (entry) => {
			if (refused.has(entry.sessionId)) throw new Error("pi would not open it");
			register(entry);
		},
		abort: async () => {},
		backgroundOf: () => 0,
	};
}

async function listed(path: string) {
	const reply = await controlRequest(path, { v: 1, id: "l", op: "list" });
	if (!reply.ok) throw new Error(reply.error.message);
	return parseListResult(reply.result);
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

describe("serveHost", () => {
	it("refuses a second host of one key before it touches the socket", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		try {
			// A start waits a minute on a host still running; none here.
			await expect(
				serveHost({
					...places(),
					rosterWait: { within: 0 },
					engine: async (h) => engine(h),
				}),
			).rejects.toThrow("Another host holds this roster");
			expect((await listed(first.path)).host).toEqual(first.identity);
		} finally {
			await first.stop();
		}
	});

	it("refuses to listen on a pi the engine won't run, and frees the lock", async () => {
		const refused = new Error("Host pi lacks pi-host-committed-turn.patch");
		await expect(
			serveHost({
				...places(),
				engine: async () => {
					throw refused;
				},
			}),
		).rejects.toBe(refused);
		expect(
			await exists(join(run, "pi-host", "work-attended.sock")),
			"a refused host left no socket",
		).toBe(false);
		const next = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		await next.stop();
	});

	it("spares the host stale-context rejections before any conversation", async () => {
		spared.mockClear();
		const host = await serveHost({
			...places(),
			engine: async (h) => {
				expect(spared).toHaveBeenCalledWith(
					join(dir, "stale-rejections.jsonl"),
				);
				return engine(h);
			},
		});
		await host.stop();
		expect(spared).toHaveBeenCalledTimes(1);
	});

	it("admits a second conversation when given no gate, even run from a tree", async () => {
		const host = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		try {
			expect((await opened(host.path, "a")).ok, "the first").toBe(true);
			expect((await opened(host.path, "b")).ok, "the second").toBe(true);
			expect((await listed(host.path)).sessions).toHaveLength(2);
		} finally {
			await host.stop();
		}
	});

	it.each([
		[
			"tells an attached viewer it restarts as it stops, once a restart is coming",
			true,
		],
		[
			"tells an attached viewer nothing as it stops for any other reason",
			false,
		],
	])("%s", async (_case, coming) => {
		const served = await serveHost({
			...places(),
			engine: async (h) => engine(h),
			viewer: () => ({
				attach: () => ({ input() {}, resize() {}, detach() {} }),
			}),
		});
		const reply = await opened(served.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		const socket = createConnection(served.path);
		let heard = "";
		const attached = new Promise<void>((resolve) =>
			socket.on("data", (chunk) => {
				heard += String(chunk);
				if (heard.includes('"id":"view"')) resolve();
			}),
		);
		const closed = new Promise<void>((resolve) => socket.on("close", resolve));
		socket.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId, rows: 20, columns: 80 })}\n`,
		);
		await attached;

		served.restartComing(coming);
		await served.stop();
		await closed;
		const frames = heard
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(
			frames.some((frame) => frame.type === "restarting"),
			"whether the viewer heard the host is restarting",
		).toBe(coming);
	});

	it.each([
		[
			"carries every conversation's calls at any stop, where the engine keeps them",
			true,
		],
		[
			"carries nothing at a plain stop, where the engine can't keep them",
			false,
		],
		[
			"carries nothing at a plain stop, where the engine can't say it keeps them",
			undefined,
		],
	])("%s", async (_case, carries) => {
		const told: string[] = [];
		let kept = 0;
		const served = await serveHost({
			...places(),
			engine: async (h) => {
				const plain = engine(h);
				return {
					...plain,
					start: async (prepared) =>
						h.register({
							id: prepared.sessionId,
							file: prepared.file,
							cwd: prepared.cwd,
							env: {},
							close: () => {},
							restarting: () => told.push(prepared.sessionId),
						}),
					...(carries !== undefined ? { carries: () => carries } : {}),
					keepCarried: async () => {
						kept += 1;
					},
				};
			},
		});
		const reply = await opened(served.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);

		await served.stop();
		expect(told, "the conversations told to carry their calls").toEqual(
			carries ? [sessionId] : [],
		);
		expect(kept, "how often the engine kept what they carried").toBe(
			carries ? 1 : 0,
		);
	});

	it("keeps every hold across stop and resumes them at the next start", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		const ids: string[] = [];
		for (const id of ["a", "b"]) {
			const reply = await opened(first.path, id);
			if (!reply.ok) throw new Error(reply.error.message);
			ids.push(parseOpenResult(reply.result).sessionId);
		}
		await first.stop();
		const [kept, failed] = ids as [string, string];
		for (const id of ids)
			expect(await heldSessionStatus(id, { dir: join(dir, "rosters") })).toBe(
				"held",
			);

		const second = await serveHost({
			...places(),
			engine: async (h) => engine(h, new Set([failed])),
		});
		try {
			expect(second.unresumed.map(({ sessionId }) => sessionId)).toEqual([
				failed,
			]);
			expect(report).toHaveBeenCalledWith(new Error("pi would not open it"));
			expect(
				(await listed(second.path)).sessions.map(({ sessionId, state }) => [
					sessionId,
					state,
				]),
			).toEqual([
				[kept, "idle"],
				[failed, "parked"],
			]);
			expect(second.stillUnresumed(), "still held, not running").toBe(1);
			const closed = await controlRequest(second.path, {
				v: 1,
				id: "c",
				op: "close",
				sessionId: failed,
				expectedHost: second.identity,
			});
			if (!closed.ok) throw new Error(closed.error.message);
			expect(second.stillUnresumed(), "once it is closed").toBe(0);
			expect(second.unresumed, "what the start found").toHaveLength(1);
		} finally {
			await second.stop();
		}
	});

	it("lets a wake under way finish before a stop parks, so it stays held and stops with the rest", async () => {
		let sessionHost: SessionHost | undefined;
		let events: ConversationEvents | undefined;
		let resumed: (() => void) | undefined;
		const waking = new Promise<void>((resolve) => {
			resumed = resolve;
		});
		let resuming = false;
		const serving = await serveHost({
			...places(),
			engine: async (h) => {
				sessionHost = h;
				const plain = engine(h);
				return {
					...plain,
					watch: (given) => {
						events = given;
					},
					resume: async (entry) => {
						resuming = true;
						await waking;
						await plain.resume(entry);
					},
				};
			},
		});
		const reply = await opened(serving.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await sessionHost?.stop(sessionId, "parked while idle");

		const woke = events?.wake?.(sessionId);
		await until("the wake to resume it", () => resuming);
		const stopped = serving.stop();
		// Resumed only once the stop has closed its socket, as it would go on
		// to park and dispose the host.
		await until(
			"the stop to close its socket",
			async () => !(await exists(serving.path)),
		);
		resumed?.();
		await expect(
			woke,
			"the wake resumed it in a host not yet disposed",
		).resolves.toBeUndefined();
		await stopped;

		expect(
			sessionHost?.list().map(({ id }) => id),
			"the stop parked what the wake resumed, leaving nothing running",
		).toEqual([]);
		expect(
			await heldSessionStatus(sessionId, { dir: join(dir, "rosters") }),
			"it stays held for the next start",
		).toBe("held");
	});

	it("refuses a wake that comes once the host is stopping, saying the next start takes it up", async () => {
		let sessionHost: SessionHost | undefined;
		let events: ConversationEvents | undefined;
		let resumes = 0;
		const serving = await serveHost({
			...places(),
			engine: async (h) => {
				sessionHost = h;
				const plain = engine(h);
				return {
					...plain,
					watch: (given) => {
						events = given;
					},
					resume: async (entry) => {
						resumes += 1;
						await plain.resume(entry);
					},
				};
			},
		});
		const reply = await opened(serving.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await sessionHost?.stop(sessionId, "parked while idle");

		const stopped = serving.stop();
		const woke = events?.wake?.(sessionId);

		await expect(
			woke,
			"the wake says why nothing wakes it, so its window can say so",
		).rejects.toThrow(
			"the host is stopping, and takes the conversation up again as it starts",
		);
		await stopped;
		expect(resumes, "nothing resumed in the stopping host").toBe(0);
		expect(
			await heldSessionStatus(sessionId, { dir: join(dir, "rosters") }),
			"it stays held for the next start",
		).toBe("held");
	});

	it("leaves one still parked from before the start parked, waking it once listening for a wake asked as it started", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		const reply = await opened(first.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await first.stop();

		let events: ConversationEvents | undefined;
		let woke: Promise<void> | undefined;
		const resumes: (boolean | undefined)[] = [];
		const second = await serveHost({
			...places(),
			engine: async (h) => {
				const plain = engine(h);
				return {
					...plain,
					watch: (given) => {
						events = given;
					},
					// A message wrote its wake file while the host was down.
					restsParked: (entry) => {
						woke = events?.wake?.(entry.sessionId);
						return true;
					},
					resume: async (entry, woken) => {
						resumes.push(woken);
						await plain.resume(entry);
					},
				};
			},
		});
		try {
			expect(second.unresumed, "nothing failed to resume").toEqual([]);
			await woke;
			expect(
				resumes,
				"built once, by the wake, rather than by the start",
			).toEqual([true]);
			expect(
				(await listed(second.path)).sessions.map(({ sessionId: id, state }) => [
					id,
					state,
				]),
				"the wake left it running",
			).toEqual([[sessionId, "idle"]]);
		} finally {
			await second.stop();
		}
	});

	it("listens before it resumes, listing one it has yet to resume as parked until it has", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		const reply = await opened(first.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await first.stop();

		let go = (): void => undefined;
		const going = new Promise<void>((resolve) => {
			go = resolve;
		});
		const starting = serveHost({
			...places(),
			engine: async (h) => {
				const plain = engine(h);
				return {
					...plain,
					resume: async (entry, woken) => {
						await going;
						await plain.resume(entry, woken);
					},
				};
			},
		});
		const path = join(run, "pi-host", "work-attended.sock");
		// The file appears at bind, but the host drops a connection until it
		// has set the socket's mode, so wait for an answer, not the file.
		await until("the host to answer as it starts", () =>
			listed(path).then(
				() => true,
				() => false,
			),
		);
		expect(
			(await listed(path)).sessions.map(({ sessionId: id, state }) => [
				id,
				state,
			]),
			"held, not yet resumed",
		).toEqual([[sessionId, "parked"]]);
		go();
		const second = await starting;
		try {
			expect(
				(await listed(second.path)).sessions.map(({ sessionId: id, state }) => [
					id,
					state,
				]),
				"resumed once the start is done",
			).toEqual([[sessionId, "idle"]]);
		} finally {
			await second.stop();
		}
	});

	it("watches the engine before it resumes, so a conversation that ends inside pi is dropped", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		const reply = await opened(first.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await first.stop();

		const order: string[] = [];
		let events: ConversationEvents | undefined;
		const second = await serveHost({
			...places(),
			engine: async (h) => {
				const plain = engine(h);
				return {
					...plain,
					watch: (given) => {
						order.push("watch");
						events = given;
					},
					resume: async (entry) => {
						order.push("resume");
						await plain.resume(entry);
					},
				};
			},
		});
		try {
			expect(order).toEqual(["watch", "resume"]);
			await events?.ended(sessionId, "quit");
			expect(
				await heldSessionStatus(sessionId, { dir: join(dir, "rosters") }),
			).toBe("unheld");
		} finally {
			await second.stop();
		}
	});
});

describe("serveHost with children", () => {
	it("resumes a moved conversation in a child, leaves it running through a stop, and takes it up again", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		const reply = await opened(first.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await first.stop();

		const units = fakeUnits(
			slotFolder(run, "work-attended"),
			"work-attended",
			report,
		);
		const said: string[] = [];
		const withChildren = {
			...places(),
			say: (words: string) => said.push(words),
			children: {
				units,
				policy: async () => ({
					moves: (id: string) => id === sessionId,
					opens: () => false,
					close: () => undefined,
				}),
			},
		};
		const inHost = vi.fn();
		const second = await serveHost({
			...withChildren,
			engine: async (h) => ({ ...engine(h), resume: inHost }),
		});
		try {
			expect(second.unresumed, "every one resumed").toEqual([]);
			expect(units.started, "its child started").toHaveLength(1);
			expect(inHost, "the host resumed none of it").not.toHaveBeenCalled();
			expect(second.inChildren?.(), "counted as a child's").toBe(1);
			expect(second.stillUnresumed(), "resumed, in its child").toBe(0);
		} finally {
			await second.stop();
		}
		expect(units.stopped, "no child stopped with the host").toEqual([]);
		expect(units.childOf(sessionId), "its child runs on").toBeDefined();

		const third = await serveHost({
			...withChildren,
			engine: async (h) => ({ ...engine(h), resume: inHost }),
		});
		try {
			expect(units.started, "taken up, not started again").toHaveLength(1);
			expect(inHost).not.toHaveBeenCalled();
			expect(said).toContain("took up 1 child an earlier host left running");
			expect(third.inChildren?.()).toBe(1);
		} finally {
			await third.stop();
			for (const child of units.children.values()) await child?.exit();
		}
		expect(report, "nothing went wrong on the way").not.toHaveBeenCalled();
	});

	it("names in a repeat of a child's open the conversation that child's became", async () => {
		const folder = slotFolder(run, "work-attended");
		const units = fakeUnits(folder, "work-attended", report);
		const host = await serveHost({
			...places(),
			children: {
				units,
				policy: async () => ({
					moves: () => false,
					opens: () => true,
					close: () => undefined,
				}),
			},
			engine: async (h) => engine(h),
		});
		try {
			const first = await opened(host.path, "spawn-1");
			if (!first.ok) throw new Error(first.error.message);
			const { sessionId } = parseOpenResult(first.result);
			const child = units.childOf(sessionId);
			const next = randomUUID();
			child.conversation = conversationIn(folder, next);
			child.entry = derivedIn(folder, next);
			child.say({
				type: "became",
				previousId: sessionId,
				conversation: child.conversation,
				entry: child.entry,
			});
			// Asked again until it lands: a repeat before the became reaches
			// the backend answers the first as parked, opening nothing.
			await until(
				"a repeat to name the conversation as it is called now",
				async () => {
					const repeat = await opened(host.path, "spawn-1");
					return repeat.ok && parseOpenResult(repeat.result).sessionId === next;
				},
			);
			expect(units.started, "nothing opened again").toHaveLength(1);
			expect(report, "nothing went wrong on the way").not.toHaveBeenCalled();
		} finally {
			await host.stop();
			for (const child of units.children.values()) await child?.exit();
		}
	});

	it("runs every conversation itself when no child's socket would fit, saying so", async () => {
		// Long enough that a child's socket, 39 bytes further down than the
		// host's, passes the limit while the host's still fits.
		const long = join(run, "x".repeat(60 - run.length));
		await mkdir(long, { mode: 0o700 });
		const at = { ...places(), runtimeDir: long };
		const first = await serveHost({ ...at, engine: async (h) => engine(h) });
		const reply = await opened(first.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await first.stop();

		const units = fakeUnits(
			slotFolder(long, "work-attended"),
			"work-attended",
			report,
		);
		const said: string[] = [];
		const closed = vi.fn();
		const inHost = vi.fn();
		const second = await serveHost({
			...at,
			say: (words: string) => said.push(words),
			children: {
				units,
				policy: async () => ({
					moves: (id: string) => id === sessionId,
					opens: () => true,
					close: closed,
				}),
			},
			engine: async (h) => ({ ...engine(h), resume: inHost }),
		});
		try {
			expect(second.unresumed, "every one resumed").toEqual([]);
			expect(inHost, "the host resumed it itself").toHaveBeenCalledTimes(1);
			expect(units.started, "no child started").toEqual([]);
			expect(second.inChildren?.() ?? 0, "none counted as a child's").toBe(0);
			expect(closed, "the policy let go").toHaveBeenCalled();
			expect(said).toContain(
				"runs every conversation itself, since no child could be set up",
			);
			expect(report, "the reason is reported").toHaveBeenCalledTimes(1);
		} finally {
			await second.stop();
		}
	});
});
