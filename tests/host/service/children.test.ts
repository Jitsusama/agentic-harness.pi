/**
 * A host passing each request for a conversation a child runs to the child's own socket.
 * Long because it tests one module, children.ts, and its cases share the host, the child
 * and the stand-in child sockets set up here.
 */
import { mkdtemp, rm } from "node:fs/promises";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	childPss,
	heldChildren,
	listingChildren,
	type ReadPss,
} from "../../../host/service/children.ts";
import { controlRequest } from "../../../host/service/client.ts";
import type {
	ControlBackend,
	HostIdentity,
} from "../../../host/service/dispatch.ts";
import { jsonLines } from "../../../host/service/framing.ts";
import {
	type ControlRequest,
	DIRECT_ATTACH,
	parseListResult,
	parseMemoryResult,
	type SessionIdentity,
} from "../../../host/service/protocol.ts";
import {
	listenControl,
	type ViewerSink,
} from "../../../host/service/server.ts";
import { startTicksFromProcSync } from "../../../lib/internal/process-ticks.ts";

const a = "a0000000-0000-4000-8000-000000000001";
const b = "b0000000-0000-4000-8000-000000000002";
const c = "c0000000-0000-4000-8000-000000000003";

/** What one connection is sent, a frame at a time. */
function messages(socket: Socket) {
	const frames = jsonLines();
	const held: unknown[] = [];
	const waiting: ((value: IteratorResult<unknown>) => void)[] = [];
	let ended = false;
	socket.on("data", (chunk: Buffer) => {
		for (const value of frames.push(chunk)) {
			const next = waiting.shift();
			if (next) next({ value, done: false });
			else held.push(value);
		}
	});
	socket.on("close", () => {
		ended = true;
		for (const next of waiting.splice(0))
			next({ value: undefined, done: true });
	});
	return {
		next(): Promise<IteratorResult<unknown>> {
			if (held.length)
				return Promise.resolve({ value: held.shift(), done: false });
			if (ended) return Promise.resolve({ value: undefined, done: true });
			return new Promise((resolve) => waiting.push(resolve));
		},
	};
}

function line(value: unknown) {
	return `${JSON.stringify(value)}\n`;
}

function attaching(sessionId: string, features?: readonly string[]) {
	return line({
		v: 1,
		id: "view",
		op: "attach",
		sessionId,
		rows: 20,
		columns: 80,
		...(features ? { features } : {}),
	});
}

/** Everything a connection is sent until it closes. */
async function untilClosed(seen: ReturnType<typeof messages>) {
	const all: unknown[] = [];
	for (let next = await seen.next(); !next.done; next = await seen.next())
		all.push(next.value);
	return all;
}

let dir: string;
const host: HostIdentity = {
	key: "work-background",
	owner: { pid: process.pid, startedAt: 1 },
};
const child: HostIdentity = {
	key: "work-background",
	owner: { pid: process.pid, startedAt: 2 },
};
let listeners: Awaited<ReturnType<typeof listenControl>>[];
let servers: Server[];
let asked: ControlRequest[];
let childAsked: ControlRequest[];
let viewed: unknown[];
let reported: unknown[];
let said: string[];
let sink: ViewerSink | undefined;
// What the child's attach waits on before it answers, when a test sets it.
let attachWaits: Promise<void> | undefined;
// What the host's own attach does first, when a test says: a wake.
let hostAttach: ((sessionId: string) => void) | undefined;
// The windows the host's own viewer drew.
let hostViewed: string[];
let routes: ReturnType<typeof heldChildren>;
let hostPath: string;
let childPath: string;

function conversation(sessionId: string): SessionIdentity {
	return {
		sessionId,
		file: join(dir, sessionId),
		cwd: dir,
		state: "idle",
		since: "2026-11-19T20:00:00.000Z",
	};
}

/**
 * A child that does what a test says once it is asked, for what a real
 * one would only do by chance: half a frame, an answer under another
 * name, or ending under a window. It runs `conversation`.
 */
