import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Past the clock by enough to absorb a busy machine, short of the hang. */
const MARGIN_MS = 2500;

type Liveness =
	typeof import("../../../../lib/internal/quest/process-liveness.ts");

/** A fresh copy, so the memoized boot token is read again. */
async function fresh(): Promise<Liveness> {
	vi.resetModules();
	return import("../../../../lib/internal/quest/process-liveness.ts");
}

/** fn's answer and how long it took, in milliseconds. */
function timed<T>(fn: () => T): { answer: T; took: number } {
	const started = Date.now();
	const answer = fn();
	return { answer, took: Date.now() - started };
}

// Quest reads this process's identity and the boot it runs under with
// synchronous `ps` and `sysctl` calls, and probes recorded sessions the
// same way. A binary that never answers froze pi with nothing to press.
// A probe that runs out its clock reads as unknown, never as gone, so a
// slow machine cannot declare a live session dead.
describe("a process probe that never answers", () => {
	let bin: string;
	let path: string | undefined;

	const hang = (name: string): void => {
		const file = join(bin, name);
		writeFileSync(file, "#!/bin/sh\nexec sleep 30\n");
		chmodSync(file, 0o755);
	};

	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "fake-probe-"));
		path = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
	});

	afterEach(() => {
		process.env.PATH = path;
		rmSync(bin, { recursive: true, force: true });
	});

	it("gives up on reading this process's identity at its clock", async () => {
		const liveness = await fresh();
		hang("ps");
		const { answer, took } = timed(() => liveness.currentProcessIdentity());
		expect(took).toBeLessThan(liveness.PROBE_TIMEOUT_MS + MARGIN_MS);
		expect(answer).toBeUndefined();
	}, 40_000);

	it("calls a recorded process unknown, not gone, when ps will not say", async () => {
		const liveness = await fresh();
		const deps = liveness.localProcessDeps();
		hang("ps");
		const recorded = {
			hostId: deps.localHostId,
			pid: process.pid,
			startToken: "whenever",
		};
		const { answer, took } = timed(() => liveness.probeProcess(recorded, deps));
		expect(took).toBeLessThan(liveness.PROBE_TIMEOUT_MS + MARGIN_MS);
		expect(answer).toBe("unknown");
	}, 40_000);

	// A host probes every recorded session on its one loop, and a record
	// whose pid is gone has no ticks to read, so each fell through to a
	// `ps` spawn only to hear it gone: 3.1 s in a soak of twelve
	// conversations (13 November).
	it.skipIf(process.platform !== "linux")(
		"reads a pid /proc doesn't hold as gone without asking ps",
		async () => {
			const liveness = await fresh();
			const deps = liveness.localProcessDeps();
			hang("ps");
			const pidMax = Number(
				readFileSync("/proc/sys/kernel/pid_max", "utf8").trim(),
			);
			const recorded = {
				hostId: deps.localHostId,
				pid: pidMax + 1,
				startToken: "whenever",
			};
			const { answer, took } = timed(() =>
				liveness.probeProcess(recorded, deps),
			);
			expect(answer, "the verdict on a pid no process holds").toBe("gone");
			expect(took, "how long the verdict took").toBeLessThan(500);
		},
		40_000,
	);

	it.skipIf(process.platform !== "darwin")(
		"gives up on reading the boot at its clock",
		async () => {
			const liveness = await fresh();
			hang("sysctl");
			const { answer, took } = timed(() => liveness.currentBootToken());
			expect(took).toBeLessThan(liveness.PROBE_TIMEOUT_MS + MARGIN_MS);
			expect(answer).toBeUndefined();
		},
		40_000,
	);
});
