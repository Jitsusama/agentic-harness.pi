/**
 * A supervisor whose session has gone stops its child.
 *
 * This is the load-bearing claim under the fleet side needing no
 * reaper. A fleet job is dispatched by a session that then waits for
 * it, so the request carries that session's pid, and the supervisor's
 * watchdog stops the child as soon as the pid is gone. Without it, a
 * session dying mid-fleet would leave an expensive model running to
 * its own backstop, for hours, with nowhere to send the answer.
 *
 * The claim was stated in three comments and tested nowhere. It is
 * asserted here from the outside, by running the real supervisor
 * script against a parent that does not exist, because the in-process
 * tests cannot reach it: there the parent is the test itself, and it
 * is emphatically alive.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../../lib/subagent/artifacts.js";
import { createSupervisorStartPi } from "../../../../lib/subagent/runpi/supervisor.js";

// Real processes, doubly nested, on a pool that may be saturated.
// Nothing here waits on work: the child sleeps and is meant to be
// stopped, so this is only room for the operating system to schedule.
const APPEARS_WITHIN_MS = 60_000;

const supervisorPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../lib/subagent/runpi/supervisor.mjs",
);

/** Wait for a path to hold parseable JSON, or give up saying so. */
async function appears<T>(path: string): Promise<T> {
	const until = Date.now() + APPEARS_WITHIN_MS;
	while (Date.now() < until) {
		try {
			return JSON.parse(await readFile(path, "utf8")) as T;
		} catch {
			// Not written, or half-written. Both mean "not yet".
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(`${path} never appeared within ${APPEARS_WITHIN_MS}ms`);
}

/**
 * A pid nothing is wearing.
 *
 * Found by asking rather than assumed, since a number picked out of
 * the air is one the machine may well have handed to something, and
 * the whole point of this test is what happens when it has not.
 */
function noSuchProcess(): number {
	for (let pid = 60_000; pid < 70_000; pid++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// ESRCH is nobody. EPERM is somebody we may not signal,
			// which is still somebody.
			if (code === "ESRCH") return pid;
		}
	}
	throw new Error("every pid probed was in use, which cannot be right");
}

describe("a supervisor whose session has gone", () => {
	it("stops its child rather than running it to the backstop", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "pr-parent-exit-"));
		const childPath = join(stateDir, "child.mjs");
		// A timer rather than an unsettled promise, which is not the
		// same thing: with nothing pending node exits immediately, and
		// the first version of this test asserted against a child that
		// had already gone. A handle is what keeps it running, and it
		// has to outlast anything asserted below.
		await writeFile(childPath, "setInterval(() => {}, 1000);\n");
		// Built by the real builder rather than by hand, so this cannot
		// pass against a request shape the supervisor no longer reads.
		const startPi = createSupervisorStartPi({
			piInstall: { node: process.execPath, entry: childPath },
			stateDir,
			idleTimeoutMs: 600_000,
			timeoutMs: 600_000,
			spawn: (() => ({ pid: 1, unref() {}, on() {} })) as never,
		});
		const started = await startPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "abandoned",
		});
		const request = JSON.parse(await readFile(started.requestPath, "utf8"));
		// The detached path stamps no parent, which is what it is for.
		// The waiting path stamps the session, and that is the case
		// under test, so it is put back here.
		await writeFile(
			started.requestPath,
			JSON.stringify({ ...request, parentPid: noSuchProcess() }),
		);

		const supervisor = spawn(
			process.execPath,
			[supervisorPath, started.requestPath],
			{ cwd: stateDir, detached: false, stdio: "ignore" },
		);

		try {
			const store = new ReviewerArtifactsStore(stateDir);
			const { resultPath } = store.paths("run", "abandoned");
			const result = await appears<{
				state: string;
				exitCode: number;
				warnings?: string[];
			}>(resultPath);

			// Stopped, and stopped for this reason. A child that failed to
			// start leaves a terminal result here too, and reads as
			// "failed": that is what the first run of this test actually
			// caught, and asserting only that something terminal appeared
			// would have called it a pass.
			expect(result.state).toBe("parent-exit");
			expect(result.exitCode).toBe(130);
		} finally {
			supervisor.kill("SIGKILL");
		}
	});
});