async function strangeChild(
	sessionId: string,
	asked: (socket: Socket, request: { id: string }) => void,
	identity: HostIdentity = child,
) {
	const path = join(dir, "host.d", `${sessionId.slice(0, 1)}x.sock`);
	const server = createServer((socket) => {
		const frames = jsonLines();
		let first = true;
		socket.on("data", (chunk: Buffer) => {
			for (const value of frames.push(chunk)) {
				if (!first) continue;
				first = false;
				asked(socket, value as { id: string });
			}
		});
		socket.on("error", () => undefined);
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	servers.push(server);
	routes.hold(conversation(sessionId), { socket: path, identity });
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "children-"));
	hostPath = join(dir, "host.sock");
	// Short, since a socket's path has a limit a test's folder can pass.
	childPath = join(dir, "host.d", "a.sock");
	listeners = [];
	servers = [];
	asked = [];
	childAsked = [];
	viewed = [];
	reported = [];
	said = [];
	sink = undefined;
	attachWaits = undefined;
	hostAttach = undefined;
	hostViewed = [];
	routes = heldChildren();
	const childBackend: ControlBackend = {
		identity: child,
		execute: vi.fn(async (request) => {
			childAsked.push(request);
			if (request.op === "attach") await attachWaits;
			if (request.op === "list")
				return { sessions: [conversation(a)], host: child };
			return "sessionId" in request ? { sessionId: request.sessionId } : null;
		}),
	};
	listeners.push(
		await listenControl({
			path: childPath,
			backend: childBackend,
			report: (error) => reported.push(error),
			viewer: {
				attach(_request, given) {
					sink = given;
					return {
						input: (data) => viewed.push({ input: data }),
						resize: (rows, columns) => viewed.push({ rows, columns }),
						detach: () => viewed.push("detached"),
					};
				},
			},
		}),
	);
	routes.hold(conversation(a), { socket: childPath, identity: child });
	const hostBackend: ControlBackend = {
		identity: host,
		execute: vi.fn(async (request) => {
			asked.push(request);
			if (request.op === "attach") hostAttach?.(request.sessionId);
			if (request.op === "list")
				return { sessions: [conversation(b), conversation(c)], host };
			return "sessionId" in request ? { sessionId: request.sessionId } : null;
		}),
	};
	listeners.push(
		await listenControl({
			path: hostPath,
			backend: hostBackend,
			children: routes,
			report: (error) => reported.push(error),
			say: (words) => said.push(words),
			viewer: {
				attach(request) {
					hostViewed.push(request.sessionId);
					return {
						input: () => undefined,
						resize: () => undefined,
						detach: () => undefined,
					};
				},
			},
		}),
	);
});
afterEach(async () => {
	for (const server of servers) server.close();
	for (const listener of listeners.reverse()) await listener.close();
	await rm(dir, { recursive: true, force: true });
});

