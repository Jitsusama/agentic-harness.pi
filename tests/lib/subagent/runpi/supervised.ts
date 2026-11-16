/**
 * What the supervisor's tests share: a state directory, the real
 * supervisor wrapped so a run that never happened says so, a supervisor
 * faked at the spawn, and the clocks none of them should reach.
 *
 * These were one supervisor.test.ts until 15 November, split by what
 * its cases test; "this file" in the history below is that one.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ReviewerArtifactsStore,
	type ReviewerRunPaths,
} from "../../../../lib/subagent/artifacts.ts";
import {
	createSupervisorRunPi as createRealSupervisorRunPi,
	type SupervisorRunPiConfig,
	type SupervisorSpawnFn,
} from "../../../../lib/subagent/runpi/supervisor.ts";
import type { RunPiResult } from "../../../../lib/subagent/subagent.ts";
import type { FakeChildControls } from "./fake-child.ts";

// Every test here spawns the real node supervisor, sometimes two
// process levels deep. Under parallel suite load the OS can take tens
// of seconds just to schedule and start those processes, which blows
// the 5s default test timeout and shows up as flaky. The timeout here
// is slack for that scheduling latency, not a real work budget: each
// run pins the supervisor's own idle and wall-clock timeouts far
// lower, so a genuinely wedged run still fails fast. Paired with the
// worker cap in vitest.config.ts, this keeps the file green under a
// saturated fork pool. Set at collection time, since a beforeAll runs
// after the tests are already registered with the default.
//
// This file carried a retry for a while, for a CI-only hang I could
// not reproduce: not on macOS, not with the machine saturated by
// twelve spinners, and not in a two-cpu Linux container running the
// same suite. What closed it was giving up on reproducing the
// environment and removing the dependency instead. The parent used
// to wait for the supervisor's process to exit, so every answer
// depended on the operating system reporting a process, when the
// contract was always a file the supervisor writes before it says
// it is done. It now settles on that. A supervisor that finishes
// and then wedges, which is what CI looked like, no longer costs
// the caller anything, and the test below reproduces that shape
// deliberately.
// The timeout ladder matters more than any rung on it. The
// supervisor gives up first and says which watchdog fired, then the
// parent gives up and reports its post-mortem, and only then does
// vitest give up, which reports nothing but a duration. CI failed
// at 60006ms on a run that had plenty left to say, because the rungs
// were in the other order.
//
// This file was carried on a list of suspect tests for a while, on the
// reasoning that it spawns real processes inside a suite that spawns
// freely and would therefore fail again on a busy enough machine. That
// was true of the version that waited for the operating system to
// report a process exit. It is not true of this one, and the numbers
// are here so the suspicion is not re-derived from the shape of the
// file: measured on a twelve-core machine, the whole file runs in 9.5s
// idle and 9.8s at a load average of 18.9 with sixteen busy loops
// competing for the cores. Twenty-four tests, no failures, against a
// ceiling of 150s. If this file starts failing, something has changed;
// it is not the old flake coming back.
export const TEST_TIMEOUT_MS = 150_000;

/** A fresh state directory for one run's artifacts. */
export async function tempStateDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pr-runpi-supervisor-"));
}

/**
 * What these tests allow a nested spawn, rather than what they
 * expect it to need.
 *
 * These used to pin ten seconds, which was meaningless while the
 * supervisor raised anything shorter than forty-five minutes to its
 * floor, and dangerous the moment that floor became a default: a
 * doubly-nested node spawn on a loaded four-core runner can take
 * longer than ten seconds to get going, and CI failed about one run
 * in three with the supervisor still reporting "running". None of
 * these tests are about how long a run may take, so the number only
 * has to be beyond suspicion.
 *
 * It also has to leave room above it. This plus the parent's grace
 * must stay under the file's test timeout, or vitest kills the run
 * before either watchdog can explain itself, which is how the same
 * fault came back reported as "60006ms" and nothing else.
 *
 * Forty seconds was still not enough. CI then failed at 50015ms,
 * which is this leash plus the parent's grace, on a test whose child
 * prints two lines and exits. A doubly-nested node spawn on a
 * shared runner is simply slower than I keep assuming, so the
 * number is now two minutes: far past anything these tests need,
 * and still under the timeout above it. If a run ever crosses this,
 * the supervisor's own watchdog reports it rather than vitest
 * reporting a duration.
 */
export const GENEROUS_MS = 120_000;

/**
 * The real factory, wrapped so a run that never happened says so.
 *
 * The parent's last-resort deadline answers with a shaped result rather
 * than by throwing, which is right for a fleet caller and wrong for a
 * test: a starved supervisor arrives here looking exactly like a
 * reviewer that ran and reported nothing. Every assertion then fails on
 * the shape and reports the shape, so three separate reproductions of
 * this file's load-dependent failure all said "expected undefined to be
 * 'error'" while the postmortem naming the cause sat unread in the
 * warnings beside it.
 *
 * The postmortem is the whole point of this wrapper. It distinguishes a
 * supervisor starved of CPU, whose last written word is seconds old,
 * from one that wedged early, whose last word is as old as the wait,
 * and that is the question an unreproducible hang turns on.
 */
