import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { queueFolder } from "../../../../lib/internal/priority/folder.ts";
import {
	dir,
	freshFolderEachTest,
	job,
	NOW,
	processes,
	ROOMY,
	record,
	running,
	shellSays,
} from "./queue-folder.ts";

freshFolderEachTest();

describe("the machine's queue folder, for a job a boot cut off", () => {
	it("keeps a job the boot cut off as ended at the boot, not when it was seen", async () => {
		// A Mac's queue folder outlasts a reboot, so the first keep after one
		// can come hours after the job's shell was ended by it.
		const file = join(dir, "..", "state", "outcomes.jsonl");
		const booted = NOW - 3_600_000;
		let boot = "boot-1";
		const queue = queueFolder(
			dir,
			{ ...processes, bootToken: () => boot, bootedAt: () => booted },
			undefined,
			file,
		);
		const started = booted - 120_000;
		queue.ask(
			job("cut", {
				since: new Date(started - 1000).toISOString(),
				started: new Date(started).toISOString(),
			}),
		);
		shellSays("cut", 100);
		boot = "boot-2";
		queue.keep(ROOMY, NOW, () => undefined);
		await queue.outcomesKept();
		const [kept] = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(kept).toMatchObject({
			id: "cut",
			ended: new Date(booted).toISOString(),
		});
		// It ran until some moment before the boot, not for as long as it
		// seems, and a short one would teach its work as quick.
		expect(kept, "no run time is kept for it").not.toHaveProperty("ranS");
	});

	// PV3TE0's round 2 (F9): a start no clock can read, as a hand-edited
	// or torn .job may hold.
	describe("for a job whose start can't be read", () => {
		const booted = NOW - 3_600_000;

		it("keeps a stamped one the boot cut off as ended at the boot", async () => {
			const file = join(dir, "..", "state", "outcomes.jsonl");
			let boot = "boot-1";
			const queue = queueFolder(
				dir,
				{ ...processes, bootToken: () => boot, bootedAt: () => booted },
				undefined,
				file,
			);
			queue.ask(job("unread", { since: "not a date" }));
			shellSays("unread", 100);
			boot = "boot-2";
			queue.keep(ROOMY, NOW, () => undefined);
			await queue.outcomesKept();
			const [kept] = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));

			expect(kept).toMatchObject({
				id: "unread",
				ended: new Date(booted).toISOString(),
			});
		});

		it("judges an unstamped one by its shell, never by a time it can't read", () => {
			let boot: string | undefined;
			const queue = queueFolder(dir, {
				...processes,
				bootToken: () => boot,
				bootedAt: () => booted,
			});
			queue.ask(job("unread", { since: "not a date" }));
			shellSays("unread", 100);
			boot = "boot-2";
			queue.keep(ROOMY, NOW, () => undefined);

			expect(record().jobs.map((one) => one.id)).toEqual(["unread"]);
		});
	});

	// PV3TE0's round 3 (F4): its shell gone after a reboot, a job no token
	// placed in this boot was dropped by its pid and remembered as ending
	// when seen, its run spanning the hours the machine was down.
	describe("for a job whose shell is gone and no token places in this boot", () => {
		const booted = NOW - 3_600_000;
		const started = booted - 120_000;

		/** Asks `ended` under `asked`, ends its shell, keeps under `kept`. */
		const endedUnder = async (
			asked: string | undefined,
			kept: string | undefined,
			began = started,
			saidAt?: number,
		) => {
			const file = join(dir, "..", "state", "outcomes.jsonl");
			let boot = asked;
			const queue = queueFolder(
				dir,
				{ ...processes, bootToken: () => boot, bootedAt: () => booted },
				undefined,
				file,
			);
			queue.ask(
				job("ended", {
					since: new Date(began - 1000).toISOString(),
					started: new Date(began).toISOString(),
				}),
			);
			shellSays("ended", 100);
			if (saidAt !== undefined) {
				const end = join(dir, "ended.end");
				writeFileSync(end, "0\n");
				utimesSync(end, saidAt / 1000, saidAt / 1000);
			}
			running.delete(100);
			boot = kept;
			queue.keep(ROOMY, NOW, () => undefined);
			await queue.outcomesKept();
			const [outcome] = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			return outcome;
		};

		it("keeps a stamped one the keeper can't place as ended at the boot, with no run time", async () => {
			const outcome = await endedUnder("boot-1", undefined);

			expect(outcome).toMatchObject({
				id: "ended",
				ended: new Date(booted).toISOString(),
			});
			expect(outcome).not.toHaveProperty("ranS");
		});

		it("keeps an unstamped one begun within the slack before the boot as ended at the boot", async () => {
			const outcome = await endedUnder(undefined, "boot-2");

			expect(outcome).toMatchObject({
				id: "ended",
				ended: new Date(booted).toISOString(),
			});
			expect(outcome).not.toHaveProperty("ranS");
		});

		it("keeps the run time of one its token places in this boot, though its clock dates it before", async () => {
			const outcome = await endedUnder("boot-1", "boot-1");

			expect(outcome).toMatchObject({
				id: "ended",
				ended: new Date(NOW).toISOString(),
				ranS: (NOW - started) / 1000,
			});
		});

		// PV3TE0's round 4 (F1): its shell's word, dated after the boot, was
		// capped at the boot's date, cutting its run short.
		it("keeps the run time its shell said, past the boot it began before", async () => {
			const saidAt = booted + 60_000;
			const outcome = await endedUnder("boot-1", undefined, started, saidAt);

			expect(outcome).toMatchObject({
				id: "ended",
				exit: 0,
				ranS: (saidAt - started) / 1000,
			});
		});

		it("keeps the run time of one begun after the boot", async () => {
			const outcome = await endedUnder("boot-1", undefined, booted + 60_000);

			expect(outcome).toMatchObject({
				id: "ended",
				ranS: (NOW - booted - 60_000) / 1000,
			});
		});
	});

	/** A queue whose boot changes once `cut` is asked, and its outcomes file. */
	const cutOff = (
		bootedAt: number,
		over: { since: number; started: number },
	) => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		let boot = "boot-1";
		const queue = queueFolder(
			dir,
			{ ...processes, bootToken: () => boot, bootedAt: () => bootedAt },
			undefined,
			file,
		);
		queue.ask(
			job("cut", {
				since: new Date(over.since).toISOString(),
				started: new Date(over.started).toISOString(),
			}),
		);
		shellSays("cut", 100);
		const kept = async () => {
			boot = "boot-2";
			queue.keep(ROOMY, NOW, () => undefined);
			await queue.outcomesKept();
			return readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))[0];
		};
		return { kept };
	};

	it("keeps the run time of a job the boot cut off whose shell said it ended", async () => {
		// Its shell's word dates its end, whichever boot reads it.
		const booted = NOW - 3_600_000;
		const started = booted - 120_000;
		const queue = cutOff(booted, { since: started - 1000, started });
		const end = join(dir, "cut.end");
		writeFileSync(end, "0\n");
		utimesSync(end, (started + 30_000) / 1000, (started + 30_000) / 1000);

		expect(await queue.kept()).toMatchObject({ id: "cut", exit: 0, ranS: 30 });
	});

	it("never keeps a job the boot cut off as ended after now, though it began later by a clock stepped back", async () => {
		const queue = cutOff(NOW - 3_600_000, {
			since: NOW + 59_000,
			started: NOW + 60_000,
		});

		expect(await queue.kept()).toMatchObject({
			id: "cut",
			ended: new Date(NOW).toISOString(),
		});
	});

	it("never keeps a job the boot cut off as ended after now, though the boot is dated later", async () => {
		const queue = cutOff(NOW + 60_000, {
			since: NOW - 121_000,
			started: NOW - 120_000,
		});

		expect(await queue.kept()).toMatchObject({
			id: "cut",
			ended: new Date(NOW).toISOString(),
		});
	});

	/** A queue whose boot is dated an hour before `cut` began, and its outcomes. */
	const bootDatedBefore = (started: number) => {
		const file = join(dir, "..", "state", "outcomes.jsonl");
		let boot = "boot-1";
		const queue = queueFolder(
			dir,
			{
				...processes,
				bootToken: () => boot,
				bootedAt: () => started - 3_600_000,
			},
			undefined,
			file,
		);
		queue.ask(
			job("cut", {
				since: new Date(started - 1000).toISOString(),
				started: new Date(started).toISOString(),
			}),
		);
		shellSays("cut", 100);
		const kept = async () => {
			boot = "boot-2";
			queue.keep(ROOMY, NOW, () => undefined);
			await queue.outcomesKept();
			return readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))[0];
		};
		return { kept };
	};

	it("never keeps a job the boot cut off as ended before it began", async () => {
		// A clock that stepped can date the boot before the job began.
		const started = NOW - 120_000;
		const kept = await bootDatedBefore(started).kept();

		expect(kept).toMatchObject({
			id: "cut",
			ended: new Date(started).toISOString(),
		});
		expect(kept, "never taught as quick").not.toHaveProperty("ranS");
	});

	// PV3TE0's round 4 (F1): its shell's word was capped at the cut's date,
	// its start, so a long job kept a run of none and was taught as quick.
	it("keeps the run time its shell said, though the boot is dated before the job began", async () => {
		const started = NOW - 120_000;
		const queue = bootDatedBefore(started);
		const end = join(dir, "cut.end");
		writeFileSync(end, "0\n");
		utimesSync(end, (started + 30_000) / 1000, (started + 30_000) / 1000);

		expect(await queue.kept()).toMatchObject({ id: "cut", exit: 0, ranS: 30 });
	});
});