describe("a host with conversations in children", () => {
	it("passes a window's attach to the child, and its keys and frames both ways", async () => {
		const window = createConnection(hostPath);
		const seen = messages(window);
		const input = line({ type: "input", data: "hello" });
		// The attach, a whole frame after it and half of one more, in one write.
		window.write(attaching(a) + input + input.slice(0, 9));

		expect((await seen.next()).value).toMatchObject({
			id: "view",
			ok: true,
			result: { sessionId: a },
		});
		window.write(input.slice(9));
		window.write(line({ type: "resize", rows: 24, columns: 100 }));
		await vi.waitFor(() =>
			expect(viewed).toEqual([
				{ input: "hello" },
				{ input: "hello" },
				{ rows: 24, columns: 100 },
			]),
		);
		sink?.write("drawn");
		expect((await seen.next()).value).toEqual({
			type: "output",
			data: "drawn",
		});
		expect(asked, "the host's own thread runs none of it").toEqual([]);
		window.end();
		await vi.waitFor(() => expect(viewed).toContain("detached"));
		expect(reported, "nothing went wrong on the way").toEqual([]);
	});
	it("passes a window on to the child its attach woke the conversation in", async () => {
		// The wake the attach asks for starts the conversation in a child.
		hostAttach = (sessionId) =>
			routes.hold(conversation(sessionId), {
				socket: childPath,
				identity: child,
			});
		const window = createConnection(hostPath);
		const seen = messages(window);
		window.write(attaching(b));

		expect((await seen.next()).value).toMatchObject({
			id: "view",
			ok: true,
			result: { sessionId: b },
		});
		await vi.waitFor(() =>
			expect(childAsked, "the child was asked to attach it").toEqual([
				expect.objectContaining({ op: "attach", sessionId: b }),
			]),
		);
		window.write(line({ type: "input", data: "hello" }));
		await vi.waitFor(() => expect(viewed).toEqual([{ input: "hello" }]));
		expect(hostViewed, "the host's own viewer drew none of it").toEqual([]);
		sink?.write("drawn");
		expect(
			(await seen.next()).value,
			"the child's drawing, with no second answer before it",
		).toEqual({ type: "output", data: "drawn" });
		window.end();
		await vi.waitFor(() => expect(viewed).toContain("detached"));
	});
	// 3e: a window that can join a child itself is told where, so what it
	// types and what it is drawn never cross this host's thread.
	it("names the child's socket to a window that joins children itself, and passes it nothing", async () => {
		const window = createConnection(hostPath);
		window.write(attaching(a, ["edit", DIRECT_ATTACH]));

		expect(
			await untilClosed(messages(window)),
			"one answer, then the end",
		).toEqual([
			{
				v: 1,
				id: "view",
				ok: true,
				result: { sessionId: a, socket: childPath },
			},
		]);
		expect(childAsked, "the child is asked nothing for it").toEqual([]);

		const there = createConnection(childPath);
		const seen = messages(there);
		there.write(attaching(a, ["edit", DIRECT_ATTACH]));
		expect((await seen.next()).value).toMatchObject({
			ok: true,
			result: { sessionId: a },
		});
		there.write(line({ type: "input", data: "hello" }));
		await vi.waitFor(() => expect(viewed).toEqual([{ input: "hello" }]));
		there.end();
		expect(asked, "the host's own thread runs none of it").toEqual([]);
		expect(reported).toEqual([]);
	});
	it("names the child's socket to such a window once its attach woke the conversation there", async () => {
		hostAttach = (sessionId) =>
			routes.hold(conversation(sessionId), {
				socket: childPath,
				identity: child,
			});
		const window = createConnection(hostPath);
		window.write(attaching(b, [DIRECT_ATTACH]));

		expect(await untilClosed(messages(window))).toEqual([
			{
				v: 1,
				id: "view",
				ok: true,
				result: { sessionId: b, socket: childPath },
			},
		]);
		expect(hostViewed, "the host's own viewer drew none of it").toEqual([]);
	});
	it("shows such a window a conversation it runs itself, naming no socket", async () => {
		const window = createConnection(hostPath);
		const seen = messages(window);
		window.write(attaching(b, [DIRECT_ATTACH]));

		expect((await seen.next()).value).toEqual({
			v: 1,
			id: "view",
			ok: true,
			result: { sessionId: b },
		});
		await vi.waitFor(() => expect(hostViewed).toEqual([b]));
		window.end();
	});
	it("says a child it can't reach to such a window, rather than name its socket", async () => {
		routes.hold(conversation(c), {
			socket: join(dir, "host.d", "gone.sock"),
			identity: child,
		});
		const window = createConnection(hostPath);
		window.write(attaching(c, [DIRECT_ATTACH]));

		const answer = (await messages(window).next()).value;
		expect(answer).toMatchObject({
			ok: false,
			error: { code: "child_unreachable" },
		});
		expect(answer, "no socket is named").not.toHaveProperty("result");
		window.end();
	});
	// F26: what a window sent after its attach was meant for the child.
	it("acts on nothing such a window sent after its attach once it names the child's socket", async () => {
		const window = createConnection(hostPath);
		window.write(
			attaching(a, [DIRECT_ATTACH]) +
				line({
					v: 1,
					id: "close",
					op: "close",
					sessionId: a,
					expectedHost: host,
				}),
		);

		expect(
			await untilClosed(messages(window)),
			"the redirect alone, not the close's answer",
		).toEqual([
			{
				v: 1,
				id: "view",
				ok: true,
				result: { sessionId: a, socket: childPath },
			},
		]);
		expect(childAsked, "no close passed on to the child").toEqual([]);
		expect(asked, "nor run by the host").toEqual([]);
	});
	// F57, F58: a socket kept paused never reads the window's end, so the
	// host held it till it closed; and half a line it sent is no fault.
	it("lets such a window's connection go once it ends, whatever it sent after its attach", async () => {
		const pipes = () =>
			process.getActiveResourcesInfo().filter((kind) => kind === "PipeWrap")
				.length;
		const before = pipes();
		const window = createConnection(hostPath);
		const seen = messages(window);
		const input = line({ type: "input", data: "hello" });
		// Half a line with the attach, and the rest after its answer.
		window.write(attaching(a, [DIRECT_ATTACH]) + input.slice(0, 9));
		expect((await seen.next()).value).toMatchObject({
			result: { sessionId: a, socket: childPath },
		});
		window.write(input.slice(9));
		await untilClosed(seen);
		await vi.waitFor(() =>
			expect(pipes(), "the host let its end of it go").toBe(before),
		);
		expect(reported, "half a line after the attach is no fault").toEqual([]);
	});

	it("asks the child to end its conversation under the child's own name", async () => {
		const reply = await controlRequest(hostPath, {
			v: 1,
			id: "close",
			op: "close",
			sessionId: a,
			expectedHost: host,
		});

		expect(reply).toMatchObject({ ok: true, result: { sessionId: a } });
		expect(childAsked).toEqual([
			expect.objectContaining({ op: "close", expectedHost: child }),
		]);
		expect(asked).toEqual([]);
	});
	it("ends a child's conversation asked under the child's name, as the child lists it", async () => {
		// The machine's host registry, and so a mesh presence, names the
		// child's process for a conversation a child runs.
		const reply = await controlRequest(hostPath, {
			v: 1,
			id: "close",
			op: "close",
			sessionId: a,
			expectedHost: child,
		});

		expect(reply).toMatchObject({ ok: true, result: { sessionId: a } });
		expect(childAsked).toEqual([
			expect.objectContaining({ op: "close", expectedHost: child }),
		]);
		expect(asked).toEqual([]);
	});
	it("refuses one child's name for a conversation another child runs", async () => {
		const other: HostIdentity = {
			key: "work-background",
			owner: { pid: process.pid, startedAt: 3 },
		};
		const reached: unknown[] = [];
		await strangeChild(c, (_socket, request) => reached.push(request), other);

		const reply = await controlRequest(hostPath, {
			v: 1,
			id: "close",
			op: "close",
			sessionId: c,
			expectedHost: child,
		});

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "stale_host" },
		});
		expect(reached, "the child running it was never asked").toEqual([]);
		expect(childAsked).toEqual([]);
		expect(asked).toEqual([]);
	});
	it("refuses a child's name for a conversation this host runs itself", async () => {
		const reply = await controlRequest(hostPath, {
			v: 1,
			id: "close",
			op: "close",
			sessionId: b,
			expectedHost: child,
		});

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "stale_host" },
		});
		expect(asked).toEqual([]);
	});
	it("answers what is asked after a child's answer itself, on the same connection", async () => {
		const caller = createConnection(hostPath);
		const seen = messages(caller);
		caller.write(
			line({
				v: 1,
				id: "abort",
				op: "abort",
				sessionId: a,
				expectedHost: host,
			}),
		);
		expect((await seen.next()).value).toMatchObject({ id: "abort", ok: true });
		caller.write(line({ v: 1, id: "list", op: "list" }));

		expect((await seen.next()).value).toMatchObject({
			id: "list",
			result: { host },
		});
		expect(asked, "the host answered the list").toEqual([
			expect.objectContaining({ op: "list" }),
		]);
		caller.end();
	});
	it("refuses a request naming another host before the child hears of it", async () => {
		const reply = await controlRequest(hostPath, {
			v: 1,
			id: "close",
			op: "close",
			sessionId: a,
			expectedHost: { ...host, owner: { pid: process.pid, startedAt: 9 } },
		});

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "stale_host" },
		});
		expect(childAsked).toEqual([]);
	});
	it("says a child answering as another process doesn't answer, not that the caller's host changed", async () => {
		await strangeChild(b, (socket, request) => {
			socket.write(
				line({
					v: 1,
					id: request.id,
					ok: false,
					error: { code: "stale_host", message: "refresh discovery" },
				}),
			);
		});
		const reply = await controlRequest(hostPath, {
			v: 1,
			id: "close",
			op: "close",
			sessionId: b,
			expectedHost: host,
		});

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "child_unreachable" },
		});
	});
	it("keeps a conversation the host runs itself on the host", async () => {
		const reply = await controlRequest(hostPath, {
			v: 1,
			id: "abort",
			op: "abort",
			sessionId: b,
			expectedHost: host,
		});

		expect(reply).toMatchObject({ ok: true, result: { sessionId: b } });
		expect(asked).toEqual([expect.objectContaining({ sessionId: b })]);
		expect(childAsked).toEqual([]);
	});
	it("lists the children's conversations with its own, each once", async () => {
		routes.hold(conversation(b), { socket: childPath, identity: child });
		routes.update({ ...conversation(b), state: "busy" });
		const reply = await controlRequest(hostPath, {
			v: 1,
			id: "list",
			op: "list",
		});

		expect(reply).toMatchObject({
			ok: true,
			result: {
				host,
				sessions: [
					conversation(c),
					conversation(a),
					{ ...conversation(b), state: "busy" },
				],
			},
		});
	});
	it("says a child that doesn't answer doesn't, and the host's own keep answering", async () => {
		routes.hold(conversation(a), {
			socket: join(dir, "gone.sock"),
			identity: child,
		});
		const gone = await controlRequest(hostPath, {
			v: 1,
			id: "abort",
			op: "abort",
			sessionId: a,
			expectedHost: host,
		});
		routes.drop(a);
		const back = await controlRequest(hostPath, {
			v: 1,
			id: "abort",
			op: "abort",
			sessionId: a,
			expectedHost: host,
		});

		expect(gone).toMatchObject({
			ok: false,
			error: { code: "child_unreachable" },
		});
		expect(back, "a dropped route is the host's again").toMatchObject({
			ok: true,
		});
	});
	it("says a child that takes a request and ends without answering doesn't answer", async () => {
		await strangeChild(b, (socket) => socket.destroy());
		const reply = await controlRequest(hostPath, {
			v: 1,
			id: "close",
			op: "close",
			sessionId: b,
			expectedHost: host,
		});

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "child_unreachable" },
		});
	});
	it("tells a window why when the child running its conversation ends under it", async () => {
		let childSide: Socket | undefined;
		await strangeChild(b, (socket, request) => {
			childSide = socket;
			socket.write(line({ v: 1, id: request.id, ok: true, result: {} }));
		});
		const window = createConnection(hostPath);
		const seen = messages(window);
		window.write(attaching(b));
		expect((await seen.next()).value).toMatchObject({ ok: true });
		childSide?.destroy();

		expect((await seen.next()).value).toMatchObject({ type: "detached" });
		expect((await seen.next()).done, "the window's connection ends").toBe(true);
		expect(said).toEqual([expect.stringContaining("ended under")]);
	});
	it("tells a window attached through it that it restarts once the child's frame ends, and leaves the child", async () => {
		let childSide: Socket | undefined;
		await strangeChild(b, (socket, request) => {
			childSide = socket;
			socket.write(line({ v: 1, id: request.id, ok: true, result: {} }));
		});
		const window = createConnection(hostPath);
		const seen = messages(window);
		window.write(attaching(b));
		expect((await seen.next()).value).toMatchObject({ ok: true });
		const frame = line({ type: "output", data: "drawn" });
		childSide?.write(frame.slice(0, 10));
		// The half frame reaches the host before it is told it restarts.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const told = listeners[1]?.restarting();
		childSide?.write(frame.slice(10));
		expect((await seen.next()).value, "the frame it was being sent").toEqual({
			type: "output",
			data: "drawn",
		});
		expect((await seen.next()).value).toEqual({ type: "restarting" });
		expect((await seen.next()).done, "the window's connection ends").toBe(true);
		await told;
	});
	it("answers an attach before it says it restarts, when it restarts while the child is answering", async () => {
		let answer: () => void = () => undefined;
		attachWaits = new Promise((resolve) => {
			answer = resolve;
		});
		const window = createConnection(hostPath);
		const seen = messages(window);
		window.write(attaching(a));
		await vi.waitFor(() =>
			expect(childAsked).toEqual([expect.objectContaining({ op: "attach" })]),
		);

		const told = listeners[1]?.restarting();
		answer();
		expect((await seen.next()).value).toMatchObject({ id: "view", ok: true });
		expect((await seen.next()).value).toEqual({ type: "restarting" });
		await told;
		await vi.waitFor(() => expect(viewed).toContain("detached"));
	});
	it("stops reading a child whose window reads nothing, rather than keep what it draws", async () => {
		const DRAWN = 64 * 1024 * 1024;
		let childSide: Socket | undefined;
		await strangeChild(b, (socket, request) => {
			childSide = socket;
			socket.write(line({ v: 1, id: request.id, ok: true, result: {} }));
			socket.write(Buffer.alloc(DRAWN, 0x61));
		});
		const window = createConnection(hostPath);
		const seen = messages(window);
		window.write(attaching(b));
		expect((await seen.next()).value).toMatchObject({ ok: true });
		window.pause();
		// Time for a host that kept reading to drain the child: what is
		// measured is that nothing drains while the window reads nothing.
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(
			childSide?.writableLength,
			"most of what it drew still waits in the child",
		).toBeGreaterThan(DRAWN / 2);
		window.destroy();
	});
});

