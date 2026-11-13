/** Real sockets around a fake engine and H1's two-session ownership. */
import { chmod, link, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import { hostRealm, hostSocketPath } from "../../../host/service/address.ts";
import { controlRequest } from "../../../host/service/client.ts";
import type { ControlBackend } from "../../../host/service/dispatch.ts";
import { jsonLines } from "../../../host/service/framing.ts";
import type { ControlRequest } from "../../../host/service/protocol.ts";
import {
	listenControl,
	type ViewerBridge,
} from "../../../host/service/server.ts";
import { terminalBridge } from "../../../host/service/viewer.ts";
import { ambientSession } from "../../../lib/core/session/index.ts";
import { ViewerTerminal } from "../../../lib/core/viewer/terminal.ts";

const a = "a0000000-0000-4000-8000-000000000001";
const b = "b0000000-0000-4000-8000-000000000002";
const list: ControlRequest = { v: 1, id: "list", op: "list" };

async function* readMessages(socket: Socket) {
	const frames = jsonLines();
	for await (const chunk of socket) {
		for (const value of frames.push(
			typeof chunk === "string" ? Buffer.from(chunk) : chunk,
		))
			yield value;
	}
	frames.end();
}

let dir: string;
let path: string;
let host: SessionHost;
let backend: ControlBackend;
let listener: Awaited<ReturnType<typeof listenControl>> | undefined;
let cleanup = vi.fn<(why: string) => void>();
let report = vi.fn<(error: unknown) => void>();
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-"));
	path = join(dir, "host.sock");
	host = new SessionHost({
		key: "work-attended",
		owner: { pid: process.pid, startedAt: 1 },
		registryDir: dir,
	});
	cleanup = vi.fn();
	report = vi.fn();
	for (const id of [a, b])
		host.register({
			id,
			file: join(dir, id),
			cwd: dir,
			env: {},
			close: cleanup,
		});
	backend = {
		identity: { key: host.key, owner: host.owner },
		execute: vi.fn(async (request) => {
			if (request.op === "list") return host.list();
			if ("sessionId" in request) return { sessionId: ambientSession() };
			return null;
		}),
	};
});
afterEach(async () => {
	await listener?.close();
	listener = undefined;
	for (const { id } of host.list()) await host.stop(id);
	host.dispose();
	await rm(dir, { recursive: true, force: true });
});
async function start(viewer?: ViewerBridge) {
	listener = await listenControl({ path, backend, viewer, report });
}

