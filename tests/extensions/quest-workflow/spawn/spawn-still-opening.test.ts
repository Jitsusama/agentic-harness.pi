/**
 * A host spawn whose host's child runs the session it asked for but gave
 * no answer in time: attached to, said as still opening, and answered,
 * so the next spawn is a new ask.
 *
 * 23 November (ff6ecdd4): a host whose child loaded slowly said so as a
 * refusal, and the spawn reported nothing opened while it ran.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ControlCall,
	spawnInHost,
} from "../../../../extensions/quest-workflow/verbs/spawn-host.ts";
import type { ControlRequest } from "../../../../host/service/protocol.ts";
import {
	OPEN_UNSETTLED,
	unsettledMessage,
} from "../../../../host/service/unsettled-open.ts";
import { leaveSpawns } from "../../../../lib/internal/fence/fence-stage.ts";

// A miss is counted from the system's log, which a test must never write.
vi.mock("../../../../lib/internal/fence/fence-log.ts", async (original) => ({
	...(await original<
		typeof import("../../../../lib/internal/fence/fence-log.ts")
	>()),
	recordUnlisted: vi.fn(async () => undefined),
}));

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "spawn-late-"));
});
afterEach(() => {
	leaveSpawns();
	rmSync(tmpRoot, { recursive: true, force: true });
});

/** A spawn into the home realm's background host, kept to this test's folder. */
function spawn() {
	return {
		kind: "background" as const,
		questId: "QEST-1",
		cwd: tmpRoot,
		chosenBy: "the folder the call named",
		env: { MYCELIUM_REALM: "home", XDG_RUNTIME_DIR: tmpRoot },
		pending: join(tmpRoot, "pending"),
	};
}

/** A host that answers each request with this refusal, noting each it was sent. */
function refusing(code: string, message: string, sent: ControlRequest[] = []) {
	return async (_socket: string, request: ControlRequest) => {
		sent.push(request);
		return {
			v: 1 as const,
			id: request.id,
			ok: false as const,
			error: { code, message },
		};
	};
}

/** What a result says, whichever way it went. */
function said(result: Awaited<ReturnType<typeof spawnInHost>>): string {
	return result.ok ? result.message : result.guidance;
}

describe("a spawn whose host's child answers its open late", () => {
	it("attaches to the session its child runs, saying it still opens", async () => {
		const running = randomUUID();

		const result = await spawnInHost(
			spawn(),
			refusing(OPEN_UNSETTLED, unsettledMessage(running)),
		);

		expect(result).toMatchObject({
			ok: true,
			details: {
				how: "host",
				host: "home-background",
				sessionId: running,
				loading: true,
			},
		});
		expect(said(result)).toContain(`still opening session ${running}`);
	});

	// Only an id kept for a lost answer could be sent twice, so the first
	// ask goes unanswered and the late one answers its repeat.
	it("sends a new id for the next spawn, since the late one was answered", async () => {
		const sent: ControlRequest[] = [];
		const late = refusing(OPEN_UNSETTLED, unsettledMessage(randomUUID()), sent);
		const call: ControlCall = async (socket, request) => {
			if (sent.length === 0) {
				sent.push(request);
				throw new Error("Host control request timed out");
			}
			return late(socket, request);
		};

		await spawnInHost(spawn(), call);
		const attached = await spawnInHost(spawn(), call);
		await spawnInHost(spawn(), call);

		expect(attached, "the repeat attached").toMatchObject({ ok: true });
		const [one, two, three] = sent.map((request) => request.id);
		expect(two, "the retry repeats the lost one's id").toBe(one);
		expect(three, "a spawn after the late answer is new").not.toBe(one);
	});

	it("still refuses an unsettled open that names no session", async () => {
		const result = await spawnInHost(
			spawn(),
			refusing(OPEN_UNSETTLED, "The conversation's process gave no answer"),
		);

		expect(result).toMatchObject({ ok: false });
		expect(said(result)).toContain(OPEN_UNSETTLED);
		expect(said(result)).toContain("Nothing else was opened");
	});

	it("says how to view an attended one it still opens", async () => {
		const running = randomUUID();

		const result = await spawnInHost(
			{ ...spawn(), kind: "attended" },
			refusing(OPEN_UNSETTLED, unsettledMessage(running)),
		);

		const attach = [
			"mycelium",
			"--realm",
			"home",
			"attach",
			"--host",
			"home-attended",
			"--session",
			running,
		];
		expect(result).toMatchObject({
			ok: true,
			details: { attended: true, loading: true, attach },
		});
		expect(said(result)).toContain(attach.join(" "));
	});
});