describe("a host's memory with conversations in children", () => {
	const at = "2026-11-24T07:30:00.000Z";
	// A child of its own pid, so a Pss read for the host's shows as wrong.
	const running: HostIdentity = {
		...child,
		owner: { pid: process.pid + 1, startedAt: 2 },
	};
	// The host answering for itself, a conversation it runs parked among them.
	const own: ControlBackend = {
		identity: host,
		execute: async () => ({
			host,
			own: { heap: { used: 1, limit: 2, at } },
			sessions: [{ sessionId: b, state: "parked" }],
		}),
	};
	async function measured(pss: ReadPss) {
		const held = heldChildren(() => new Date(at));
		held.hold(conversation(a), { socket: childPath, identity: running });
		held.update(conversation(a), { used: 200, limit: 4000 });
		return listingChildren(own, held, pss).execute({
			v: 1,
			id: "m",
			op: "memory",
		});
	}

	it("answers a child's last heap and the Pss read for its process", async () => {
		const read: HostIdentity["owner"][] = [];
		const answer = await measured(async (owner) => {
			read.push(owner);
			return 3000;
		});

		expect(answer).toStrictEqual({
			host,
			own: { heap: { used: 1, limit: 2, at } },
			sessions: [
				{ sessionId: b, state: "parked" },
				{
					sessionId: a,
					state: "idle",
					heap: { used: 200, limit: 4000, at },
					pss: 3000,
				},
			],
		});
		expect(read, "the child's own process, not the host's").toEqual([
			running.owner,
		]);
		expect(parseMemoryResult(answer), "as a client reads it").toStrictEqual(
			answer,
		);
	});
	it("answers a list without a child's heap, which a client reading it strictly would refuse", async () => {
		const held = heldChildren(() => new Date(at));
		held.hold(conversation(a), { socket: childPath, identity: running });
		held.update(conversation(a), { used: 200, limit: 4000 });
		const listing: ControlBackend = {
			identity: host,
			execute: async () => ({ host, sessions: [] }),
		};

		const answer = await listingChildren(
			listing,
			held,
			async () => 3000,
		).execute({
			v: 1,
			id: "l",
			op: "list",
		});

		expect(parseListResult(answer)).toStrictEqual({
			host,
			sessions: [conversation(a)],
		});
	});
	it("answers no Pss for a child gone before it was read, keeping its heap", async () => {
		const answer = await measured(async () => undefined);

		expect(answer).toStrictEqual({
			host,
			own: { heap: { used: 1, limit: 2, at } },
			sessions: [
				{ sessionId: b, state: "parked" },
				{ sessionId: a, state: "idle", heap: { used: 200, limit: 4000, at } },
			],
		});
	});
	it("keeps a child's last heap through a state line that carries none", () => {
		const held = heldChildren(() => new Date(at));
		held.hold(conversation(a), { socket: childPath, identity: running });
		held.update(conversation(a), { used: 200, limit: 4000 });

		held.update({ ...conversation(a), state: "busy" });

		expect(held.held()).toStrictEqual([
			{
				conversation: { ...conversation(a), state: "busy" },
				route: { socket: childPath, identity: running },
				heap: { used: 200, limit: 4000, at },
			},
		]);
	});
	it("reads a child's Pss only while its pid is the process that started", async () => {
		const owner = { pid: 4242, startedAt: 1, startTicks: 700 };
		const proc = (ticks: number | undefined, pss = 3000) => ({
			pss: async (pid: number) => (pid === 4242 ? pss : undefined),
			startTicks: async (pid: number) => (pid === 4242 ? ticks : undefined),
		});

		expect(await childPss(owner, proc(700)), "still the child").toBe(3000);
		expect(await childPss(owner, proc(701)), "its pid reused").toBeUndefined();
		expect(
			await childPss(owner, proc(undefined)),
			"gone between the two reads",
		).toBeUndefined();
		expect(
			await childPss({ pid: 4242, startedAt: 1 }, proc(700)),
			"an owner kept without ticks to tell",
		).toBeUndefined();
	});
	it("reads a child's ticks once its Pss is read, so a pid taken between the two is caught", async () => {
		const owner = { pid: 4242, startedAt: 1, startTicks: 700 };
		// The pid is taken by another process by the time its Pss is read,
		// so ticks read first, or beside it, still name the child.
		let taken = false;
		const proc = {
			pss: async () => {
				await Promise.resolve();
				taken = true;
				return 3000;
			},
			startTicks: async () => (taken ? 701 : 700),
		};

		expect(await childPss(owner, proc)).toBeUndefined();
	});
	it.runIf(process.platform === "linux")(
		"reads a child's Pss from procfs only while its pid is still the process that started",
		async () => {
			const ticks = startTicksFromProcSync(process.pid);
			const self = { pid: process.pid, startedAt: 1, startTicks: ticks };

			expect(await childPss(self), "this process").toBeGreaterThan(1024 * 1024);
			expect(
				await childPss({ ...self, startTicks: (ticks ?? 0) + 1 }),
				"its pid taken by another process",
			).toBeUndefined();
			expect(
				await childPss({ ...self, pid: 2 ** 22 + 1 }),
				"no such process, past the kernel's highest pid",
			).toBeUndefined();
		},
	);
});