describe("private control listener", () => {
	it("names the session's realm, else the machine's home, and never guesses", () => {
		expect(hostRealm({ MYCELIUM_REALM: " work ", PI_HOME_REALM: "home" })).toBe(
			"work",
		);
		expect(hostRealm({ MYCELIUM_REALM: "", PI_HOME_REALM: "home" })).toBe(
			"home",
		);
		expect(() => hostRealm({})).toThrow("MYCELIUM_REALM");
		expect(() => hostRealm({ MYCELIUM_REALM: "Work/../x" })).toThrow("realm");
	});
	it("selects safe realm-kind addresses without silent path truncation", () => {
		expect(hostSocketPath("work", "attended", dir)).toBe(
			join(dir, "pi-host/work-attended.sock"),
		);
		expect(() => hostSocketPath("../work", "attended", dir)).toThrow("realm");
		expect(() => hostSocketPath("work", "background", "relative")).toThrow(
			"absolute",
		);
		expect(() =>
			hostSocketPath("work", "background", `/${"x".repeat(104)}`),
		).toThrow("limit");
	});
	it("creates a private socket and correlates concurrent sessions through H1", async () => {
		await start();
		expect((await lstat(path)).mode & 0o777).toBe(0o600);
		const replies = await Promise.all(
			[a, b].map((sessionId) =>
				controlRequest(path, {
					v: 1,
					id: sessionId,
					op: "abort",
					sessionId,
					expectedHost: { key: host.key, owner: host.owner },
				}),
			),
		);
		expect(replies.map((r) => r.ok && r.result)).toEqual([
			{ sessionId: a },
			{ sessionId: b },
		]);
		expect(host.list()).toHaveLength(2);
		expect(cleanup).not.toHaveBeenCalled();
	});
	it("refuses an existing live socket without unlinking it", async () => {
		await start();
		await expect(listenControl({ path, backend, report })).rejects.toThrow();
		expect(await controlRequest(path, list)).toMatchObject({ ok: true });
	});
	it("takes over the socket a killed host left, which nothing answers", async () => {
		// A killed process never unlinks its socket, and node always does on
		// close, so a second name for the socket is what outlives it here.
		const killed = createServer();
		const original = join(dir, "killed.sock");
		await new Promise<void>((resolve) => killed.listen(original, resolve));
		await link(original, path);
		await new Promise<void>((resolve) => killed.close(() => resolve()));
		await start();
		expect(await controlRequest(path, list)).toMatchObject({ ok: true });
	});
	it("refuses a regular file instead of replacing it", async () => {
		await writeFile(path, "keep");
		await expect(start()).rejects.toThrow();
		expect(
			(await lstat(path)).isFile(),
			"existing regular file survives a refused listener",
		).toBe(true);
	});
	it("refuses a directory with broad permissions", async () => {
		await chmod(dir, 0o755);
		await expect(start()).rejects.toThrow("0700");
	});
	it("refuses session-ending wire requests without a discovered owner", async () => {
		await start();
		const request: ControlRequest = {
			v: 1,
			id: "quit",
			op: "close",
			sessionId: a,
		};
		await expect(controlRequest(path, request)).rejects.toThrow("expectedHost");
		const socket = createConnection(path);
		const messages = readMessages(socket);
		socket.write(`${JSON.stringify(request)}\n`);
		expect((await messages.next()).value).toMatchObject({
			ok: false,
			error: { code: "missing_host_identity" },
		});
		socket.destroy();
		expect(backend.execute).not.toHaveBeenCalled();
	});
	it("refuses stale ownership before running the engine", async () => {
		await start();
		expect(
			await controlRequest(path, {
				...list,
				expectedHost: { key: host.key, owner: { ...host.owner, startedAt: 2 } },
			}),
		).toMatchObject({ ok: false, error: { code: "stale_host" } });
		expect(backend.execute).not.toHaveBeenCalled();
	});
	it("journals engine errors without returning secrets to the client", async () => {
		backend.execute = vi.fn(async () => {
			throw new Error("API_KEY=secret");
		});
		await start();
		const reply = await controlRequest(path, list);
		expect(reply).toMatchObject({
			ok: false,
			error: { code: "operation_failed" },
		});
		expect(JSON.stringify(reply)).not.toContain("secret");
		expect(report).toHaveBeenCalledOnce();
	});
	it("rejects malformed frames and reports them only in the host", async () => {
		await start();
		const socket = createConnection(path);
		const messages = readMessages(socket);
		socket.write("{secret-not-json}\n");
		await expect(messages.next()).resolves.toMatchObject({ done: true });
		expect(report).toHaveBeenCalledOnce();
		expect(backend.execute).not.toHaveBeenCalled();
	});
});

