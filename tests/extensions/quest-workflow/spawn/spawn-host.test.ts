import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRecord } from "../../../../extensions/quest-workflow/sessions/records.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import {
	type ControlCall,
	hostBySetting,
	spawnInHost,
} from "../../../../extensions/quest-workflow/verbs/spawn-host.ts";
import { hostSocketPath } from "../../../../host/service/address.ts";
import { hostRefusal } from "../../../../host/service/dispatch.ts";
import type { ControlRequest } from "../../../../host/service/protocol.ts";
import { listenControl } from "../../../../host/service/server.ts";
import {
	OPEN_UNSETTLED,
	unsettledMessage,
} from "../../../../host/service/unsettled-open.ts";
import { withSession } from "../../../../lib/core/session/index.ts";
import { recordUnlisted } from "../../../../lib/internal/fence/fence-log.ts";
import {
	joinSpawns,
	leaveSpawns,
	listedForStage,
	STAGE_VARIABLE,
} from "../../../../lib/internal/fence/fence-stage.ts";
import { packageConfigPath } from "../../../../lib/internal/paths.ts";
import { openRecord } from "../../../../lib/internal/quest/sessions/session-registry.ts";
import { HostClientUnloaded } from "../../../../lib/mesh/host-control.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { installTestHost } from "../../../support/session-host.ts";
import { createEnvGuard } from "../_helpers.ts";

// A miss is counted from the system's log, which a test must never write.
vi.mock("../../../../lib/internal/fence/fence-log.ts", async (original) => ({
	...(await original<
		typeof import("../../../../lib/internal/fence/fence-log.ts")
	>()),
	recordUnlisted: vi.fn(async () => undefined),
}));

// A declared fence's claim holds only where this package keeps its mark.
const KEPT_HERE = process.platform === "linux";

const SAVED = [
	"HOME",
	"MYCELIUM_REALM",
	"PI_HOME_REALM",
	"XDG_CONFIG_HOME",
	"XDG_RUNTIME_DIR",
	"XDG_STATE_HOME",
];

let tmpRoot: string;
let runtime: string;
let saved: Record<string, string | undefined>;
let received: ControlRequest[];
let answer: (request: ControlRequest) => Promise<unknown>;
let listener: Awaited<ReturnType<typeof listenControl>> | undefined;

function fakeCtx(sessionId: string, extra: Record<string, unknown> = {}) {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => sessionId, isPersisted: () => true },
		...extra,
	} as unknown as Parameters<typeof handle>[2];
}

function identityFor(request: ControlRequest) {
	const cwd = request.op === "open" ? request.cwd : tmpRoot;
	const sessionId = randomUUID();
	return {
		sessionId,
		file: join(tmpRoot, "logs", `${sessionId}.jsonl`),
		cwd,
		state: "busy",
		since: new Date().toISOString(),
	};
}

/** A real private control socket for the realm's host, over a fake engine. */
async function serveHost(realm: string, kind: "attended" | "background") {
	listener = await listenControl({
		path: hostSocketPath(realm, kind, runtime),
		backend: {
			identity: {
				key: `${realm}-${kind}`,
				owner: { pid: process.pid, startedAt: 1 },
			},
			async execute(request) {
				received.push(request);
				return answer(request);
			},
		},
		report: () => {},
	});
}

/** Set quest-workflow's spawnHost in the package config the spawn reads. */
function setSpawnHost(value: unknown) {
	const path = packageConfigPath();
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({ sections: { "quest-workflow": { spawnHost: value } } }),
	);
}

/** What a result says, whichever way it went. */
function said(result: Awaited<ReturnType<typeof handle>>): string {
	return result.ok ? result.message : result.guidance;
}

async function questNamed(title: string, spawner = "spawner") {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const created = await handle(state, fakePi(), fakeCtx(spawner), {
		action: "create",
		title,
	});
	if (!created.ok) throw new Error(created.guidance);
	return { state, id: state.questId as string };
}

function writeLog(id: string, ageMs: number): string {
	const dir = join(tmpRoot, ".pi", "agent", "sessions", "store-sub");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `2026-11-09T10-00-00-000Z_${id}.jsonl`);
	writeFileSync(
		path,
		JSON.stringify({ timestamp: new Date(Date.now() - ageMs).toISOString() }),
	);
	return path;
}

async function questWithSession(id: string, ageMs: number) {
	const quest = await questNamed("Alpha");
	await handle(quest.state, fakePi(), fakeCtx("spawner"), {
		action: "session-attach",
		sessionId: id,
	});
	return { ...quest, log: writeLog(id, ageMs) };
}

