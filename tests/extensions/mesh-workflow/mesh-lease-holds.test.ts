/**
 * A lease on the machine: a hold and the answers that keep or end it,
 * and heavy work claimed, through a reload or a host's restart, and
 * left to the machine's queue.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { awaitedNow } from "../../../lib/internal/priority/awaited.ts";
import { JOBS_TAKEN_UP } from "../../../lib/jobs/host.ts";
import { JOBS_FINISHED } from "../../../lib/jobs/index.ts";
import { LEASE_EVENT } from "../../../lib/mesh/lease.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	fromElsewhere,
	leased,
	ownBoard,
	peer,
	type Sent,
	send,
	sentOut,
	startSession,
} from "./support/mesh.ts";

describe("a lease", () => {
	it("holds what this peer holds until it ends its own hold", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { tools } = await startSession();

		const said = await send(tools, "all", "hold", "hold heavy builds");
		const [hold = ""] = folderTransport(
			join(fixture.paths.mesh, "messages"),
		).ids();

		expect(said).toContain("It holds for two hours at most");
		expect(ownBoard()).toMatchObject([{ kind: "hold", subject: hold }]);
		const ended = await tools.get("mesh_send")?.execute("call-2", {
			to: "all",
			intent: "fyi",
			text: "builds may run again",
			re: hold,
			endsHold: true,
		});
		expect(ended?.content[0]?.text).toContain("this peer's own hold");
		expect(ownBoard()).toEqual([]);
	});

	// On 12 November a holder's note that a small push was fine during its
	// hold answered it with re, and every waiting peer was told to carry on.
	it("keeps its own hold when a note answers it without ending it", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { tools } = await startSession();
		await send(tools, "all", "hold", "hold heavy builds");
		const messages = folderTransport(join(fixture.paths.mesh, "messages"));
		const [hold = ""] = messages.ids();

		const toPeer = await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "fyi",
			text: "a small git push is fine during the hold",
			re: hold,
		});
		const note = messages.ids().find((id) => id !== hold) ?? "";

		expect(
			messages.read(note)?.re,
			"a note on a hold its holder keeps answers nothing, so no peer reads it as the end",
		).toBeUndefined();
		expect(toPeer?.content[0]?.text).toContain("it still holds");
		expect(toPeer?.content[0]?.text).toContain("endsHold");

		// Everyone it parked hears only holds and their ends, so there the
		// note is refused, saying why.
		const toAll = await tools.get("mesh_send")?.execute("call-3", {
			to: "all",
			intent: "fyi",
			text: "a small git push is fine during the hold",
			re: hold,
		});
		expect(toAll?.content[0]?.text).toMatch(/^Not sent: .*it still holds/);
		expect(toAll?.content[0]?.text).toContain("endsHold");
		expect(messages.ids(), "nothing more was written").toHaveLength(2);
		expect(ownBoard(), "the holder still holds it").toMatchObject([
			{ kind: "hold", subject: hold },
		]);
	});

	it("ends its own hold with an fyi even when the end is sent as a hold", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { tools } = await startSession();
		await send(tools, "all", "hold", "hold heavy builds");
		const messages = folderTransport(join(fixture.paths.mesh, "messages"));
		const [hold = ""] = messages.ids();

		const said = await tools.get("mesh_send")?.execute("call-2", {
			to: "all",
			intent: "hold",
			text: "the hold is over; carry on",
			re: hold,
			endsHold: true,
		});
		const end = messages.ids().find((id) => id !== hold) ?? "";

		expect(messages.read(end)?.intent).toBe("fyi");
		expect(messages.read(end)?.re).toBe(hold);
		expect(said?.content[0]?.text).toContain(
			"this peer's own hold, so it went as an fyi",
		);
		expect(said?.content[0]?.text).not.toContain("It holds for two hours");
		expect(ownBoard()).toEqual([]);
	});

	it("answers another peer's hold with an fyi, so the answer parks nobody", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { tools } = await startSession();
		const hold = fromElsewhere({ intent: "hold", text: "rebooting" });
		const messages = folderTransport(join(fixture.paths.mesh, "messages"));

		const said = await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "hold",
			text: "parked",
			re: hold.id,
		});
		const answer = messages.ids().find((id) => id !== hold.id) ?? "";

		expect(messages.read(answer)?.intent).toBe("fyi");
		expect(said?.content[0]?.text).toContain("another peer's hold");
		expect(ownBoard()).toMatchObject([{ kind: "wait", subject: hold.id }]);
	});

	it("waits on another's hold it answers, and carries on with a turn when it ends", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		const hold = fromElsewhere({ intent: "hold", text: "hold qemu" });

		const said = await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "fyi",
			text: "my vm test waits on this",
			re: hold.id,
		});
		expect(said?.content[0]?.text).toContain(
			`This peer waits on [${hold.id.slice(-8)}] now`,
		);
		expect(ownBoard()).toMatchObject([{ kind: "wait", subject: hold.id }]);

		// The holder's word can go where this peer does not listen.
		fromElsewhere({
			to: ["#optimus"],
			re: hold.id,
			text: "qemu is free",
		});

		const over = ({ message }: Sent) =>
			message.content.startsWith("The hold [");
		await vi.waitFor(() => expect(sent.find(over)).toBeDefined());
		const resumed = sent.find(over);
		expect(resumed?.options).toEqual({ triggerTurn: true });
		expect(resumed?.message.content).toContain(
			'is over: its holder said "qemu is free". This peer had said: "my vm test waits on this".',
		);
		expect(resumed?.message.content).toContain("Carry on with what it held up");
		expect(ownBoard()).toEqual([]);
	});

	it("carries on with a turn when a hold it parked for ends after a reboot", async () => {
		peer("session-w", ["WCJQSG"], []);
		const before = await startSession({}, { isIdle: () => true });
		const hold = fromElsewhere({ intent: "hold", text: "rebooting" });
		await before.tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "fyi",
			text: "parked",
			re: hold.id,
		});
		await before.fire("session_shutdown");

		// Both come back after the reboot: this session restored, and its
		// holder under the same address with another pid.
		const { sent } = await startSession({}, { isIdle: () => true });
		fromElsewhere({ re: hold.id, text: "reboot done", pid: process.pid + 2 });

		await vi.waitFor(() =>
			expect(
				sent.find(({ message }) =>
					message.content.includes('its holder said "reboot done"'),
				)?.options,
			).toEqual({ triggerTurn: true }),
		);
		expect(ownBoard()).toEqual([]);
	});

	it("tells the machine queue whose work this peer is parked on", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { tools, fire } = await startSession();
		expect(awaitedNow()).toEqual(new Set());
		const hold = fromElsewhere({ intent: "hold", text: "kernel build first" });
		await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "fyi",
			text: "parked",
			re: hold.id,
		});

		expect(awaitedNow()).toEqual(new Set(["session-w"]));
		await fire("session_shutdown");
		expect(awaitedNow()).toEqual(new Set());
	});

	it("ends unsaid when the peer holding it has ended, so is no go-ahead", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, tools } = await startSession(
			{},
			{ isIdle: () => false },
			[],
			undefined,
			30,
		);
		const hold = fromElsewhere({ intent: "hold", text: "hold qemu" });
		await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "fyi",
			text: "waiting",
			re: hold.id,
		});

		peer("session-w", ["WCJQSG"], [], true);

		await vi.waitFor(() =>
			expect(
				sent.find(({ message }) =>
					message.content.includes("is over: its holder has ended"),
				)?.options,
			).toEqual({ triggerTurn: false }),
		);
		const over = sent.find(({ message }) =>
			message.content.startsWith("The hold ["),
		)?.message.content;
		expect(over).toContain(
			`Its holder never said [${hold.id.split("-").pop()}] was over, so what it named may still be in use`,
		);
		expect(over).not.toContain("Carry on with what it held up");
		expect(ownBoard()).toEqual([]);
	});

	it("tells both sides, once, when heavy work overlaps", async () => {
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { kind: "heavy", subject: "qemu", why: "vm test" });
		const { sent, emit } = await startSession();

		emit(LEASE_EVENT, { take: { subject: "qemu", why: "flake check" } });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.content).toMatch(
			/^WCJQSG \(since \d\d:\d\d\) is running heavy work on qemu already/,
		);
		expect(sentOut()).toMatchObject([
			{
				to: ["@WCJQSG"],
				text: expect.stringContaining("too (flake check)"),
			},
		]);
		expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "qemu" }]);

		emit(LEASE_EVENT, { take: { subject: "qemu", why: "flake check" } });
		emit(LEASE_EVENT, { release: "qemu" });
		await vi.waitFor(() => expect(ownBoard()).toEqual([]));
		expect(sent).toHaveLength(1);
		expect(sentOut()).toHaveLength(1);
	});

	it("leaves heavy work overlapping to the machine's queue while it is kept", async () => {
		const runtime = join(fixture.root, "run");
		mkdirSync(join(runtime, "jobs"), { recursive: true });
		writeFileSync(join(runtime, "jobs", "queue.json"), "{}\n");
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { kind: "heavy", subject: "qemu", why: "vm test" });
		const { sent, emit } = await startSession({ XDG_RUNTIME_DIR: runtime });

		emit(LEASE_EVENT, { take: { subject: "qemu", why: "flake check" } });

		await vi.waitFor(() =>
			expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "qemu" }]),
		);
		// A real pause: the test is that neither side is told in it.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toEqual([]);
		expect(sentOut()).toEqual([]);
	});

	it("tells nobody of a background command's claim, though another holds the same", async () => {
		// Two sessions running one script share job ids and first words.
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { kind: "heavy", subject: "background j7: ls" });
		const { sent, fire } = await startSession();

		await fire("tool_call", {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "b1",
			input: { command: "ls" },
		});
		await fire("tool_result", {
			type: "tool_result",
			toolCallId: "b1",
			content: [{ type: "text", text: "Running as background command j7." }],
		});

		await vi.waitFor(() =>
			expect(ownBoard()).toMatchObject([
				{ kind: "heavy", subject: "background j7: ls" },
			]),
		);
		// A real pause: the test is that neither side is told in it.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toEqual([]);
		expect(sentOut()).toEqual([]);
	});

	it("claims a heavy shell command's work until its call answers", async () => {
		const { fire, emit } = await startSession();
		const running = (id: string, command: string) =>
			fire("tool_call", {
				type: "tool_call",
				toolName: "bash",
				toolCallId: id,
				input: { command },
			});
		const answered = (id: string, text = "done") =>
			fire("tool_result", {
				type: "tool_result",
				toolCallId: id,
				content: [{ type: "text", text }],
			});

		expect(await running("b0", "ls")).toBeUndefined();
		expect(ownBoard()).toEqual([]);
		await running("b1", "nice -n 10 nix flake check\necho ok");
		await running("b2", "nix flake check .#vm");
		expect(ownBoard()).toMatchObject([
			{
				kind: "heavy",
				subject: "build",
				// Two calls on one kind of work: it says the latest, by its first line.
				why: "nix flake check .#vm",
			},
		]);
		await answered("b1");
		expect(ownBoard()).toHaveLength(1);
		await answered("b2");
		expect(ownBoard()).toEqual([]);

		// One handed to a job runs on past its answer.
		await running("b3", "qemu-system-x86_64");
		await answered(
			"b3",
			"Still running after 5 minutes, so it now runs in the background as job 4.",
		);
		expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "vm-test" }]);
		// Until its job says it has ended; another job's end is not its.
		const finished = (toolCallId: string) =>
			emit(JOBS_FINISHED, {
				jobId: "4",
				kind: "shell",
				toolCallId,
				failed: false,
			});
		finished("other");
		// A real pause: the test is that another job's end lets nothing go in it.
		await new Promise((done) => setTimeout(done, 10));
		expect(ownBoard()).toHaveLength(1);
		finished("b3");
		// A real pause, for this job's end to let its claim go.
		await new Promise((done) => setTimeout(done, 10));
		expect(ownBoard()).toEqual([]);
	});

	describe("a handed-off call's heavy work, through a reload", () => {
		const handedOff = async (run: Awaited<ReturnType<typeof startSession>>) => {
			await run.fire("tool_call", {
				type: "tool_call",
				toolName: "bash",
				toolCallId: "b3",
				input: { command: "qemu-system-x86_64" },
			});
			await run.fire("tool_result", {
				type: "tool_result",
				toolCallId: "b3",
				content: [{ type: "text", text: "Running as background command j1." }],
			});
		};
		const ended = {
			jobId: "j1",
			kind: "shell",
			toolCallId: "b3",
			failed: false,
		};

		it("stays claimed, and the runtime the reload starts lets it go when its job ends", async () => {
			const first = await startSession();
			await handedOff(first);
			await first.fire("session_shutdown", { reason: "reload" });
			expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "vm-test" }]);

			const next = await startSession();
			expect(ownBoard()).toMatchObject([{ kind: "heavy", subject: "vm-test" }]);
			next.emit(JOBS_FINISHED, ended);
			await vi.waitFor(() => expect(ownBoard()).toEqual([]));
		});

		it("is let go when its job ends before the new runtime has started", async () => {
			const first = await startSession();
			await handedOff(first);
			await first.fire("session_shutdown", { reason: "reload" });

			await startSession({}, {}, [], undefined, undefined, (emit) =>
				emit(JOBS_FINISHED, ended),
			);
			await vi.waitFor(() => expect(ownBoard()).toEqual([]));
		});

		it("is let go at once when the session ends any other way", async () => {
			const first = await startSession();
			await handedOff(first);
			await first.fire("session_shutdown", { reason: "new" });
			expect(ownBoard()).toEqual([]);
		});
	});

	describe("a call carried here through a host's restart", () => {
		const takenUp = {
			jobId: "j1",
			kind: "shell",
			label: "qemu-system-x86_64",
			toolCallId: "b3",
		};
		const ended = {
			jobId: "j1",
			kind: "shell",
			toolCallId: "b3",
			failed: false,
		};

		it("claims its heavy work again until its job ends", async () => {
			const run = await startSession();
			run.emit(JOBS_TAKEN_UP, takenUp);
			await vi.waitFor(() =>
				expect(ownBoard()).toMatchObject([
					{ kind: "heavy", subject: "vm-test" },
				]),
			);
			run.emit(JOBS_FINISHED, ended);
			await vi.waitFor(() => expect(ownBoard()).toEqual([]));
		});

		it("claims it once the session starts when taken up before", async () => {
			await startSession({}, {}, [], undefined, undefined, (emit) =>
				emit(JOBS_TAKEN_UP, takenUp),
			);
			await vi.waitFor(() =>
				expect(ownBoard()).toMatchObject([
					{ kind: "heavy", subject: "vm-test" },
				]),
			);
		});

		it("claims nothing when it ended before the session started", async () => {
			await startSession({}, {}, [], undefined, undefined, (emit) => {
				emit(JOBS_TAKEN_UP, takenUp);
				emit(JOBS_FINISHED, ended);
			});
			// A real pause: the test is that nothing is claimed in it.
			await new Promise((done) => setTimeout(done, 50));
			expect(ownBoard()).toEqual([]);
		});
	});
});