export function createSupervisorRunPi(
	...args: Parameters<typeof createRealSupervisorRunPi>
): ReturnType<typeof createRealSupervisorRunPi> {
	const runPi = createRealSupervisorRunPi(...args);
	return async (request) => {
		const result = await runPi(request);
		const gaveUp = result.warnings?.some((warning) =>
			warning.includes("never reported within"),
		);
		if (gaveUp) {
			throw new Error(
				[
					"the supervisor never reported, so nothing asserted below " +
						"is about this run",
					...(result.warnings ?? []),
					`stderr: ${result.stderrTail || "(none)"}`,
				].join("\n"),
			);
		}
		return result;
	};
}

/**
 * A supervised run of the child script at `childPath`, on the real
 * supervisor, with clocks no test here should reach.
 */
export function runChild(
	childPath: string,
	stateDir: string,
	more: Partial<SupervisorRunPiConfig> = {},
): ReturnType<typeof createRealSupervisorRunPi> {
	return createSupervisorRunPi({
		piInstall: { node: process.execPath, entry: childPath },
		stateDir,
		idleTimeoutMs: GENEROUS_MS,
		timeoutMs: GENEROUS_MS,
		...more,
	});
}

/** A run whose supervisor is the given fake spawn, never a real one. */
export function runOnFake(
	stateDir: string,
	more: Partial<SupervisorRunPiConfig> & { spawn: SupervisorSpawnFn },
): ReturnType<typeof createRealSupervisorRunPi> {
	return createSupervisorRunPi({
		piInstall: { node: "/pi/bin/node", entry: "/pi/dist/cli.js" },
		nodeBinary: "node",
		supervisorPath: "/pkg/reviewer-supervisor.mjs",
		stateDir,
		...more,
	});
}

/** What a fake supervisor reads off the request it is handed. */
export interface FakeRequest {
	readonly paths: ReviewerRunPaths;
	readonly timeoutMs?: number;
	readonly idleTimeoutMs?: number;
	readonly softDeadlineMs?: number;
}

/**
 * A supervisor that answers at once: it reads its request, writes the
 * result `answer` gives for it, says each of `say` and then terminal,
 * and exits. One that wedges says terminal and then nothing at all: no
 * end on stdout and no close.
 */
export function fakeSupervisor(
	stateDir: string,
	fake: FakeChildControls,
	answer: (request: FakeRequest) => Record<string, unknown>,
	shape: { say?: Record<string, unknown>[]; wedge?: boolean } = {},
): SupervisorSpawnFn {
	return (_command, args) => {
		queueMicrotask(async () => {
			const request: FakeRequest = JSON.parse(
				await readFile(String(args[1]), "utf-8"),
			);
			await new ReviewerArtifactsStore(stateDir).writeJsonAtomic(
				request.paths.resultPath,
				answer(request),
			);
			for (const line of shape.say ?? []) {
				fake.stdout.write(`${JSON.stringify(line)}\n`);
			}
			const terminal = `${JSON.stringify({
				type: "terminal",
				resultPath: request.paths.resultPath,
			})}\n`;
			if (shape.wedge) {
				fake.stdout.write(terminal);
				return;
			}
			fake.stdout.end(terminal);
			fake.emitClose(0);
		});
		return fake.process();
	};
}

/** A clean result, as a fake supervisor writes one. */
export const ANSWERED = {
	exitCode: 0,
	finalAssistantText: "done",
	warnings: [],
	stderrTail: "",
};

/** The artifacts a result names, which are the request's own paths. */
export function artifactsOf(request: FakeRequest): Record<string, string> {
	const { paths } = request;
	return {
		runDir: paths.runDir,
		reviewerDir: paths.reviewerDir,
		eventsPath: paths.eventsPath,
		stderrPath: paths.stderrPath,
		progressPath: paths.progressPath,
		resultPath: paths.resultPath,
	};
}

/**
 * Assert a run succeeded, and say what it reported when it did not.
 *
 * `expect(result.exitCode).toBe(0)` prints "expected 1 to be +0"
 * and throws away the warnings, which is where the supervisor
 * explains itself. On a machine I can rerun that is merely
 * annoying; on CI, where these tests fail and here they do not, it
 * is the whole difference between evidence and another rerun.
 */
export function expectRan(result: RunPiResult): void {
	if (result.exitCode !== 0) {
		throw new Error(
			`run failed with exit ${result.exitCode}\n` +
				`warnings: ${JSON.stringify(result.warnings, null, 1)}\n` +
				`stderr: ${result.stderrTail ?? "(none)"}\n` +
				`text: ${result.finalAssistantText || "(none)"}`,
		);
	}
}
