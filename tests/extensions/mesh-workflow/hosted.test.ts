/** Two mesh runtimes in one host exchange messages and close independently. */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type MeshPaths,
	meshWorkflow,
} from "../../../extensions/mesh-workflow/index.ts";
import {
	parkHeavyCalls,
	takeHeavyCalls,
} from "../../../extensions/mesh-workflow/leases.ts";
import { registerTools } from "../../../extensions/mesh-workflow/tools.ts";
import { hostSocketPath } from "../../../host/service/address.ts";
import { listenControl } from "../../../host/service/server.ts";
import {
	type Host,
	hostRegistryPath,
	installHost,
	releaseSession,
	type SessionEnvironment,
	sessionEnv,
	withSession,
} from "../../../lib/core/session/index.ts";
import { stateDir } from "../../../lib/internal/paths.ts";
import { tickedOwnerNow } from "../../../lib/internal/process-ticks.ts";
import {
	isParked,
	PARKING,
	writeParked,
} from "../../../lib/internal/session/park.ts";
import { handIn } from "../../../lib/mesh/hand.ts";
import { createBoard } from "../../../lib/mesh/lease.ts";
import { census } from "../../../lib/mesh/liveness.ts";
import { localPeer } from "../../../lib/mesh/peer.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

vi.mock("../../../lib/mesh/present.ts", () => ({
	keepPresent() {},
	whenPresent: () => () => {},
}));

let root: string;
let paths: MeshPaths;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hosted-mesh-"));
	paths = {
		mesh: join(root, "mesh"),
		sessions: join(root, "sessions"),
		quests: join(root, "quests"),
	};
});
const stops: (() => Promise<unknown>)[] = [];
let uninstall: (() => void) | undefined;
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	vi.unstubAllEnvs();
	for (const id of ["alpha-AAAAAAAA", "bravo-BBBBBBBB"]) releaseSession(id);
	uninstall?.();
	rmSync(root, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
};

async function peer(id: string) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const messages: { content: string }[] = [];
	const bus = new Map<string, ((data: unknown) => void)[]>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerEntryRenderer() {},
		appendEntry() {},
		sendMessage: (message: { content: string }) => messages.push(message),
		events: {
			on: (name: string, handler: (data: unknown) => void) =>
				bus.set(name, [...(bus.get(name) ?? []), handler]),
			emit: (name: string, data: unknown) => {
				for (const handler of bus.get(name) ?? []) handler(data);
			},
		},
	};
	const cwd = join(root, id);
	mkdirSync(cwd, { recursive: true });
	const ctx = {
		cwd,
		hasUI: false,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => join(root, `${id}.jsonl`),
			getBranch: () => [],
			getSessionName: () => undefined,
			getCwd: () => cwd,
		},
	};
	const fire = (name: string, event: unknown = {}) =>
		withSession(id, () => handlers.get(name)?.(event, ctx));
	withSession(id, () =>
		meshWorkflow(
			paths,
			{},
			{ settleMs: 1, spreadMs: 0 },
		)(pi as unknown as ExtensionAPI),
	);
	await fire("session_start");
	stops.push(async () => fire("session_shutdown", { reason: "quit" }));
	return {
		messages,
		ctx,
		emit: (name: string, data: unknown) =>
			withSession(id, () => pi.events.emit(name, data)),
		close: (reason = "quit") => fire("session_shutdown", { reason }),
		call: (name: string, params: unknown) =>
			withSession(id, async () => {
				const result = await tools
					.get(name)
					?.execute(
						"call",
						params,
						undefined,
						undefined,
						ctx as unknown as ExtensionContext,
					);
				return result?.content.map((part) => part.text).join("\n") ?? "";
			}),
	};
}

async function inHost() {
	const owner = await tickedOwnerNow();
	if (!owner) throw new Error("test process has no owner");
	const open = new Set(["alpha-AAAAAAAA", "bravo-BBBBBBBB"]);
	const environments = new Map<string, Record<string, string>>();
	const env = (id: string): SessionEnvironment => {
		const values = environments.get(id) ?? {};
		environments.set(id, values);
		return {
			get: (key) => values[key],
			set: (key, value) => {
				values[key] = value;
			},
			delete: (key) => {
				delete values[key];
			},
			snapshot: () => ({ ...values }),
		};
	};
	const host: Host = {
		kind: "pi-durable",
		key: "test-host",
		owner,
		holds: (id) => (open.has(id) ? "idle" : undefined),
		env,
		hints: () => ({}),
		close: async (id) => {
			open.delete(id);
		},
		stamp() {},
	};
	uninstall = installHost(host);
	return { open, host };
}

