import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	queuedJobOf,
	timedFromTurn,
} from "../../../../lib/internal/priority/clock.ts";
import { waitsForTurn } from "../../../../lib/internal/priority/turn.ts";

let root: string;
let dir: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clock-"));
	dir = join(root, "jobs");
	mkdirSync(dir);
	writeFileSync(join(dir, "queue.json"), "{}\n");
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const bash = () => timedFromTurn(createLocalBashOperations(), { pollMs: 50 });

/** Runs `command` through `ops`, resolving with what it said or threw. */
async function run(
	ops: ReturnType<typeof bash>,
	command: string,
	timeout: number | undefined,
	signal?: AbortSignal,
): Promise<{ out: string; code?: number | null; threw?: string }> {
	let out = "";
	try {
		const { exitCode } = await ops.exec(command, root, {
			onData: (data) => {
				out += data.toString();
			},
			...(timeout === undefined ? {} : { timeout }),
			...(signal ? { signal } : {}),
		});
		return { out, code: exitCode };
	} catch (error) {
		return { out, threw: (error as Error).message };
	}
}

/** A queued command's own lines, waiting for job `id` in the test's folder. */
const queued = (id: string, work: string) =>
	`${waitsForTurn(dir, 60)?.(id)}\n${work}`;

describe("a time limit on work that waits for its turn", () => {
	it("reads the job a queued command waits under, and none from other work", () => {
		expect(queuedJobOf(queued("j1", "true"))).toEqual({ dir, id: "j1" });
		expect(queuedJobOf("echo __job='j1'")).toBeUndefined();
	});

	it("does not count the wait for its turn against the limit", async () => {
		writeFileSync(join(dir, "j1.job"), "{}\n");
		const ran = run(bash(), queued("j1", "echo ran"), 1);
		// The turn is held back past the 1 s limit the wait must not count.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		writeFileSync(join(dir, "j1.turn"), "");
		expect(await ran).toEqual({ out: "ran\n", code: 0 });
	});

	it("counts the run itself, from the moment its turn begins", async () => {
		writeFileSync(join(dir, "j2.job"), "{}\n");
		writeFileSync(join(dir, "j2.turn"), "");
		const started = Date.now();
		const said = await run(bash(), queued("j2", "echo began; sleep 30"), 1);
		expect(said).toEqual({ out: "began\n", threw: "timeout:1" });
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("does not count a stretch its shell's cgroup spends frozen", async () => {
		writeFileSync(join(dir, "j4.job"), "{}\n");
		writeFileSync(join(dir, "j4.turn"), "");
		// The cgroup thaws when the work says its sleep is over, not at a
		// time, so a shell slow to start under load can't use up the freeze.
		const thawed = join(root, "thawed");
		const asked = new Set<number>();
		const ops = timedFromTurn(createLocalBashOperations(), {
			pollMs: 50,
			frozen: (pid) => {
				asked.add(pid);
				return !existsSync(thawed);
			},
		});
		const work = `sleep 2; : > '${thawed}'; echo ran`;
		const said = await run(ops, queued("j4", work), 1);
		expect(
			said,
			"a run frozen through its 2 s sleep is not stopped at 1 s",
		).toEqual({
			out: "ran\n",
			code: 0,
		});
		const shell = Number(readFileSync(join(dir, "j4.pid"), "utf8"));
		expect([...asked], "it asks of the shell the queue holds").toEqual([shell]);
	});

	it("leaves work the queue does not hold to pi's own clock", async () => {
		const started = Date.now();
		expect(await run(bash(), "sleep 30", 1)).toEqual({
			out: "",
			threw: "timeout:1",
		});
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("is stopped by its caller while it still waits, as a stop", async () => {
		writeFileSync(join(dir, "j3.job"), "{}\n");
		const stop = new AbortController();
		const ran = run(bash(), queued("j3", "echo ran"), 1, stop.signal);
		setTimeout(() => stop.abort(), 300);
		expect(await ran).toEqual({ out: "", threw: "aborted" });
	});
});