describe("viewer connection lifecycle", () => {
	it("routes two sockets to V Terminals and repaint survives reconnect without closing either session", async () => {
		const inputs: unknown[] = [];
		const terminals = new Map<string, ViewerTerminal>();
		for (const id of [a, b]) {
			const terminal = new ViewerTerminal(id, () => {
				terminals.get(id)?.write(`screen-${id}`);
			});
			terminal.start(
				(data) => {
					inputs.push([ambientSession(), data]);
				},
				() => {},
			);
			terminals.set(id, terminal);
		}
		await start(
			terminalBridge((id) => {
				const terminal = terminals.get(id);
				if (!terminal) throw new Error("Missing terminal");
				return terminal;
			}),
		);
		async function connect(id: string) {
			const socket = createConnection(path);
			const messages = readMessages(socket);
			socket.write(
				`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId: id, rows: 20, columns: 80 })}\n`,
			);
			expect((await messages.next()).value).toMatchObject({
				ok: true,
				id: "view",
			});
			expect(
				(await messages.next()).value,
				"a joining viewer is first given the modes pi's screen expects",
			).toEqual({ type: "output", data: "\x1b[>7u\x1b[?2004h" });
			expect((await messages.next()).value).toEqual({
				type: "output",
				data: `screen-${id}`,
			});
			return { socket, messages };
		}
		const first = await connect(a);
		const second = await connect(b);
		first.socket.end();
		await first.messages.next();
		const again = await connect(a);
		second.socket.write(`${JSON.stringify({ type: "input", data: "z" })}\n`);
		second.socket.write(
			`${JSON.stringify({ type: "resize", rows: 22, columns: 100 })}\n`,
		);
		expect((await second.messages.next()).value).toEqual({
			type: "output",
			data: `screen-${b}`,
		});
		expect(inputs).toEqual([[b, "z"]]);
		expect(host.list()).toHaveLength(2);
		expect(cleanup).not.toHaveBeenCalled();
		again.socket.end();
		second.socket.end();
		await again.messages.next();
		await second.messages.next();
		for (const terminal of terminals.values()) terminal.dispose();
	});

	it("acknowledges attach before output, scopes input/resize, and EOF detaches only the viewer", async () => {
		const seen: unknown[] = [];
		const detach = vi.fn(() => {
			seen.push(["detach", ambientSession()]);
		});
		await start({
			attach: (request, sink) => {
				seen.push(["attach", ambientSession(), request.sessionId]);
				sink.write("initial screen");
				return {
					input: (data) => {
						seen.push(["input", ambientSession(), data]);
						sink.write("updated");
					},
					resize: (rows, columns) => {
						seen.push(["resize", ambientSession(), rows, columns]);
					},
					detach,
				};
			},
		});
		const socket = createConnection(path);
		const messages = readMessages(socket);
		socket.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId: a, rows: 20, columns: 80 })}\n${JSON.stringify({ type: "input", data: "hello" })}\n${JSON.stringify({ type: "resize", rows: 24, columns: 100 })}\n`,
		);
		expect((await messages.next()).value).toMatchObject({
			id: "view",
			ok: true,
		});
		expect((await messages.next()).value).toEqual({
			type: "output",
			data: "initial screen",
		});
		expect((await messages.next()).value).toEqual({
			type: "output",
			data: "updated",
		});
		socket.end();
		await messages.next();
		expect(seen).toEqual([
			["attach", a, a],
			["input", a, "hello"],
			["resize", a, 24, 100],
			["detach", a],
		]);
		expect(detach).toHaveBeenCalledOnce();
		expect(host.list()).toHaveLength(2);
		expect(cleanup).not.toHaveBeenCalled();
	});
	it("hands a viewer that can its edit and takes the answer, then suspends only it", async () => {
		const seen: unknown[] = [];
		const edited = vi.fn((_id: string, _text?: string) => {
			seen.push(["edited", ambientSession()]);
		});
		const detach = vi.fn();
		let asked: { features?: readonly string[] } = {};
		let suspend: () => void = () => undefined;
		await start({
			attach: (request, sink) => {
				asked = request;
				suspend = sink.suspend;
				sink.edit("e1", "draft");
				return { input: vi.fn(), resize: vi.fn(), edited, detach };
			},
		});
		const socket = createConnection(path);
		const messages = readMessages(socket);
		socket.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId: a, rows: 20, columns: 80, features: ["edit", "suspend"] })}\n`,
		);
		expect((await messages.next()).value).toMatchObject({ ok: true });
		expect(asked.features).toEqual(["edit", "suspend"]);
		expect((await messages.next()).value).toEqual({
			type: "edit",
			id: "e1",
			text: "draft",
		});
		socket.write(
			`${JSON.stringify({ type: "edited", id: "e1", text: "new words" })}\n${JSON.stringify({ type: "edited", id: "e1" })}\n`,
		);
		await vi.waitFor(() => expect(edited).toHaveBeenCalledTimes(2));
		expect(edited.mock.calls).toEqual([
			["e1", "new words"],
			["e1", undefined],
		]);
		expect(seen).toEqual([
			["edited", a],
			["edited", a],
		]);

		suspend();

		expect((await messages.next()).value).toEqual({ type: "suspend" });
		expect((await messages.next()).done, "a suspended viewer is let go").toBe(
			true,
		);
		await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
		expect(host.list()).toHaveLength(2);
		expect(cleanup).not.toHaveBeenCalled();
	});
	it("tells each attached viewer, and only those, that the host is restarting, then lets it go", async () => {
		await start({
			attach: () => ({ input: vi.fn(), resize: vi.fn(), detach: vi.fn() }),
		});
		const viewing = createConnection(path);
		const seen = readMessages(viewing);
		viewing.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId: a, rows: 20, columns: 80 })}\n`,
		);
		expect((await seen.next()).value).toMatchObject({ ok: true });
		const asking = createConnection(path);
		const answers = readMessages(asking);
		asking.write(`${JSON.stringify(list)}\n`);
		expect((await answers.next()).value).toMatchObject({ ok: true });

		const told = listener?.restarting();
		asking.write(`${JSON.stringify({ ...list, id: "again" })}\n`);

		expect((await seen.next()).value).toEqual({ type: "restarting" });
		expect(
			(await seen.next()).done,
			"the viewer's connection ends after the frame",
		).toBe(true);
		await told;
		expect(
			(await answers.next()).value,
			"a connection with no viewer hears only its answers",
		).toMatchObject({ id: "again", ok: true });
		viewing.destroy();
		asking.destroy();
	});
	it("takes no new connection once it says it is restarting, so a viewer joining again waits for the next host", async () => {
		await start({
			attach: () => ({ input: vi.fn(), resize: vi.fn(), detach: vi.fn() }),
		});
		const viewing = createConnection(path);
		const seen = readMessages(viewing);
		viewing.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId: a, rows: 20, columns: 80 })}\n`,
		);
		expect((await seen.next()).value).toMatchObject({ ok: true });

		const told = listener?.restarting();
		expect((await seen.next()).value).toEqual({ type: "restarting" });
		const late = await new Promise<string>((resolve) => {
			const again = createConnection(path);
			again.once("error", (error: NodeJS.ErrnoException) =>
				resolve(error.code ?? String(error)),
			);
			again.once("connect", () => {
				again.destroy();
				resolve("connected");
			});
		});

		expect(
			["ECONNREFUSED", "ENOENT"],
			"a client retries a refused or missing socket, and ends at a reset",
		).toContain(late);
		await told;
		viewing.destroy();
	});
	it("refuses unsupported attach without calling the engine", async () => {
		await start();
		const socket = createConnection(path);
		const messages = readMessages(socket);
		socket.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId: a, rows: 20, columns: 80 })}\n`,
		);
		expect((await messages.next()).value).toMatchObject({
			ok: false,
			error: { code: "unsupported" },
		});
		socket.destroy();
		expect(backend.execute).not.toHaveBeenCalled();
	});
	it("sends what a screen draws in one tick as one frame, before what follows it", async () => {
		// A redraw is dozens of small writes; framing each alone holds the
		// host's one loop for every conversation it serves.
		await start({
			attach: (_request, sink) => {
				sink.write("\x1b[?25l");
				sink.write("\x1b[2K");
				sink.write("drawn");
				sink.edit("e1", "draft");
				sink.write("after");
				return { input: vi.fn(), resize: vi.fn(), detach: vi.fn() };
			},
		});
		const socket = createConnection(path);
		const messages = readMessages(socket);
		socket.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId: a, rows: 20, columns: 80 })}\n`,
		);
		expect((await messages.next()).value).toMatchObject({ ok: true });
		expect((await messages.next()).value).toEqual({
			type: "output",
			data: "\x1b[?25l\x1b[2Kdrawn",
		});
		expect((await messages.next()).value).toEqual({
			type: "edit",
			id: "e1",
			text: "draft",
		});
		expect((await messages.next()).value).toEqual({
			type: "output",
			data: "after",
		});
		socket.destroy();
	});
	it("bounds output even when a viewer does not read", async () => {
		const detach = vi.fn();
		await start({
			attach: (_request, sink) => {
				sink.write("x".repeat(4 * 1024 * 1024));
				return { input: vi.fn(), resize: vi.fn(), detach };
			},
		});
		const socket = createConnection(path);
		const messages = readMessages(socket);
		socket.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId: a, rows: 20, columns: 80 })}\n`,
		);
		await messages.next();
		await messages.next();
		expect(detach).toHaveBeenCalledOnce();
		expect(host.list()).toHaveLength(2);
	});
});

describe("one-shot client", () => {
	it("does not retry a mutation when the engine disconnects", async () => {
		const execute = vi.fn((socket) => {
			socket.once("data", () => socket.destroy());
		});
		const fake = createServer(execute);
		await new Promise<void>((resolve) => fake.listen(path, resolve));
		try {
			await expect(controlRequest(path, list)).rejects.toThrow(
				"outcome unknown",
			);
			expect(execute).toHaveBeenCalledOnce();
		} finally {
			await new Promise<void>((resolve) => fake.close(() => resolve()));
		}
	});
	it("rejects wrong correlation and malformed replies", async () => {
		for (const response of [
			{ v: 1, id: "wrong", ok: true, result: [] },
			{ v: 2, id: "list", ok: true, result: [] },
		]) {
			const fake = createServer((socket) => {
				socket.once("data", () => socket.end(`${JSON.stringify(response)}\n`));
			});
			await new Promise<void>((resolve) => fake.listen(path, resolve));
			try {
				await expect(controlRequest(path, list)).rejects.toThrow();
			} finally {
				await new Promise<void>((resolve) => fake.close(() => resolve()));
			}
		}
	});
	it("bounds requests even with trickle input and refuses attach before connecting", async () => {
		const fake = createServer((socket) => {
			socket.on("data", () => {});
			const trickle = setInterval(() => socket.write(" "), 5);
			socket.on("close", () => clearInterval(trickle));
			// The absolute deadline intentionally disconnects during the trickle.
			socket.on("error", () => clearInterval(trickle));
		});
		await new Promise<void>((resolve) => fake.listen(path, resolve));
		try {
			await expect(controlRequest(path, list, 20)).rejects.toThrow("timed out");
		} finally {
			await new Promise<void>((resolve) => fake.close(() => resolve()));
		}
		await expect(
			controlRequest(path, {
				v: 1,
				id: "view",
				op: "attach",
				sessionId: a,
				rows: 20,
				columns: 80,
			}),
		).rejects.toThrow("streaming");
	});
});
