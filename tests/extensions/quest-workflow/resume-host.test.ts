/** /quest-resume in a hosted conversation adopts into its realm's host; on pi it switches. */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	RESUMED_MESSAGE,
	resumeQuestSession,
} from "../../../extensions/quest-workflow/resume.ts";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import { resumeInHost } from "../../../extensions/quest-workflow/verbs/spawn-host.ts";
import { hostSocketPath } from "../../../host/service/address.ts";
import type {
	ControlRequest,
	SessionIdentity,
} from "../../../host/service/protocol.ts";
import { listenControl } from "../../../host/service/server.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { installTestHost } from "../../support/session-host.ts";
import { createEnvGuard } from "./_helpers.ts";

const SAVED = ["HOME", "MYCELIUM_REALM", "PI_HOME_REALM", "XDG_RUNTIME_DIR"];
const HOUR_MS = 60 * 60 * 1000;

let tmpRoot: string;
let runtime: string;
let saved: Record<string, string | undefined>;
let received: ControlRequest[];
let holding: SessionIdentity[];
let listener: Awaited<ReturnType<typeof listenControl>> | undefined;

function identity(sessionId: string): SessionIdentity {
	return {
		sessionId,
		file: join(tmpRoot, "logs", `${sessionId}.jsonl`),
		cwd: tmpRoot,
		state: "idle",
		since: new Date().toISOString(),
	};
}

/** The realm's attended host over a real socket, adopting what it's asked. */
async function serveAttended(realm: string) {
	listener = await listenControl({
		path: hostSocketPath(realm, "attended", runtime),
		backend: {
			identity: {
				key: `${realm}-attended`,
				owner: { pid: process.pid, startedAt: 1 },
			},
			async execute(request) {
				received.push(request);
				if (request.op === "list") {
					return {
						sessions: holding,
						host: {
							key: `${realm}-attended`,
							owner: { pid: process.pid, startedAt: 1 },
						},
					};
				}
				if (request.op === "adopt") {
					const id = /_(?<id>[^_]+)\.jsonl$/.exec(request.sessionFile)?.groups
						?.id;
					if (!id) throw new Error("no id in the file's name");
					return identity(id);
				}
				throw new Error(`unexpected ${request.op}`);
			},
		},
		report: () => {},
	});
}

function fakeCtx(sessionId: string) {
	const notices: { text: string; level: string }[] = [];
	const switched: string[] = [];
	const ctx = {
		cwd: tmpRoot,
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId, isPersisted: () => true },
		ui: {
			notify: (text: string, level: string) => notices.push({ text, level }),
		},
		switchSession: async (path: string) => {
			switched.push(path);
			return { cancelled: false };
		},
	};
	return {
		ctx: ctx as unknown as Parameters<typeof resumeQuestSession>[3],
		notices,
		switched,
	};
}

