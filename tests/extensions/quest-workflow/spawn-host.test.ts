import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { spawnInHost } from "../../../extensions/quest-workflow/verbs/spawn-host";
import { hostSocketPath } from "../../../host/service/address";
import type { ControlRequest } from "../../../host/service/protocol";
import { listenControl } from "../../../host/service/server";
import { withSession } from "../../../lib/core/session/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { installTestHost } from "../../support/session-host.ts";
import { createEnvGuard } from "./_helpers";

const SAVED = ["HOME", "MYCELIUM_REALM", "PI_HOME_REALM", "XDG_RUNTIME_DIR"];

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
	envGuard.enter();
	saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));
	tmpRoot = mkdtempSync(join(tmpdir(), "spawn-host-"));
	runtime = mkdtempSync(join(tmpdir(), "k3-"));
	process.env.HOME = tmpRoot;
	process.env.MYCELIUM_REALM = "home";
	delete process.env.PI_HOME_REALM;
	process.env.XDG_RUNTIME_DIR = runtime;
	received = [];
	answer = async (request) => identityFor(request);
});
afterEach(async () => {
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