it("trades a question and answer, then forgets only the closed conversation", async () => {
	const { open } = await inHost();
	const a = await peer("alpha-AAAAAAAA");
	const b = await peer("bravo-BBBBBBBB");
	const presences = createPresences(join(paths.mesh, "presence"));
	expect((await census(presences.all())).present).toHaveLength(2);
	expect(presences.of("alpha-AAAAAAAA")?.cwd).toBe(a.ctx.cwd);
	expect(presences.of("bravo-BBBBBBBB")?.hosted).toMatchObject({
		host: "test-host",
		conversation: "bravo-BBBBBBBB",
	});
	expect(
		withSession("alpha-AAAAAAAA", () => sessionEnv().get("PI_MESH_SESSION")),
	).toBe("alpha-AAAAAAAA");
	expect(
		withSession("bravo-BBBBBBBB", () => sessionEnv().get("PI_MESH_SESSION")),
	).toBe("bravo-BBBBBBBB");
	expect(await a.call("mesh_groups", {})).toContain("BBBBBBBB");
	expect(await b.call("mesh_groups", {})).toContain("AAAAAAAA");
	expect(
		await a.call("mesh_send", {
			to: "BBBBBBBB",
			intent: "question",
			text: "Are you ready?",
		}),
	).toContain("Sent");
	await vi.waitFor(() =>
		expect(
			b.messages.some((one) => one.content.includes("Are you ready?")),
			"B hears A's question",
		).toBe(true),
	);
	const transport = folderTransport(join(paths.mesh, "messages"));
	const question = transport
		.ids()
		.map((id) => transport.read(id))
		.find((one) => one?.text === "Are you ready?");
	expect(
		question?.hosted,
		"a question sent from a hosted conversation carries the hosted stamp",
	).toBe(true);
	expect(
		await b.call("mesh_send", {
			to: "AAAAAAAA",
			intent: "fyi",
			text: "Ready now.",
			re: question?.id,
		}),
	).toContain("Sent");
	await vi.waitFor(() =>
		expect(
			a.messages.some((one) => one.content.includes("Ready now.")),
			"A hears B's answer",
		).toBe(true),
	);
	const before = presences.all();
	await b.close();
	open.delete("bravo-BBBBBBBB");
	expect(presences.of("bravo-BBBBBBBB")).toBeUndefined();
	expect((await census(before)).gone.map((one) => one.session)).toEqual([
		"bravo-BBBBBBBB",
	]);
	expect(
		(await census(presences.all())).present.map((one) => one.session),
	).toEqual(["alpha-AAAAAAAA"]);
	expect(
		await a.call("mesh_send", {
			to: "BBBBBBBB",
			intent: "question",
			text: "Still there?",
		}),
	).toContain("no session");
});

it("keeps a parked conversation's presence, so cadence counts it alive and a question to it wakes it", async () => {
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	await inHost();
	const a = await peer("alpha-AAAAAAAA");
	const b = await peer("bravo-BBBBBBBB");
	const wake = join(root, "bravo.wake");
	// As the host parks it: the marker, then the bus's word, then its end.
	writeParked({
		session: "bravo-BBBBBBBB",
		sessionFile: join(root, "bravo-BBBBBBBB.jsonl"),
		cwd: b.ctx.cwd,
		addresses: ["BBBBBBBB"],
		parkedAt: new Date().toISOString(),
		pid: process.pid,
		wake,
	});
	b.emit(PARKING, { session: "bravo-BBBBBBBB", addresses: [], wake });
	await b.close();

	const presences = createPresences(join(paths.mesh, "presence"));
	const kept = presences.of("bravo-BBBBBBBB");
	// cadence starts a second pi on a watched session only when none of
	// these says it's there: its state, the host's pid holding it as this
	// conversation, or its marker.
	expect(kept?.state, "its presence stays, saying it parked").toBe("parked");
	expect(kept?.owner?.pid, "the host still owns it").toBe(process.pid);
	// Matched, not equal: the presence also names the words a window
	// views it by (hosted.view), which cadence doesn't read.
	expect(
		kept?.hosted,
		"the host still holds it as this conversation",
	).toMatchObject({
		host: "test-host",
		conversation: "bravo-BBBBBBBB",
	});
	expect(
		isParked("bravo-BBBBBBBB"),
		"its marker stays, which cadence reads too",
	).toBe(true);
	expect(
		await a.call("mesh_send", {
			to: "BBBBBBBB",
			intent: "question",
			text: "Awake?",
		}),
	).toContain("Sent");
	await vi.waitFor(() =>
		expect(existsSync(wake), "the question asks its host to wake it").toBe(
			true,
		),
	);
	expect(JSON.parse(readFileSync(wake, "utf8")).session).toBe("bravo-BBBBBBBB");
});

it("keeps reload presence and heavy-call carry separate for two conversations", async () => {
	await inHost();
	const a = await peer("alpha-AAAAAAAA");
	const b = await peer("bravo-BBBBBBBB");
	await a.close("reload");
	const presences = createPresences(join(paths.mesh, "presence"));
	expect(presences.of("alpha-AAAAAAAA")).toBeDefined();
	expect(presences.of("bravo-BBBBBBBB")).toBeDefined();
	withSession("alpha-AAAAAAAA", () => parkHeavyCalls([["call-a", "build"]]));
	withSession("bravo-BBBBBBBB", () => parkHeavyCalls([["call-b", "test"]]));
	expect(withSession("alpha-AAAAAAAA", takeHeavyCalls)).toEqual([
		["call-a", "build"],
	]);
	expect(withSession("alpha-AAAAAAAA", takeHeavyCalls)).toEqual([]);
	expect(withSession("bravo-BBBBBBBB", takeHeavyCalls)).toEqual([
		["call-b", "test"],
	]);
	await b.close();
});