/** A session log where pi keeps the logs of `cwd`, as pi names its folder. */
function writeLog(id: string, ageMs: number, cwd = tmpRoot): string {
	const folder = `--${cwd.replace(/^\//, "").replace(/[/:]/g, "-")}--`;
	const dir = join(tmpRoot, ".pi", "agent", "sessions", folder);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `2026-11-09T10-00-00-000Z_${id}.jsonl`);
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: new Date(Date.now() - ageMs).toISOString(),
			cwd,
		})}\n`,
	);
	return path;
}

/** A quest with session `id` attached and its log `ageMs` old. */
async function questWithSession(id: string, ageMs: number) {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const { ctx } = fakeCtx("spawner");
	const created = await handle(state, fakePi(), ctx, {
		action: "create",
		title: "Alpha",
	});
	if (!created.ok) throw new Error(created.guidance);
	await handle(state, fakePi(), ctx, {
		action: "session-attach",
		sessionId: id,
	});
	return { state, id: state.questId as string, log: writeLog(id, ageMs) };
}

/** Run as hosted conversation "a", whose realm is `realm`. */
async function asHosted<T>(realm: string, run: () => Promise<T>): Promise<T> {
	const host = installTestHost();
	try {
		host.host.env("a").set("MYCELIUM_REALM", realm);
		host.host.env("a").set("XDG_RUNTIME_DIR", runtime);
		return await withSession("a", run);
	} finally {
		host.dispose();
	}
}

const envGuard = createEnvGuard();
beforeEach(() => {
	envGuard.enter();
	saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));
	tmpRoot = mkdtempSync(join(tmpdir(), "resume-host-"));
	runtime = mkdtempSync(join(tmpdir(), "k9-"));
	process.env.HOME = tmpRoot;
	// The host process's own realm, which a hosted conversation never takes.
	process.env.MYCELIUM_REALM = "elsewhere";
	delete process.env.PI_HOME_REALM;
	process.env.XDG_RUNTIME_DIR = runtime;
	received = [];
	holding = [];
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

describe("/quest-resume in a hosted conversation", () => {
	it("adopts the session into its realm's attended host and says how to view it", async () => {
		await serveAttended("home");
		const resumed = randomUUID();
		const quest = await questWithSession(resumed, HOUR_MS);
		const pi = fakePi();
		const { ctx, notices, switched } = fakeCtx("a");

		await asHosted("home", () =>
			resumeQuestSession(pi, quest.state, resumed, ctx),
		);

		expect(switched, "a host's log is never switched").toEqual([]);
		expect(received.map((r) => r.op)).toEqual(["list", "adopt"]);
		expect(received[1]).toMatchObject({
			op: "adopt",
			sessionFile: quest.log,
			attended: true,
			quest: quest.id,
		});
		const attach = [
			"mycelium",
			"--realm",
			"home",
			"attach",
			"--host",
			"home-attended",
			"--session",
			resumed,
		];
		expect(pi.recorded.sent).toEqual([
			expect.objectContaining({
				customType: RESUMED_MESSAGE,
				display: true,
				details: expect.objectContaining({
					sessionId: resumed,
					host: "home-attended",
					adopted: true,
					attach,
				}),
			}),
		]);
		const said = pi.recorded.sent[0]?.content;
		expect(said).toContain(attach.join(" "));
		expect(notices).toEqual([
			expect.objectContaining({ text: said, level: "info" }),
		]);
	});

	it("adopts nothing when its host already holds the session, and still says how to view it", async () => {
		await serveAttended("home");
		const resumed = randomUUID();
		holding = [identity(resumed)];
		// A held session's log is fresh, so it reads live; the host's list
		// answers before liveness would refuse it.
		const quest = await questWithSession(resumed, 0);
		const pi = fakePi();
		const { ctx, switched } = fakeCtx("a");

		await asHosted("home", () =>
			resumeQuestSession(pi, quest.state, resumed, ctx),
		);

		expect(switched).toEqual([]);
		expect(received.map((r) => r.op)).toEqual(["list"]);
		expect(pi.recorded.sent).toEqual([
			expect.objectContaining({
				customType: RESUMED_MESSAGE,
				details: expect.objectContaining({
					sessionId: resumed,
					host: "home-attended",
					adopted: false,
				}),
			}),
		]);
		expect(pi.recorded.sent[0]?.content).toContain("already holds");
	});

	it("refuses a session live elsewhere, adopting nothing, and writes the refusal into the conversation", async () => {
		await serveAttended("home");
		const live = randomUUID();
		const quest = await questWithSession(live, 0);
		const pi = fakePi();
		const { ctx, notices, switched } = fakeCtx("a");

		await asHosted("home", () =>
			resumeQuestSession(pi, quest.state, live, ctx),
		);

		expect(switched).toEqual([]);
		expect(received.map((r) => r.op)).toEqual(["list"]);
		expect(pi.recorded.sent[0]?.content).toContain("second writer");
		expect(pi.recorded.sent[0]?.details).toMatchObject({
			sessionId: live,
			adopted: false,
			refused: true,
		});
		expect(notices[0]?.level).toBe("warning");
	});

	it("refuses a session not attached to the loaded quest before asking any host", async () => {
		await serveAttended("home");
		const quest = await questWithSession(randomUUID(), HOUR_MS);
		const stranger = randomUUID();
		const pi = fakePi();
		const { ctx, notices } = fakeCtx("a");

		await asHosted("home", () =>
			resumeQuestSession(pi, quest.state, stranger, ctx),
		);

		expect(received).toEqual([]);
		expect(notices[0]?.text).toContain("is not attached");
	});

	it("says when no host of its realm is listening, opening nothing", async () => {
		const resumed = randomUUID();
		const quest = await questWithSession(resumed, HOUR_MS);
		const pi = fakePi();
		const { ctx, switched } = fakeCtx("a");

		await asHosted("home", () =>
			resumeQuestSession(pi, quest.state, resumed, ctx),
		);

		expect(switched).toEqual([]);
		expect(pi.recorded.sent[0]?.content).toContain(
			"No home-attended host is listening",
		);
	});
});

describe("/quest-resume on plain pi", () => {
	it("switches this pi to the session's log, asking no host", async () => {
		await serveAttended("home");
		const resumed = randomUUID();
		const quest = await questWithSession(resumed, HOUR_MS);
		const pi = fakePi();
		const { ctx, switched } = fakeCtx("spawner");

		await resumeQuestSession(pi, quest.state, resumed, ctx);

		expect(switched).toEqual([quest.log]);
		expect(received).toEqual([]);
		expect(pi.recorded.sent).toEqual([]);
	});
});

describe("resumeInHost", () => {
	it("says the outcome is unknown when the list is never answered, adopting nothing", async () => {
		const asked: string[] = [];
		const result = await resumeInHost(
			{
				questId: "QEST-1",
				session: {
					id: randomUUID(),
					cwd: tmpRoot,
					started: new Date().toISOString(),
					status: "active",
					liveness: "idle",
				},
				env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: runtime },
			},
			async (_socket, request) => {
				asked.push(request.op);
				throw new Error("Host control request timed out; outcome unknown");
			},
		);
		expect(asked).toEqual(["list"]);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.guidance).toContain("timed out");
	});
});
