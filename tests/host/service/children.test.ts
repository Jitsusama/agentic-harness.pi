/** A host passing each request for a conversation a child runs to the child's own socket. */
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	heldChildren,
	listingChildren,
} from "../../../host/service/children.ts";
import { controlRequest } from "../../../host/service/client.ts";
import type {
	ControlBackend,
	HostIdentity,
} from "../../../host/service/dispatch.ts";
import { jsonLines } from "../../../host/service/framing.ts";
import type {
	ControlRequest,
	SessionIdentity,
} from "../../../host/service/protocol.ts";
import {
	listenControl,
	type ViewerSink,
} from "../../../host/service/server.ts";

const a = "a0000000-0000-4000-8000-000000000001";
const b = "b0000000-0000-4000-8000-000000000002";

async function* readMessages(socket: Socket) {
	const frames = jsonLines();
	for await (const chunk of socket) {
		for (const value of frames.push(
			typeof chunk === "string" ? Buffer.from(chunk) : chunk,
		))
			yield value;
	}
}

function line(value: unknown) {
	return `${JSON.stringify(value)}\n`;
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
let asked: ControlRequest[];
let childAsked: ControlRequest[];
let viewed: unknown[];
let sink: ViewerSink | undefined;
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

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "children-"));
	hostPath = join(dir, "host.sock");
	// Short, since a socket's path has a limit a test's folder can pass.
	childPath = join(dir, "host.d", "a.sock");
	listeners = [];
	asked = [];
	childAsked = [];
	viewed = [];
	sink = undefined;
	routes = heldChildren();
	const childBackend: ControlBackend = {
		identity: child,
		execute: vi.fn(async (request) => {
			childAsked.push(request);
			if (request.op === "list")
				return { sessions: [conversation(a)], host: child };
			return "sessionId" in request ? { sessionId: request.sessionId } : null;
		}),
	};
	listeners.push(
		await listenControl({
			path: childPath,
			backend: childBackend,
			report: () => undefined,
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
			if (request.op === "list") return { sessions: [conversation(b)], host };
			return "sessionId" in request ? { sessionId: request.sessionId } : null;
		}),
	};
	listeners.push(
		await listenControl({
			path: hostPath,
			backend: listingChildren(hostBackend, routes),
			children: routes,
			report: () => undefined,
		}),
	);
});
afterEach(async () => {
	for (const listener of listeners.reverse()) await listener.close();
	await rm(dir, { recursive: true, force: true });
});

describe("a host with conversations in children", () => {
	it("passes a window's attach to the child, and its keys and frames both ways", async () => {
		const window = createConnection(hostPath);
		const seen = readMessages(window);
		const attach = line({
			v: 1,
			id: "view",
			op: "attach",
			sessionId: a,
			rows: 20,
			columns: 80,
		});
		const input = line({ type: "input", data: "hello" });
		// The attach, a whole frame after it and half of one more, in one write.
		window.write(attach + input + input.slice(0, 9));

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
				sessions: [conversation(a), { ...conversation(b), state: "busy" }],
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
	it("tells a window attached through it that it restarts once the child's frame ends, and leaves the child", async () => {
		const window = createConnection(hostPath);
		const seen = readMessages(window);
		window.write(
			line({
				v: 1,
				id: "view",
				op: "attach",
				sessionId: a,
				rows: 20,
				columns: 80,
			}),
		);
		expect((await seen.next()).value).toMatchObject({ ok: true });

		const told = listeners[1]?.restarting();
		expect((await seen.next()).value).toEqual({ type: "restarting" });
		expect((await seen.next()).done).toBe(true);
		await told;
		await vi.waitFor(() => expect(viewed).toContain("detached"));
		const still = await controlRequest(childPath, {
			v: 1,
			id: "list",
			op: "list",
		});
		expect(still, "the child runs on").toMatchObject({ ok: true });
	});
});