it("reads each hosted hand's environment and uses its conversation as fallback identity", async () => {
	await inHost();
	for (const id of ["alpha-AAAAAAAA", "bravo-BBBBBBBB"]) {
		withSession(id, () => {
			sessionEnv().set("SUBAGENT_SUPERVISOR", "1");
			sessionEnv().set("PI_MESH_SESSION", "parent");
			expect(handIn()?.session).toBe(`parent.hand.${id}`);
		});
	}
});

it("ends only the addressed conversation and refuses a foreign host without signalling it", async () => {
	const { open, host } = await inHost();
	const a = await peer("alpha-AAAAAAAA");
	await peer("bravo-BBBBBBBB");
	const presences = createPresences(join(paths.mesh, "presence"));
	const bravo = presences.of("bravo-BBBBBBBB");
	if (!bravo) throw new Error("bravo did not publish");
	presences.publish({ ...bravo, owner: host.owner, orchestratedBy: "ORCHST" });
	const self = localPeer({
		session: "alpha-AAAAAAAA",
		cwd: a.ctx.cwd,
		records: paths,
		presences,
	});
	const tools = new Map<string, Tool>();
	registerTools(
		{
			registerTool: (tool: Tool) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI,
		() => ({
			peer: { ...self, orchestrates: "ORCHST" },
			presences,
			transport: folderTransport(join(paths.mesh, "messages")),
			board: createBoard(join(paths.mesh, "leases")),
			sent() {},
		}),
	);
	const end = async () =>
		(await tools.get("mesh_end")?.execute("end", { peer: "BBBBBBBB" }))
			?.content[0]?.text;
	presences.publish({
		...bravo,
		orchestratedBy: "ORCHST",
		hosted: { host: "foreign", conversation: bravo.session },
		owner: host.owner,
	});
	expect(await end()).toContain("host control socket");
	expect(open.size).toBe(2);
	presences.publish({ ...bravo, orchestratedBy: "ORCHST", owner: host.owner });
	expect(await end()).toContain("close only that conversation");
	expect([...open]).toEqual(["alpha-AAAAAAAA"]);
	self.dispose();
});

it("ends a conversation another host holds through that host's socket, never a signal", async () => {
	const { host } = await inHost();
	const a = await peer("alpha-AAAAAAAA");
	const presences = createPresences(join(paths.mesh, "presence"));
	const runtime = join(root, "run");
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	const far = "c0000000-0000-4000-8000-000000000003";
	const near = "d0000000-0000-4000-8000-000000000004";
	const open = new Set([far, near]);
	const identity = { key: "work-attended", owner: host.owner };
	const publishList = () => {
		const path = hostRegistryPath(host.owner, stateDir("hosts"));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				...identity,
				sessions: [...open].map((id) => ({
					id,
					state: "idle",
					since: new Date().toISOString(),
				})),
			}),
		);
	};
	publishList();
	const kill = vi.spyOn(process, "kill");
	const listener = await listenControl({
		path: hostSocketPath("work", "attended", runtime),
		backend: {
			identity,
			execute: async (request) => {
				if (request.op !== "close") throw new Error(request.op);
				open.delete(request.sessionId);
				publishList();
				return { sessionId: request.sessionId };
			},
		},
		report() {},
	});
	let listening = true;
	const stopListening = async () => {
		if (listening) await listener.close();
		listening = false;
	};
	stops.push(stopListening);
	const self = localPeer({
		session: "alpha-AAAAAAAA",
		cwd: a.ctx.cwd,
		records: paths,
		presences,
	});
	const tools = new Map<string, Tool>();
	registerTools(
		{
			registerTool: (tool: Tool) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI,
		() => ({
			peer: { ...self, orchestrates: "ORCHST" },
			presences,
			transport: folderTransport(join(paths.mesh, "messages")),
			board: createBoard(join(paths.mesh, "leases")),
			sent() {},
		}),
	);
	const alpha = presences.of("alpha-AAAAAAAA");
	if (!alpha) throw new Error("alpha did not publish");
	for (const [session, address] of [
		[far, "far-FFFFFFFF"],
		[near, "near-EEEEEEEE"],
	] as const)
		presences.publish({
			...alpha,
			session: address,
			addresses: [address.slice(-8)],
			orchestratedBy: "ORCHST",
			owner: host.owner,
			hosted: { host: "work-attended", conversation: session },
		});
	const end = async (peer: string) =>
		(await tools.get("mesh_end")?.execute("end", { peer }))?.content[0]?.text;
	expect(await end("FFFFFFFF")).toContain("close only that conversation");
	expect([...open]).toEqual([near]);
	expect(await end("FFFFFFFF")).toContain("already ended");
	await stopListening();
	expect(await end("EEEEEEEE")).toContain("did not confirm");
	expect([...open]).toEqual([near]);
	expect(kill).not.toHaveBeenCalled();
	kill.mockRestore();
	vi.unstubAllEnvs();
	self.dispose();
});
