import { statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	HEARTBEAT_MS,
	isKept,
	machineQueueDir,
	readQueue,
} from "../../../../lib/internal/priority/folder.ts";
import {
	dir,
	folder,
	freshFolderEachTest,
	job,
	NOW,
	ROOMY,
	record,
	shellSays,
	TIGHT,
} from "./queue-folder.ts";

freshFolderEachTest();

describe("the machine's queue folder", () => {
	it("is kept while queue.json is younger than two minutes", () => {
		expect(machineQueueDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
			"/run/user/1000/jobs",
		);
		// A Mac names its account's temporary folder when nothing else does
		// (87KI6A [606d1d2c]); Linux has none to name.
		if (platform() === "darwin") {
			expect(machineQueueDir({}), "a Mac's isn't its jobs folder").toMatch(
				/\/jobs$/,
			);
		} else {
			expect(machineQueueDir({})).toBeUndefined();
		}
		expect(isKept(dir), "a folder with no queue.json is not kept").toBe(false);
		folder().keep(ROOMY, NOW, () => undefined);
		const written = statSync(join(dir, "queue.json")).mtimeMs;
		expect(
			isKept(dir, written + 119_999),
			"a queue.json just under two minutes old is kept",
		).toBe(true);
		expect(
			isKept(dir, written + 120_000),
			"a queue.json two minutes old is not kept",
		).toBe(false);
	});

	it("is read back only while it is kept, and only in a shape it knows", () => {
		expect(readQueue(dir)).toBeUndefined();
		const queue = folder();
		queue.ask(job("waiting"));
		queue.keep(ROOMY, NOW, () => undefined);
		const written = statSync(join(dir, "queue.json")).mtimeMs;

		expect(readQueue(dir, written)?.jobs.map(({ id }) => id)).toEqual([
			"waiting",
		]);
		// What nobody keeps says what ran before, not what runs now.
		expect(readQueue(dir, written + 120_000)).toBeUndefined();
		writeFileSync(join(dir, "queue.json"), '{"v":2,"jobs":[]}\n');
		expect(readQueue(dir)).toBeUndefined();
	});

	it("writes queue.json when it changes or its heartbeat is due", () => {
		const queue = folder();
		queue.ask(job("waiting"));
		shellSays("waiting", 501);
		queue.keep(TIGHT, NOW, () => undefined);
		const first = record().heartbeat;
		queue.keep(TIGHT, NOW + HEARTBEAT_MS - 1, () => undefined);
		expect(record().heartbeat).toBe(first);
		expect(
			queue.isDue(statSync(join(dir, "queue.json")).mtimeMs + 1),
			"no heartbeat is due a moment after queue.json was written",
		).toBe(false);
		queue.keep(TIGHT, NOW + HEARTBEAT_MS, () => undefined);
		expect(record().heartbeat).toBe(first + HEARTBEAT_MS / 1000);
		queue.ask(job("another"));
		shellSays("another", 502);
		queue.keep(TIGHT, NOW + HEARTBEAT_MS + 1_000, () => undefined);
		expect(record().jobs).toHaveLength(2);
		expect(queue.hasJobs(), "a queue holding two jobs has jobs").toBe(true);
	});

	it("says it keeps quiet while the person is on a call, at once", () => {
		const queue = folder();
		queue.ask(job("waiting"));
		shellSays("waiting", 501);
		queue.keep({ ...ROOMY, onCall: true }, NOW, () => undefined);
		expect(record().quiet).toEqual({ call: true });
		expect(record().room).toEqual({ vms: 0, builds: 0 });
		expect(record().jobs[0]?.waitingOn).toBe("call");
		queue.keep(ROOMY, NOW + 1_000, () => undefined);
		expect(
			record().quiet,
			"the call over, it says so before the heartbeat",
		).toBeNull();
		expect(record().jobs[0]?.state).toBe("running");
	});

	it("writes a call's start and end at once, though nothing else changed", () => {
		// TIGHT gives no room either way, so only quiet tells the two apart.
		folder().keep(TIGHT, NOW, () => undefined);
		expect(record().room, "no room off the call either").toEqual({
			vms: 0,
			builds: 0,
		});
		folder().keep({ ...TIGHT, onCall: true }, NOW + 1_000, () => undefined);
		expect(record().quiet, "the call's start, before the heartbeat").toEqual({
			call: true,
		});
		folder().keep(TIGHT, NOW + 2_000, () => undefined);
		expect(record().quiet, "the call's end, before the heartbeat").toBeNull();
	});

	it("says how fast the uplink sends, leaving it to the heartbeat", () => {
		// The shell paces sessions told to carry on by it, so it's said;
		// it changes in every reading, as pressure does, so it waits.
		folder().ask(job("waiting"));
		shellSays("waiting", 501);
		folder().keep(TIGHT, NOW, () => undefined);
		expect(record().machine.uplink).toBeUndefined();
		const first = record().heartbeat;
		const sending = { ...TIGHT, uplink: { sentMbit: 6.4 } };
		folder().keep(sending, NOW + 1_000, () => undefined);
		expect(record().heartbeat).toBe(first);
		folder().keep(sending, NOW + HEARTBEAT_MS, () => undefined);
		expect(record().machine.uplink).toEqual({ sentMbit: 6.4 });
	});

	it("leaves pressure alone to the heartbeat, whichever session keeps it", () => {
		// Under ten VMs on 30 October it was replaced 123 times in 10 s,
		// each costing the shell about 20 wakeups, for pressure alone.
		folder().ask(job("waiting"));
		shellSays("waiting", 501);
		folder().keep(TIGHT, NOW, () => undefined);
		const first = record().heartbeat;
		const pressed = {
			...TIGHT,
			availableGib: TIGHT.availableGib + 0.3,
			pressure: { ...TIGHT.pressure, cpu: TIGHT.pressure.cpu + 3 },
		};
		folder().keep(pressed, NOW + 1_000, () => undefined);
		expect(record().heartbeat).toBe(first);
		folder().keep(pressed, NOW + HEARTBEAT_MS, () => undefined);
		expect(record().machine.pressure.cpu).toBe(TIGHT.pressure.cpu + 3);
	});
});
