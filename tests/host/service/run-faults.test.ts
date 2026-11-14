/**
 * A throw nothing caught in a host's process: contained to the conversation
 * it was made in when its screen can, otherwise the host parks every
 * conversation and its stop fails, apart from a write to a closed pipe
 * and any throw once a stop has begun, which are only reported.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHost } from "../../../host/engine/index.ts";
import type { ConversationEngine } from "../../../host/service/backend.ts";
import { controlRequest } from "../../../host/service/client.ts";
import { parseOpenResult } from "../../../host/service/protocol.ts";
import { reportToJournal, runHost } from "../../../host/service/run.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import { heldSessionStatus } from "../../../lib/core/session/roster.ts";

// The net is process-wide; serve.test.ts checks a host sets it.
vi.mock("../../../lib/internal/reload/stale-rejections.ts", () => ({
	spareStaleRejections: () => {},
}));

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h1-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dir, { recursive: true, force: true });
});

const engine = async (host: SessionHost): Promise<ConversationEngine> => ({
	prepare: async () => ({
		sessionId: randomUUID(),
		file: join(dir, `${randomUUID()}.jsonl`),
		cwd: dir,
	}),
	start: async ({ sessionId, file, cwd }) => {
		host.register({ id: sessionId, file, cwd, env: {}, close: () => {} });
	},
	discard: async () => {},
	resume: async () => {},
	abort: async () => {},
	backgroundOf: () => 0,
});

/** A background host whose uncaught throws are heard on `faults`, with one conversation open. */
async function hosting(
	contain: (sessionId: string, error: unknown) => boolean,
) {
	const faults = new EventEmitter();
	const signals = new EventEmitter();
	const report = vi.fn();
	const run = await runHost({
		argv: ["background"],
		env: { MYCELIUM_REALM: "work", XDG_RUNTIME_DIR: join(dir, "run") },
		engine,
		signals,
		ready: async () => {},
		report,
		faults,
		contain,
		places: {
			rosterDir: join(dir, "rosters"),
			registryDir: join(dir, "hosts"),
		},
	});
	const reply = await controlRequest(run.serving.path, {
		v: 1,
		id: "o",
		op: "open",
		cwd: dir,
		attended: false,
	});
	if (!reply.ok) throw new Error(reply.error.message);
	const { sessionId } = parseOpenResult(reply.result);
	const settled = { done: false };
	run.stopped.then(
		() => Object.assign(settled, { done: true }),
		() => Object.assign(settled, { done: true }),
	);
	return { run, faults, signals, report, sessionId, settled };
}

const listening = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);

describe("a throw nothing caught", () => {
	it("is contained to the conversation it was made in, and the host serves on", async () => {
		const contain = vi.fn(() => true);
		const host = await hosting(contain);
		const stale = new Error("This extension ctx is stale");

		withSession(host.sessionId, () =>
			host.faults.emit("uncaughtException", stale),
		);

		expect(contain).toHaveBeenCalledWith(host.sessionId, stale);
		expect(
			await listening(host.run.serving.path),
			"the host still listens",
		).toBe(true);
		expect(host.settled.done, "the host has not stopped").toBe(false);
		expect(
			await heldSessionStatus(host.sessionId, { dir: join(dir, "rosters") }),
		).toBe("held");
		host.signals.emit("SIGTERM");
		await host.run.stopped;
	});

	it("outside every conversation parks them all, then fails the host's stop", async () => {
		const contain = vi.fn(() => true);
		const host = await hosting(contain);
		const lost = new Error("a socket's handler broke");

		host.faults.emit("uncaughtException", lost);

		await expect(host.run.stopped).rejects.toThrow(
			"The host threw outside every conversation, so it parked them all and stopped: a socket's handler broke",
		);
		expect(contain).not.toHaveBeenCalled();
		expect(host.report).toHaveBeenCalledWith(lost);
		expect(
			await listening(host.run.serving.path),
			"the stopped host no longer listens",
		).toBe(false);
		expect(
			await heldSessionStatus(host.sessionId, { dir: join(dir, "rosters") }),
		).toBe("held");
	});

	// The background host at 18:26:46 on 13 November: a language server's
	// writer threw on its closed pipe, the host stopped mid-turn for it,
	// and exited 1, so systemd ran OnFailure.
	it.each(["ERR_STREAM_DESTROYED", "EPIPE"])(
		"outside every conversation, as a write to a closed pipe (%s), is reported once and the host serves on",
		async (code) => {
			const host = await hosting(() => true);
			const closed = Object.assign(
				new Error("Cannot call write after a stream was destroyed"),
				{ code },
			);

			host.faults.emit("uncaughtException", closed);

			expect(host.report).toHaveBeenCalledExactlyOnceWith(closed);
			expect(
				await listening(host.run.serving.path),
				"the host still listens",
			).toBe(true);
			expect(host.settled.done, "the host has not stopped").toBe(false);
			expect(host.run.serving.stopping(), "nor begun to").toBe(false);
			host.signals.emit("SIGTERM");
			await host.run.stopped;
		},
	);

	it("once a signal's stop has begun is only reported, and the stop still ends cleanly", async () => {
		const host = await hosting(() => true);
		const late = new Error("a socket's handler broke as it closed");

		host.signals.emit("SIGTERM");
		host.faults.emit("uncaughtException", late);

		await expect(host.run.stopped).resolves.toBeUndefined();
		expect(host.report).toHaveBeenCalledExactlyOnceWith(late);
	});

	it("in a conversation no screen can contain it in stops the host the same way", async () => {
		const host = await hosting(() => false);

		withSession(host.sessionId, () =>
			host.faults.emit("uncaughtException", new Error("no screen")),
		);

		await expect(host.run.stopped).rejects.toThrow(
			`Conversation ${host.sessionId} threw with no screen to contain it`,
		);
	});
});

describe("the journal", () => {
	it("is told what caused an error, where a contained throw came from", () => {
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		reportToJournal(
			new Error("Conversation a threw", { cause: new Error("stale ctx") }),
		);

		expect(write).toHaveBeenCalledWith(
			expect.stringMatching(
				/Conversation a threw[\s\S]*Caused by: Error: stale ctx/,
			),
		);
	});
});
