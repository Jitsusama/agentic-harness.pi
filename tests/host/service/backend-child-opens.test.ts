/** The backend opening and adopting conversations in children of their own. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	BEGIN_TOO_LATE,
	beganTooLate,
	CHILD_SAID_UNSETTLED,
} from "../../../host/service/child-requests.ts";
import { dispatchControl } from "../../../host/service/dispatch.ts";
import {
	OPEN_UNSETTLED,
	unsettledMessage,
} from "../../../host/service/unsettled-open.ts";
import {
	backendWith,
	children,
	dir,
	engine,
	entry,
	roster,
	shown,
	useBackendBed,
} from "./support/backend-children.ts";

useBackendBed();

describe("a conversation opened while children open", () => {
	const open = {
		v: 1,
		id: "o",
		op: "open",
		cwd: "/work",
		attended: false,
	} as const;

	it("starts in a child, answering what the child answered", async () => {
		const inHost = engine();
		const moved = children([], true);

		const opened = await backendWith(inHost, moved.fake).execute(open);

		expect(opened).toEqual(shown(moved.opened));
		expect(moved.fake.begin).toHaveBeenCalledExactlyOnceWith(
			open,
			expect.any(Number),
		);
		expect(inHost.prepare).not.toHaveBeenCalled();
	});

	// 23 November (ff6ecdd4): a census slow beside many children took its
	// time out of the caller's 120 s, not the begin's 100 s, so a spawn
	// gave up on an open its host still ran.
	it("counts its begin's time from when the host took it, before the rollout gate", async () => {
		await roster.hold(entry());
		const moved = children([], true);
		const took = Date.parse("2026-11-23T05:00:00.000Z");
		const censusTakes = 30_000;
		vi.useFakeTimers({ toFake: ["Date"], now: took });
		const slowCensus = vi.fn(async () => {
			vi.setSystemTime(took + censusTakes);
		});
		try {
			await backendWith(engine(), moved.fake, slowCensus).execute(open);
		} finally {
			vi.useRealTimers();
		}

		expect(slowCensus, "the census ran first").toHaveBeenCalledOnce();
		expect(moved.fake.begin).toHaveBeenCalledExactlyOnceWith(open, took);
	});

	it("passes the rollout gate beside another", async () => {
		await roster.hold(entry());
		const moved = children([], true);
		const gate = vi.fn(async () => {});

		await backendWith(engine(), moved.fake, gate).execute(open);

		expect(gate).toHaveBeenCalledOnce();
	});

	it("adopts in a child too", async () => {
		const moved = children([], true);
		const adopt = {
			v: 1,
			id: "d",
			op: "adopt",
			sessionFile: join(dir, "elsewhere.jsonl"),
			attended: true,
			env: {},
		} as const;

		await backendWith(engine(), moved.fake).execute(adopt);

		expect(moved.fake.begin).toHaveBeenCalledExactlyOnceWith(
			adopt,
			expect.any(Number),
		);
	});

	it("refuses to adopt a file the host already holds, starting no child", async () => {
		const held = entry();
		await roster.hold(held);
		const moved = children([], true);

		const reply = await dispatchControl(
			{
				v: 1,
				id: "d",
				op: "adopt",
				sessionFile: held.file,
				attended: true,
			},
			backendWith(engine(), moved.fake),
		);

		expect(reply).toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("already held") },
		});
		expect(moved.fake.begin).not.toHaveBeenCalled();
	});

	it("fails when its child can't start, as an open in the host would", async () => {
		const moved = children([], true);
		moved.fake.begin.mockRejectedValueOnce(
			new Error("The child's process ended before it listened"),
		);

		const reply = await dispatchControl(
			open,
			backendWith(engine(), moved.fake),
		);

		expect(reply).toMatchObject({ ok: false });
		expect(roster.entries()).toEqual([]);
	});

	it("is refused with the child's own refusal", async () => {
		const moved = children([], true);
		moved.fake.begin.mockResolvedValueOnce({
			v: 1,
			id: "o",
			ok: false,
			error: { code: "untrusted_folder", message: "Trust /work first" },
		});

		const reply = await dispatchControl(
			open,
			backendWith(engine(), moved.fake),
		);

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "untrusted_folder", message: "Trust /work first" },
		});
	});

	// Only the host may say a child runs a conversation all the same, since
	// its caller attaches to the one named; a child saying so of itself was
	// stopped, so its refusal is a plain failure, and its repeat begins anew.
	it("takes a child's own open_unsettled as a failure to open, in the host's words", async () => {
		const moved = children([], true);
		const named = randomUUID();
		const said = {
			code: OPEN_UNSETTLED,
			message: unsettledMessage(named),
		};
		moved.fake.begin.mockImplementation(async (request) => ({
			v: 1,
			id: request.id,
			ok: false,
			error: said,
		}));
		const backend = backendWith(engine(), moved.fake);

		const reply = await dispatchControl(open, backend);
		await dispatchControl({ ...open }, backend);

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "operation_failed", message: CHILD_SAID_UNSETTLED },
		});
		const message = reply.ok ? "" : reply.error.message;
		expect(message, "names nothing to attach to").not.toContain(named);
		expect(
			moved.fake.begin,
			"no conversation stands for it",
		).toHaveBeenCalledTimes(2);
	});

	// A begin the host refused before any child started leaves nothing
	// standing, so its repeat is begun again, not told the refusal.
	it("passes a begin refused as too late on as it is, and begins its repeat anew", async () => {
		const moved = children([], true);
		moved.fake.begin.mockImplementation(async (request) =>
			beganTooLate(request.id, 95_000, 100_000),
		);
		const backend = backendWith(engine(), moved.fake);

		const reply = await dispatchControl(open, backend);
		await dispatchControl({ ...open }, backend);

		expect(reply).toMatchObject({
			ok: false,
			error: { code: BEGIN_TOO_LATE },
		});
		const message = reply.ok ? "" : reply.error.message;
		expect(message).toContain("spent 95 s of its 100 s");
		expect(message).toContain("once the machine is quieter");
		expect(moved.fake.begin, "its repeat begun anew").toHaveBeenCalledTimes(2);
	});
});
