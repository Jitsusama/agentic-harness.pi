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
import {
	createSupervisorRunPi,
	createSupervisorStartPi,
} from "../../../../lib/subagent/runpi/supervisor.js";
import { gone, noSuchProcess } from "../../../support/processes.js";

// Real processes, doubly nested, on a pool that may be saturated.
// Nothing here waits on work: the child sleeps and is meant to be
// stopped, so this is only room for the operating system to schedule.
const APPEARS_WITHIN_MS = 60_000;

const supervisorPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../lib/subagent/runpi/supervisor.mjs",
);

/** Wait for a path to hold parseable JSON, or give up saying so. */
async function appears<T>(
	path: string,
	enough: (value: T) => boolean = () => true,
): Promise<T> {
	const until = Date.now() + APPEARS_WITHIN_MS;
	while (Date.now() < until) {
		try {
			const value = JSON.parse(await readFile(path, "utf8")) as T;
			if (enough(value)) return value;
			await new Promise((resolve) => setTimeout(resolve, 50));
		} catch {
			// Not written, or half-written. Both mean "not yet".
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(`${path} never appeared within ${APPEARS_WITHIN_MS}ms`);
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

		let child: number | undefined;
		try {
			const store = new ReviewerArtifactsStore(stateDir);
			const { resultPath, leasePath } = store.paths("run", "abandoned");
			// Waited for with the pid in it, not merely present. The lease
			// is written once as "starting" before anything is spawned, so
			// a plain read here returns a record with no child in it about
			// as often as not, and the assertion below would then be
			// skipped or thrown over on timing.
			child = (
				await appears<{ childPid?: number }>(
					leasePath,
					(lease) => typeof lease.childPid === "number",
				)
			).childPid;
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

			// And the child is actually gone. Everything above is the
			// supervisor's report of itself, which is a different claim
			// from the one this test is named for: a supervisor that wrote
			// "parent-exit" and left the model running would satisfy every
			// line before this one.
			if (child === undefined) throw new Error("the lease named no child");
			await gone(child, APPEARS_WITHIN_MS);
		} finally {
			supervisor.kill("SIGKILL");
			// The child too, and this is the half that matters: it is
			// detached and in its own process group, so a failed assertion
			// above would otherwise leave an immortal node process behind
			// on the machine, once per failing run.
			if (child !== undefined) {
				try {
					process.kill(-child, "SIGKILL");
				} catch {
					// Already gone, which is what the test wanted anyway.
				}
			}
		}
	}, 120_000);

	it("is what the runner every fleet job uses asks for", async () => {
		// The other half, and the half a dead parent cannot show. The
		// case above proves that a supervisor told about a parent stops
		// when that parent goes; this one proves the runner every fleet
		// job uses tells it. Without both, the claim holds only for a
		// request nothing produces.
		const stateDir = await mkdtemp(join(tmpdir(), "pr-parent-stamp-"));
		const runPi = createSupervisorRunPi({
			piInstall: { node: process.execPath, entry: "child.mjs" },
			stateDir,
			// Nothing runs: the request is written before the spawn, which
			// is all this reads.
			spawn: (() => ({ pid: 1, unref() {}, on() {}, once() {} })) as never,
		});

		// Caught rather than voided. Nothing here finishes the run, so
		// this promise never settles happily, and a void would surface
		// whatever it does as an unhandled rejection that the assertion
		// below cannot see and a later test reports instead.
		const running = runPi({
			args: [],
			cwd: stateDir,
			runId: "run",
			reviewerId: "one",
		});
		running.catch(() => {});

		const store = new ReviewerArtifactsStore(stateDir);
		const request = await appears<{ parentPid?: number }>(
			store.paths("run", "one").requestPath,
		);
		expect(request.parentPid).toBe(process.pid);
	});
});