const envGuard = createEnvGuard();
beforeEach(() => {
	// A project doesn't take the root's clearMocks, so each test starts uncounted.
	vi.mocked(recordUnlisted).mockClear();
	envGuard.enter();
	saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));
	tmpRoot = mkdtempSync(join(tmpdir(), "spawn-host-"));
	runtime = mkdtempSync(join(tmpdir(), "k3-"));
	process.env.HOME = tmpRoot;
	process.env.MYCELIUM_REALM = "home";
	delete process.env.PI_HOME_REALM;
	delete process.env.XDG_CONFIG_HOME;
	// An unanswered spawn is kept under the state folder, here the test's.
	delete process.env.XDG_STATE_HOME;
	process.env.XDG_RUNTIME_DIR = runtime;
	received = [];
	answer = async (request) => identityFor(request);
});
afterEach(async () => {
	leaveSpawns();
	await listener?.close();
	listener = undefined;
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(runtime, { recursive: true, force: true });
	envGuard.leave();
});

describe("spawn into a host", () => {
	it("opens each quest's fresh session with its own quest and first words", async () => {
		await serveHost("home", "background");
		const alpha = await questNamed("Alpha", "one");
		const beta = await questNamed("Beta", "two");

		const first = await handle(alpha.state, fakePi(), fakeCtx("one"), {
			action: "spawn",
			id: alpha.id,
			host: "background",
			note: "Write the alpha tests.",
		});
		const second = await handle(beta.state, fakePi(), fakeCtx("two"), {
			action: "spawn",
			id: beta.id,
			host: "background",
		});

		expect(first).toMatchObject({ ok: true, details: { how: "host" } });
		expect(second).toMatchObject({ ok: true, details: { how: "host" } });
		if (!first.ok || !second.ok) throw new Error("expected both to open");
		expect(first.details?.sessionId).not.toBe(second.details?.sessionId);
		expect(received.map((r) => r.op)).toEqual(["open", "open"]);
		const [a, b] = received;
		if (a?.op !== "open" || b?.op !== "open") throw new Error("expected opens");
		expect(a).toMatchObject({ quest: alpha.id, attended: false, cwd: tmpRoot });
		expect(a.first).toContain(alpha.id);
		expect(a.first).toContain("Write the alpha tests.");
		expect(b).toMatchObject({ quest: beta.id });
		expect(b.first).toContain(beta.id);
		expect(b.first).not.toContain("Write the alpha tests.");
		expect(first.message).toContain("home-background host opened session");
	});

	// A spawn note is the spawner's order to the new session, read as a
	// pivot is (lib/orchestration/unasked-limits.ts).
	it("opens nothing for a note narrowing a verdict the person didn't limit", async () => {
		await serveHost("home", "background");
		const { state, id } = await questNamed("Alpha");

		const refused = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
			note: "Review Jon's PR in Joel's name. Post no approval or block: a comment review.",
		});

		expect(refused).toMatchObject({ ok: false });
		expect(said(refused)).toContain(
			'this limits a verdict the person didn\'t ask to limit ("Post no approval or block: a comment review.")',
		);
		expect(received).toEqual([]);
	});

	it("hands a fresh session the first stage's token, listed, so it starts fenced", async () => {
		// The host's conversation has no id until it starts, so the token in
		// its environment is all its listing can go by.
		joinSpawns("stage 1");
		await serveHost("home", "background");
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(result).toMatchObject({ ok: true });
		const [open] = received;
		if (open?.op !== "open") throw new Error("expected an open");
		const token = open.env?.PI_FENCE_STAGE;
		expect(token, "the open carried no stage token").toMatch(/^[0-9a-f-]{36}$/);
		expect(listedForStage(token), "its token wasn't listed").toBe(true);
		expect(
			result.ok && result.details?.fence,
			"it claims the fence its token runs",
		).toEqual({ kind: "fence", from: "default" });
	});

	it("hands a fresh session no token until spawns join the stage", async () => {
		await serveHost("home", "background");
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(result, said(result)).toMatchObject({ ok: true });
		const [open] = received;
		if (open?.op !== "open") throw new Error("expected an open");
		expect(
			open.env?.PI_FENCE_STAGE,
			"a spawn was staged before spawns joined",
		).toBeUndefined();
		expect(
			recordUnlisted,
			"an unstaged spawn read as a miss",
		).not.toHaveBeenCalled();
	});

	it("opens it unstaged, saying so, in a host too old for the token", async () => {
		joinSpawns("stage 1");
		await serveHost("home", "background");
		answer = async (request) => {
			if (request.op === "open" && request.env?.PI_FENCE_STAGE)
				throw hostRefusal("invalid_request", "Invalid host control request");
			return identityFor(request);
		};
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(result, said(result)).toMatchObject({ ok: true });
		expect(
			received.map((r) => r.op),
			"asked once more",
		).toEqual(["open", "open"]);
		const again = received.at(1);
		if (again?.op !== "open") throw new Error("expected an open");
		expect(
			again.env,
			"the second open still carried the token",
		).toBeUndefined();
		expect(said(result)).toContain("starts outside the stage");
		expect(
			result.ok && result.details?.fence,
			"it claims what runs without the token",
		).toEqual({ kind: "none", from: "default" });
		expect(recordUnlisted, "the miss was not counted").toHaveBeenCalledWith(
			expect.objectContaining({ kind: "host", error: "older-host" }),
		);
	});

	it.runIf(KEPT_HERE)(
		"hands a declared fence to the host with the mark that keeps it, and claims it",
		async () => {
			await serveHost("home", "background");
			const { state, id } = await questNamed("Alpha");
			const result = await handle(state, fakePi(), fakeCtx("spawner"), {
				action: "spawn",
				id,
				host: "background",
				fence: "fence",
			});
			expect(result, said(result)).toMatchObject({ ok: true });
			const [open] = received;
			if (open?.op !== "open") throw new Error("expected an open");
			expect(open.env, "the open lacks the fence or its mark").toEqual({
				PI_SANDBOX: "fence",
				PI_FENCE_DECLARED: "1",
			});
			expect(
				result.ok && result.details?.fence,
				"it claims the fence it declared",
			).toEqual({ kind: "fence", from: "spawn" });
		},
	);

	it("opens a declared fence without its mark in a host too old for it, claiming none", async () => {
		await serveHost("home", "background");
		answer = async (request) => {
			if (request.op === "open" && request.env?.PI_FENCE_DECLARED)
				throw hostRefusal("invalid_request", "Invalid host control request");
			return identityFor(request);
		};
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
			fence: "fence",
		});
		expect(result, said(result)).toMatchObject({ ok: true });
		const again = received.at(1);
		if (again?.op !== "open") throw new Error("expected a second open");
		expect(again.env, "the second open still carried the mark").toEqual({
			PI_SANDBOX: "fence",
		});
		expect(
			result.ok && result.details?.fence,
			"it claims the fence its pi lifts",
		).toEqual({ kind: "none", from: "default" });
		expect(said(result), "it says the fence is lifted").toContain(
			"lifts the fence it declared",
		);
		expect(said(result), "a mark alone never loses the stage").not.toContain(
			"starts outside the stage",
		);
		expect(
			recordUnlisted,
			"a dropped mark was counted as the stage's miss",
		).not.toHaveBeenCalled();
	});

	it("keeps the token for a host that knows it but not the mark, counting no miss", async () => {
		joinSpawns("stage 1");
		await serveHost("home", "background");
		answer = async (request) => {
			if (request.op === "open" && request.env?.PI_FENCE_DECLARED)
				throw hostRefusal("invalid_request", "Invalid host control request");
			return identityFor(request);
		};
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
			fence: "fence",
		});
		expect(result, said(result)).toMatchObject({ ok: true });
		expect(
			received.map((r) => r.op),
			"asked once more, without the mark alone",
		).toEqual(["open", "open"]);
		const again = received.at(1);
		if (again?.op !== "open") throw new Error("expected a second open");
		expect(
			again.env?.PI_FENCE_STAGE,
			"the token is kept past the mark",
		).toEqual(expect.any(String));
		expect(again.env?.PI_FENCE_DECLARED, "the mark is dropped").toBe(undefined);
		expect(result, "it says it went without the mark alone").toMatchObject({
			details: { unstaged: false, unmarked: true },
		});
		expect(
			recordUnlisted,
			"a session that kept its token is no miss",
		).not.toHaveBeenCalled();
	});

	it("drops the token after the mark for a host that knows neither, counting one miss", async () => {
		joinSpawns("stage 1");
		await serveHost("home", "background");
		answer = async (request) => {
			if (
				request.op === "open" &&
				(request.env?.PI_FENCE_DECLARED || request.env?.PI_FENCE_STAGE)
			)
				throw hostRefusal("invalid_request", "Invalid host control request");
			return identityFor(request);
		};
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
			fence: "fence",
		});
		expect(result, said(result)).toMatchObject({ ok: true });
		expect(
			received.map((r) => r.op),
			"without the mark, then without the token",
		).toEqual(["open", "open", "open"]);
		const last = received.at(2);
		if (last?.op !== "open") throw new Error("expected a third open");
		expect(last.env, "only the sandbox is left").toEqual({
			PI_SANDBOX: "fence",
		});
		expect(
			new Set(received.map((r) => r.id)).size,
			"each try is a request of its own",
		).toBe(3);
		expect(
			said(result).match(/Its host runs code from before/g),
			"the older host is said once",
		).toHaveLength(1);
		expect(
			recordUnlisted,
			"the dropped token is one miss",
		).toHaveBeenCalledTimes(1);
	});

	it("counts no older host when the open without the token is refused too", async () => {
		joinSpawns("stage 1");
		await serveHost("home", "background");
		answer = async (request) => {
			if (request.op === "open")
				throw hostRefusal("invalid_request", "Invalid host control request");
			return identityFor(request);
		};
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(result, said(result)).toMatchObject({ ok: false });
		expect(said(result)).not.toContain("starts outside the stage");
		expect(
			recordUnlisted,
			"a refusal for another reason was counted as an older host",
		).not.toHaveBeenCalled();
	});

	it("carries the asking session's model to an attended host", async () => {
		await serveHost("home", "attended");
		const { state, id } = await questNamed("Alpha");
		const result = await handle(
			state,
			fakePi(),
			fakeCtx("spawner", {
				model: { provider: "anthropic", id: "claude-opus-5-5" },
				thinkingLevel: "high",
			}),
			{ action: "spawn", id, host: "attended" },
		);
		expect(result).toMatchObject({ ok: true, details: { attended: true } });
		if (!result.ok) throw new Error("expected it to open");
		const attach = [
			"mycelium",
			"--realm",
			"home",
			"attach",
			"--host",
			"home-attended",
			"--session",
			result.details?.sessionId,
		];
		expect(result.details?.attach, "how to view it").toEqual(attach);
		expect(result.message).toContain(attach.join(" "));
		expect(received[0]).toMatchObject({
			op: "open",
			attended: true,
			model: { provider: "anthropic", id: "claude-opus-5-5" },
			thinkingLevel: "high",
		});
	});

	it("reads the realm and socket from the asking conversation, not the host process", async () => {
		await serveHost("alpha", "background");
		process.env.MYCELIUM_REALM = "beta";
		const alpha = await questNamed("Alpha", "a");
		const beta = await questNamed("Beta", "b");
		const host = installTestHost();
		try {
			host.host.env("a").set("MYCELIUM_REALM", "alpha");
			host.host.env("a").set("XDG_RUNTIME_DIR", runtime);
			host.host.env("b").set("MYCELIUM_REALM", "beta");
			host.host.env("b").set("XDG_RUNTIME_DIR", runtime);
			// The host runs each conversation's tool calls inside its session.
			const fromA = await withSession("a", () =>
				handle(alpha.state, fakePi(), fakeCtx("a"), {
					action: "spawn",
					id: alpha.id,
					host: "background",
				}),
			);
			const fromB = await withSession("b", () =>
				handle(beta.state, fakePi(), fakeCtx("b"), {
					action: "spawn",
					id: beta.id,
					host: "background",
				}),
			);
			expect(fromA).toMatchObject({
				ok: true,
				details: { host: "alpha-background" },
			});
			expect(fromB).toMatchObject({ ok: false });
			if (fromB.ok) throw new Error("expected b to find no host");
			expect(fromB.guidance).toContain("No beta-background host is listening");
			expect(received).toHaveLength(1);
		} finally {
			host.dispose();
		}
	});

	it("adopts an idle session from its log without first words", async () => {
		await serveHost("home", "background");
		const resumed = randomUUID();
		const { state, id, log } = await questWithSession(resumed, 60 * 60 * 1000);
		answer = async () => ({
			...identityFor(received[0] as ControlRequest),
			sessionId: resumed,
		});
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(result).toMatchObject({
			ok: true,
			details: { how: "host", resumedSessionId: resumed },
		});
		expect(received).toEqual([
			expect.objectContaining({ op: "adopt", sessionFile: log, quest: id }),
		]);
		expect(received[0], "adopt carries no first words").not.toHaveProperty(
			"first",
		);
		expect(
			received[0],
			"a session with no record of a fence moves in as the host runs",
		).not.toHaveProperty("env");
	});

	it("adopts a session that ran fenced as fenced", async () => {
		await serveHost("home", "background");
		const resumed = randomUUID();
		const { state, id } = await questWithSession(resumed, 60 * 60 * 1000);
		saveRecord(
			openRecord({
				sessionId: resumed,
				instanceId: "inst",
				cwd: tmpRoot,
				questId: id,
				env: { PI_SANDBOX: "fence" },
				now: new Date(),
			}),
		);
		answer = async () => ({
			...identityFor(received[0] as ControlRequest),
			sessionId: resumed,
		});
		await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(received, "the adopt says the fence its record kept").toEqual([
			expect.objectContaining({ op: "adopt", env: { PI_SANDBOX: "fence" } }),
		]);
	});

	it("adopts without its mark in a host too old for it, as an open is opened", async () => {
		await serveHost("home", "background");
		const resumed = randomUUID();
		const { state, id } = await questWithSession(resumed, 60 * 60 * 1000);
		saveRecord(
			openRecord({
				sessionId: resumed,
				instanceId: "inst",
				cwd: tmpRoot,
				questId: id,
				env: { PI_SANDBOX: "fence", PI_FENCE_DECLARED: "1" },
				now: new Date(),
			}),
		);
		answer = async (request) => {
			if (request.op === "adopt" && request.env?.PI_FENCE_DECLARED)
				throw hostRefusal("invalid_request", "Invalid host control request");
			return { ...identityFor(request), sessionId: resumed };
		};
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(result, said(result)).toMatchObject({ ok: true });
		expect(received, "adopted again without the mark").toEqual([
			expect.objectContaining({ op: "adopt" }),
			expect.objectContaining({ op: "adopt", env: { PI_SANDBOX: "fence" } }),
		]);
		expect(result, "it says it went without the mark alone").toMatchObject({
			details: { unstaged: false, unmarked: true },
		});
		expect(recordUnlisted, "a dropped mark is no miss").not.toHaveBeenCalled();
	});

	it("adopts without its recorded token in a host that knows neither, counting no miss, since its session was listed by id", async () => {
		await serveHost("home", "background");
		const resumed = randomUUID();
		const { state, id } = await questWithSession(resumed, 60 * 60 * 1000);
		saveRecord(
			openRecord({
				sessionId: resumed,
				instanceId: "inst",
				cwd: tmpRoot,
				questId: id,
				env: {
					PI_SANDBOX: "fence",
					PI_FENCE_DECLARED: "1",
					PI_FENCE_STAGE: "0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
				},
				now: new Date(),
			}),
		);
		answer = async (request) => {
			if (
				request.op === "adopt" &&
				(request.env?.PI_FENCE_DECLARED || request.env?.PI_FENCE_STAGE)
			)
				throw hostRefusal("invalid_request", "Invalid host control request");
			return { ...identityFor(request), sessionId: resumed };
		};
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(result, said(result)).toMatchObject({
			ok: true,
			details: { unstaged: false, unmarked: true },
		});
		expect(received.at(-1), "adopted at last with neither").toMatchObject({
			op: "adopt",
			env: { PI_SANDBOX: "fence" },
		});
		expect(said(result), "it never says it left the stage").not.toContain(
			"starts outside the stage",
		);
		expect(recordUnlisted, "nothing was lost to count").not.toHaveBeenCalled();
	});

	it("refuses to adopt with a note, or a session still live, sending nothing", async () => {
		await serveHost("home", "background");
		const idle = await questWithSession(randomUUID(), 60 * 60 * 1000);
		const noted = await handle(idle.state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id: idle.id,
			host: "background",
			note: "Carry on.",
		});
		expect(noted).toMatchObject({ ok: false });
		if (noted.ok) throw new Error("expected a refusal");
		expect(noted.guidance).toContain("without first words");

		const live = await questWithSession(randomUUID(), 0);
		const busy = await handle(live.state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id: live.id,
			host: "background",
		});
		expect(busy).toMatchObject({ ok: false });
		if (busy.ok) throw new Error("expected a refusal");
		expect(busy.guidance).toContain("second writer");
		expect(received).toEqual([]);
	});

	it("describes a dry run without calling the host", async () => {
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
			dryRun: true,
		});
		expect(result).toMatchObject({
			ok: true,
			details: {
				how: "host",
				socket: hostSocketPath("home", "background", runtime),
				request: { op: "open", quest: id },
			},
		});
		if (!result.ok) throw new Error("expected a plan");
		expect(result.message).toContain("Would ask the home-background host");
	});

	it("refuses host beside a terminal, a layout, a suffixed verb or another command", async () => {
		const { state, id } = await questNamed("Alpha");
		for (const clash of [
			{ action: "spawn", terminal: "kitty" },
			{ action: "spawn", layout: "tab" },
			{ action: "spawn-tab" },
			{ action: "spawn", machine: "elsewhere" },
			{ action: "spawn", command: "pi --model x" },
		]) {
			const result = await handle(state, fakePi(), fakeCtx("spawner"), {
				id,
				host: "background",
				...clash,
			});
			expect(result, JSON.stringify(clash)).toMatchObject({ ok: false });
		}
		const odd = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "kitty",
		});
		expect(odd).toMatchObject({ ok: false });
		const reopen = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "reopen-sessions",
			host: "background",
		});
		expect(reopen).toMatchObject({ ok: false });
	});

	it("names the host's refusal and opens nothing else", async () => {
		await serveHost("home", "background");
		answer = async () => {
			throw new Error("engine failed");
		};
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.guidance).toContain("refused");
		expect(result.guidance).toContain("operation_failed");
	});

	it("says the outcome is unknown when an accepted answer is unreadable", async () => {
		await serveHost("home", "background");
		answer = async () => ({ sessionId: "not-a-uuid" });
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.guidance).toContain("is unknown");
	});

	it("says the outcome is unknown when the reply never comes, without retrying", async () => {
		let calls = 0;
		const result = await spawnInHost(
			{
				kind: "background",
				questId: "QEST-1",
				cwd: tmpRoot,
				chosenBy: "the folder the call named",
				env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			},
			async () => {
				calls += 1;
				throw new Error("Host control request timed out; outcome unknown");
			},
		);
		expect(calls).toBe(1);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.guidance).toContain("is unknown");
		expect(result.guidance).toContain("timed out");
	});

	it("says nothing was opened, not that the outcome is unknown, when the host's client didn't load", async () => {
		const result = await spawnInHost(
			{
				kind: "background",
				questId: "QEST-1",
				cwd: tmpRoot,
				chosenBy: "the folder the call named",
				env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			},
			async () => {
				throw new HostClientUnloaded(new Error("Cannot find module 'zod'"));
			},
		);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.guidance).toContain(
			"This pi couldn't ask the home-background host anything: the host's client didn't load (Cannot find module 'zod'). Nothing was sent, so nothing was opened.",
		);
		expect(result.guidance).not.toContain("is unknown");
	});

	it("opens in a terminal, saying why, when the host's client didn't load to ask", async () => {
		const chosen = await hostBySetting(
			{
				setting: "background",
				params: { action: "spawn" },
				placedHere: true,
				agent: async () => "pi",
				env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			},
			async () => {
				throw new HostClientUnloaded(new Error("Cannot find module 'zod'"));
			},
		);
		expect(chosen.kind).toBeUndefined();
		expect(chosen.note).toContain(
			"but this pi couldn't ask the home-background host anything (the host's client didn't load (Cannot find module 'zod')), so it opens in a terminal.",
		);
	});

	// IKQ63G, 20 November: a spawn asked again after its open timed out
	// opened a second conversation beside the first.
	it("sends a spawn asked again after a lost answer under the first's id, then a new one once answered", async () => {
		const spawn = {
			kind: "background" as const,
			questId: "QEST-1",
			cwd: tmpRoot,
			chosenBy: "the folder the call named",
			env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			pending: join(tmpRoot, "pending"),
		};
		const sent: ControlRequest[] = [];
		let lost = true;
		const call: ControlCall = async (_socket, request) => {
			sent.push(request);
			if (lost) throw new Error("Host control request timed out");
			return { v: 1, id: request.id, ok: true, result: identityFor(request) };
		};
		const first = await spawnInHost(spawn, call);
		if (first.ok) throw new Error("expected the first to go unanswered");
		expect(first.guidance, "names the id kept").toContain(sent[0]?.id);
		lost = false;
		const again = await spawnInHost(spawn, call);
		expect(again, "answered").toMatchObject({ ok: true });
		const after = await spawnInHost(spawn, call);
		expect(after, "answered").toMatchObject({ ok: true });
		const [one, two, three] = sent.map((request) => request.id);
		expect(two, "the retry repeats the lost one's id").toBe(one);
		expect(three, "a spawn after an answer is new").not.toBe(one);
	});

	// Each spawn lists the fence's first stage under a token of its own,
	// so a retry carries a new one and must still repeat the first's id.
	it("repeats the lost one's id for a staged spawn asked again with a fresh token", async () => {
		const spawn = {
			kind: "background" as const,
			questId: "QEST-1",
			cwd: tmpRoot,
			chosenBy: "the folder the call named",
			env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			pending: join(tmpRoot, "pending"),
		};
		const sent: ControlRequest[] = [];
		const call: ControlCall = async (_socket, request) => {
			sent.push(request);
			throw new Error("Host control request timed out");
		};
		await spawnInHost({ ...spawn, carried: { [STAGE_VARIABLE]: "t-1" } }, call);
		await spawnInHost({ ...spawn, carried: { [STAGE_VARIABLE]: "t-2" } }, call);
		const [one, two] = sent.map((request) => request.id);
		expect(two, "the restaged retry repeats the lost one's id").toBe(one);
	});

	it("sends a new id when the spawn asked again asks for something else", async () => {
		const spawn = {
			kind: "background" as const,
			questId: "QEST-1",
			cwd: tmpRoot,
			chosenBy: "the folder the call named",
			env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			pending: join(tmpRoot, "pending"),
		};
		const sent: ControlRequest[] = [];
		const call: ControlCall = async (_socket, request) => {
			sent.push(request);
			throw new Error("Host control request timed out");
		};
		await spawnInHost(spawn, call);
		await spawnInHost({ ...spawn, note: "Something else entirely." }, call);
		const [one, two] = sent.map((request) => request.id);
		expect(two, "another ask, another id").not.toBe(one);
	});

	it("sends a new id after a refusal, which a repeat would only get again", async () => {
		const spawn = {
			kind: "background" as const,
			questId: "QEST-1",
			cwd: tmpRoot,
			chosenBy: "the folder the call named",
			env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			pending: join(tmpRoot, "pending"),
		};
		const sent: ControlRequest[] = [];
		const replies: Awaited<ReturnType<ControlCall>>[] = [];
		const call: ControlCall = async (_socket, request) => {
			sent.push(request);
			if (sent.length === 1) throw new Error("Host control request timed out");
			const reply =
				sent.length === 2
					? {
							v: 1 as const,
							id: request.id,
							ok: false as const,
							error: { code: "busy", message: "Not now" },
						}
					: {
							v: 1 as const,
							id: request.id,
							ok: true as const,
							result: identityFor(request),
						};
			replies.push(reply);
			return reply;
		};
		await spawnInHost(spawn, call);
		const refused = await spawnInHost(spawn, call);
		expect(refused, "refused").toMatchObject({ ok: false });
		await spawnInHost(spawn, call);
		const [one, two, three] = sent.map((request) => request.id);
		expect(two, "the retry repeats the lost one's id").toBe(one);
		expect(three, "a spawn after a refusal is new").not.toBe(one);
	});

	// 23 November (ff6ecdd4): a host whose child loaded slowly said so as
	// a refusal, and the spawn reported nothing opened while it ran; its
	// opens are in spawn-still-opening.test.ts, and its adopt through the
	// quest's own session is here.
	it("says it still adopts a session whose child answered late", async () => {
		await serveHost("home", "background");
		const resumed = randomUUID();
		const { state, id } = await questWithSession(resumed, 60 * 60 * 1000);
		answer = () => {
			throw hostRefusal(OPEN_UNSETTLED, unsettledMessage(resumed));
		};

		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			host: "background",
		});

		expect(received).toEqual([expect.objectContaining({ op: "adopt" })]);
		expect(result).toMatchObject({
			ok: true,
			details: { how: "host", loading: true, resumedSessionId: resumed },
		});
		expect(said(result)).toContain(`still adopting session ${resumed}`);
	});

	it("keeps the id of a yes it couldn't read, and says to check the list first", async () => {
		const spawn = {
			kind: "background" as const,
			questId: "QEST-1",
			cwd: tmpRoot,
			chosenBy: "the folder the call named",
			env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			pending: join(tmpRoot, "pending"),
		};
		const sent: ControlRequest[] = [];
		const call: ControlCall = async (_socket, request) => {
			sent.push(request);
			return {
				v: 1,
				id: request.id,
				ok: true,
				result: { sessionId: "not-a-uuid" },
			};
		};
		const unread = await spawnInHost(spawn, call);
		if (unread.ok) throw new Error("expected an unreadable yes to refuse");
		expect(unread.guidance, "names the id kept").toContain(sent[0]?.id);
		expect(unread.guidance).toContain("check the host's list");
		await spawnInHost(spawn, call);
		const [one, two] = sent.map((request) => request.id);
		expect(two, "the retry repeats the unread one's id").toBe(one);
	});

	// A host gone since restarts holding what the lost ask opened, but not
	// the ask, so the spawn names it rather than only the missing host.
	it("names an earlier unanswered spawn when it finds no host listening", async () => {
		const spawn = {
			kind: "background" as const,
			questId: "QEST-1",
			cwd: tmpRoot,
			chosenBy: "the folder the call named",
			env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			pending: join(tmpRoot, "pending"),
		};
		const sent: ControlRequest[] = [];
		const call: ControlCall = async (_socket, request) => {
			sent.push(request);
			if (sent.length === 1) throw new Error("Host control request timed out");
			throw Object.assign(new Error("connect ECONNREFUSED"), {
				code: "ECONNREFUSED",
			});
		};
		await spawnInHost(spawn, call);
		const down = await spawnInHost(spawn, call);
		if (down.ok) throw new Error("expected no host to refuse");
		expect(down.guidance).toContain("nothing was opened");
		expect(down.guidance).toContain(`(id ${sent[0]?.id}) went unanswered`);
	});

	// What this send opened is nothing, but the ask it repeats may have.
	it("names an earlier unanswered spawn when the host's client didn't load to repeat it", async () => {
		const spawn = {
			kind: "background" as const,
			questId: "QEST-1",
			cwd: tmpRoot,
			chosenBy: "the folder the call named",
			env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			pending: join(tmpRoot, "pending"),
		};
		const sent: ControlRequest[] = [];
		const call: ControlCall = async (_socket, request) => {
			sent.push(request);
			if (sent.length === 1) throw new Error("Host control request timed out");
			throw new HostClientUnloaded(new Error("Cannot find module 'zod'"));
		};
		await spawnInHost(spawn, call);
		const unloaded = await spawnInHost(spawn, call);
		if (unloaded.ok) throw new Error("expected an unloaded client to refuse");
		expect(unloaded.guidance).toContain("Nothing was sent");
		expect(unloaded.guidance).toContain(`(id ${sent[0]?.id}) went unanswered`);
	});

	it("sends a plain spawn to the host quest-workflow.spawnHost names, with no window", async () => {
		setSpawnHost("background");
		await serveHost("home", "background");
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			note: "Write the tests.",
		});
		expect(result).toMatchObject({
			ok: true,
			details: { how: "host", host: "home-background" },
		});
		expect(received.map((r) => r.op)).toEqual(["list", "open"]);
		expect(received[1]).toMatchObject({ op: "open", quest: id });
		expect(said(result)).toContain("quest-workflow.spawnHost is background");
	});

	it("leaves a spawn to its terminal when spawnHost is off or unset", async () => {
		await serveHost("home", "background");
		const { state, id } = await questNamed("Alpha");
		for (const setting of [undefined, "off"]) {
			if (setting) setSpawnHost(setting);
			const result = await handle(state, fakePi(), fakeCtx("spawner"), {
				action: "spawn",
				id,
				dryRun: true,
			});
			expect(result, String(setting)).not.toMatchObject({
				details: { how: "host" },
			});
			expect(said(result)).not.toContain("spawnHost");
		}
		expect(received, "no host is asked anything").toEqual([]);
	});

	it("keeps a spawn that names a terminal, a layout or a command off the host", async () => {
		setSpawnHost("background");
		await serveHost("home", "background");
		const { state, id } = await questNamed("Alpha");
		for (const chosen of [
			{ action: "spawn", terminal: "kitty" },
			{ action: "spawn", layout: "tab" },
			{ action: "spawn-tab" },
			{ action: "spawn", command: "pi --model x" },
		]) {
			const result = await handle(state, fakePi(), fakeCtx("spawner"), {
				id,
				dryRun: true,
				...chosen,
			});
			expect(result, JSON.stringify(chosen)).not.toMatchObject({
				details: { how: "host" },
			});
		}
		expect(received).toEqual([]);
	});

	it("opens in a terminal, saying why, when no host of the kind is listening", async () => {
		setSpawnHost("attended");
		await serveHost("home", "background");
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			dryRun: true,
		});
		expect(result).not.toMatchObject({ details: { how: "host" } });
		expect(said(result)).toContain(
			"quest-workflow.spawnHost is attended, but no home-attended host is listening",
		);
		expect(received).toEqual([]);
	});

	it("opens nothing else when the host the setting chose refuses", async () => {
		setSpawnHost("background");
		await serveHost("home", "background");
		answer = async (request) => {
			if (request.op === "list") return { sessions: [] };
			throw new Error("engine failed");
		};
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
		});
		expect(result).toMatchObject({ ok: false });
		expect(said(result)).toContain("refused");
		expect(said(result)).toContain("Nothing else was opened");
		expect(received.map((r) => r.op)).toEqual(["list", "open"]);
	});

	it("says a spawnHost it can't read, and opens as if it were off", async () => {
		setSpawnHost("kitty");
		await serveHost("home", "background");
		const { state, id } = await questNamed("Alpha");
		const result = await handle(state, fakePi(), fakeCtx("spawner"), {
			action: "spawn",
			id,
			dryRun: true,
		});
		expect(result).not.toMatchObject({ details: { how: "host" } });
		expect(said(result)).toContain(
			"spawnHost must be off, attended or background",
		);
		expect(received).toEqual([]);
	});

	it("keeps a realm whose agent isn't pi on its terminals, asking no host", async () => {
		await serveHost("home", "background");
		const chosen = await hostBySetting({
			setting: "background",
			params: { action: "spawn" },
			placedHere: true,
			agent: async () => "pi-claude",
			env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
		});
		expect(chosen.kind).toBeUndefined();
		expect(chosen.note).toContain("starts pi-claude");
		expect(received).toEqual([]);
	});

	it("keeps a quest its needs place on another machine on its terminals", async () => {
		await serveHost("home", "background");
		const chosen = await hostBySetting({
			setting: "background",
			params: { action: "spawn" },
			placedHere: false,
			agent: async () => "pi",
			env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
		});
		expect(chosen.kind).toBeUndefined();
		expect(received).toEqual([]);
	});

	it("refuses when the conversation names no realm", async () => {
		const result = await spawnInHost(
			{
				kind: "background",
				questId: "QEST-1",
				cwd: tmpRoot,
				chosenBy: "the folder the call named",
				env: { XDG_RUNTIME_DIR: runtime },
			},
			async () => {
				throw new Error("must not be called");
			},
		);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.guidance).toContain("MYCELIUM_REALM or PI_HOME_REALM");
	});
});
