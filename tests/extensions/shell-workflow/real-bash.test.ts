/**
 * The same, through pi's own bash: the agent's commands get no editor or
 * pager, and a handed-off command really keeps running until its job is
 * stopped, a reload included.
 */

import { execFileSync } from "node:child_process";
import {
	createBashToolDefinition,
	createEventBus,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { withoutInteraction } from "../../../extensions/shell-workflow/environment.ts";
import { runOrHandOff } from "../../../extensions/shell-workflow/hand-off.ts";
import {
	announceJobHost,
	type JobOutcome,
	jobStopReason,
} from "../../../lib/jobs/index.ts";
import {
	forgetParkedJobs,
	jobRuntime,
	reloadJobs,
} from "../../support/job-runtime.ts";
import { until } from "../../support/until.ts";

/** The conversation calling: one per test process, as each pi has its own. */
const SESSION = `test-${process.pid}`;

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	forgetParkedJobs();
});

const bash = createBashToolDefinition(process.cwd(), {
	spawnHook: withoutInteraction,
	exposeSessionEnvironment: false,
});

const textOf = (result: { content: { type: string; text?: string }[] }) =>
	result.content[0]?.text ?? "";

/** Whether a process with this marker in its command line is running. */
function running(marker: string): boolean {
	try {
		return (
			execFileSync("pgrep", ["-f", marker], { encoding: "utf-8" }).trim() !== ""
		);
	} catch {
		// pgrep exits 1 when nothing matches.
		return false;
	}
}

describe("the agent's shell", () => {
	it("has no editor or pager to wait on", async () => {
		const result = await bash.execute(
			"t1",
			{
				command:
					'printf "%s %s %s" "$GIT_EDITOR" "$GIT_SEQUENCE_EDITOR" "$GIT_PAGER"',
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(textOf(result)).toBe("true true cat");
	});

	it("still lets a command set its own", async () => {
		const result = await bash.execute(
			"t2",
			{ command: 'GIT_EDITOR=vi sh -c \'printf "%s" "$GIT_EDITOR"\'' },
			undefined,
			undefined,
			undefined as never,
		);

		expect(textOf(result)).toBe("vi");
	});
});

describe("a real command handed off", () => {
	it("keeps running after the call returns, until its job is stopped", async () => {
		const bus = createEventBus();
		const outcomes: JobOutcome[] = [];
		const controller = new AbortController();
		disposers.push(
			announceJobHost(bus, {
				start: () => ({
					id: "j1",
					signal: controller.signal,
					finish: (outcome) => outcomes.push(outcome),
					onDelivered: () => {},
					withdraw: () => false,
				}),
			}),
		);
		// A duration nothing else would sleep for marks the process.
		const marker = `sleep 30.${process.pid}${Date.now() % 1000}`;
		const command = `echo started; ${marker}`;

		const result = await runOrHandOff({
			command,
			session: SESSION,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			afterMs: 300,
			run: (signal, onUpdate) =>
				bash.execute("t3", { command }, signal, onUpdate, undefined as never),
		});

		expect(textOf(result)).toContain("background command j1");
		expect(running(marker), `${marker} runs on in the background`).toBe(true);

		controller.abort(jobStopReason("person"));
		await until("the stopped job to end", () => outcomes.length > 0);
		await until("the stopped command to be gone", () => !running(marker));
		expect(outcomes[0]).toMatchObject({ failed: true });
	});

	it("takes its grandchildren with it when the agent stops its job", async () => {
		// A nix build is a grandchild of the shell: under a pipe, a subshell
		// or a script. Killing the shell and its direct children by hand left
		// one running on 23 October. Stopping the job kills the whole group.
		const events = createEventBus();
		const runtime = jobRuntime(events);
		await runtime.fire("session_start", { reason: "startup" });
		const stamp = `${process.pid}${Date.now() % 1000}`;
		const piped = `sleep 31.${stamp}`;
		const nested = `sleep 32.${stamp}`;
		const command = `echo started; ( ${piped} | cat ) & sh -c '${nested}' & wait`;
		disposers.push(() => {
			try {
				execFileSync("pkill", ["-f", `\\.${stamp}`]);
			} catch {
				// Nothing was left to kill, which is the point.
			}
		});

		const result = await runOrHandOff({
			command,
			session: SESSION,
			background: true,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus: events,
			run: (signal, onUpdate) =>
				bash.execute("t5", { command }, signal, onUpdate, undefined as never),
		});
		expect(textOf(result)).toContain("background command j1");
		await until(
			"both grandchildren to be running",
			() => running(piped) && running(nested),
		);

		const stopped = await runtime.tool("jobs", { action: "stop", id: "j1" });

		expect(stopped).toContain("Stopped j1");
		await until(
			"both grandchildren to be gone",
			() => !running(piped) && !running(nested),
		);
		await runtime.fire("session_shutdown", { reason: "quit" });
	});

	it("outlives a reload, and the runtime the reload started says how it ended", async () => {
		const events = createEventBus();
		const first = jobRuntime(events);
		await first.fire("session_start", { reason: "startup" });
		// Long enough to outlast a reload on a loaded machine, and checked
		// for once it has started: a check made at once raced the spawn, and
		// a two-second sleep could end before a slow reload did.
		const marker = `sleep 4.${process.pid}${Date.now() % 1000}`;
		const command = `echo started; ${marker}; echo finished`;

		const result = await runOrHandOff({
			command,
			session: SESSION,
			background: true,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus: events,
			run: (signal, onUpdate) =>
				bash.execute("t4", { command }, signal, onUpdate, undefined as never),
		});
		expect(textOf(result)).toContain("as background command j1");
		await until("the background command to be running", () => running(marker));

		const next = await reloadJobs(events, first);
		expect(running(marker), `${marker} runs on through the reload`).toBe(true);
		await until(
			"the reloaded runtime to say how the job ended",
			() => next.said.length > 0,
			15_000,
		);
		expect(next.said[0]).toContain("[j1]");
		expect(next.said[0]).toContain("exited 0");
		expect(next.said[0]).toContain("finished");
		expect(first.said).toEqual([]);
	}, 25_000);
});
