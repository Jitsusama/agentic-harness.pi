/**
 * A long command moves to the background rather than holding the session,
 * and a short one is left exactly as it was.
 */

import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	createEventBus,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	FINISHED_LINES,
	labelOf,
	runOrHandOff,
	spoken,
} from "../../../extensions/shell-workflow/hand-off.ts";
import {
	announceJobHost,
	type JobOutcome,
	type JobSpec,
	jobStopReason,
} from "../../../lib/jobs/index.ts";

async function until(condition: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

/** A job host that records what it was asked to hold. */
function recordingHost() {
	const bus = createEventBus();
	const specs: JobSpec[] = [];
	const outcomes: JobOutcome[] = [];
	const controllers: AbortController[] = [];
	disposers.push(
		announceJobHost(bus, {
			start(spec) {
				const controller = new AbortController();
				controllers.push(controller);
				specs.push(spec);
				return {
					id: `j${specs.length}`,
					signal: controller.signal,
					finish: (outcome) => outcomes.push(outcome),
					onDelivered: () => {},
					withdraw: () => false,
				};
			},
		}),
	);
	return { bus, specs, outcomes, controllers };
}

const said = (text: string, exit = 0): AgentToolResult<undefined> => ({
	content: [{ type: "text", text }],
	details: undefined,
	structuredContent: {
		output: text,
		truncated: false,
		exit_code: exit,
		wall_time_seconds: 1,
	},
	...(exit !== 0 ? { isError: true } : {}),
});

/** A command that runs until it is told to end or is stopped. */
function controllable() {
	let end: (result: AgentToolResult<undefined>) => void = () => {};
	let fail: (error: Error) => void = () => {};
	let seen: AbortSignal | undefined;
	let update: AgentToolUpdateCallback<undefined> = () => {};
	const run = (
		signal: AbortSignal,
		onUpdate: AgentToolUpdateCallback<undefined>,
	) => {
		seen = signal;
		update = onUpdate;
		return new Promise<AgentToolResult<undefined>>((resolve, reject) => {
			end = resolve;
			fail = reject;
			signal.addEventListener("abort", () =>
				reject(new Error("partial\n\nCommand aborted")),
			);
		});
	};
	return {
		run,
		end: (result: AgentToolResult<undefined>) => end(result),
		fail: (error: Error) => fail(error),
		print: (text: string) =>
			update({ content: [{ type: "text", text }], details: undefined }),
		signal: () => seen,
	};
}

describe("a command that ends in time", () => {
	it("answers with its own result and starts no job", async () => {
		const { bus, specs } = recordingHost();
		const result = await runOrHandOff({
			command: "echo hi",
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: async () => said("hi"),
			afterMs: 1000,
		});

		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
		expect(specs).toEqual([]);
	});

	it("still shows its output as it comes", async () => {
		const { bus } = recordingHost();
		const command = controllable();
		const shown: string[] = [];
		const running = runOrHandOff({
			command: "make",
			nested: false,
			signal: undefined,
			onUpdate: (partial) => {
				const first = partial.content[0];
				if (first?.type === "text") shown.push(first.text);
			},
			bus,
			run: command.run,
			afterMs: 1000,
		});
		command.print("compiling");
		command.end(said("done"));
		await running;

		expect(shown).toEqual(["compiling"]);
	});

	it("is killed by Escape as it always was", async () => {
		const { bus } = recordingHost();
		const command = controllable();
		const escapeKey = new AbortController();
		const running = runOrHandOff({
			command: "make",
			nested: false,
			signal: escapeKey.signal,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 1000,
		});
		escapeKey.abort();

		await expect(running).rejects.toThrow("Command aborted");
	});
});

describe("a command still running when the time comes", () => {
	it("moves to a job and says so, with where it was", async () => {
		const { bus, specs } = recordingHost();
		const command = controllable();
		const running = runOrHandOff({
			command: "pnpm test",
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 20,
		});
		command.print("ran 40 of 300");
		const result = await running;
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(specs).toEqual([{ kind: "shell", label: "pnpm test" }]);
		expect(text).toContain("in the background as job j1");
		expect(text).toContain("do not run it again");
		expect(text).toContain("ran 40 of 300");
		// The way to stop it that takes its children with it, not a kill.
		expect(text).toContain("jobs tool's stop with j1");
		expect(text).toContain("never kill its shell by hand");
	});

	it("says how it ended once it has", async () => {
		const { bus, outcomes } = recordingHost();
		const command = controllable();
		await runOrHandOff({
			command: "pnpm test",
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 10,
		});
		command.end(said("2 failed", 1));
		await until(() => outcomes.length > 0);

		expect(outcomes[0]?.failed).toBe(true);
		expect(outcomes[0]?.summary).toMatch(/^`pnpm test` exited 1 after /);
		expect(outcomes[0]?.summary).toContain("2 failed");
	});

	it("outlives the call's Escape, but not the job's stop", async () => {
		const { bus, outcomes, controllers } = recordingHost();
		const command = controllable();
		const escapeKey = new AbortController();
		await runOrHandOff({
			command: "pnpm build",
			nested: false,
			signal: escapeKey.signal,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 10,
		});

		escapeKey.abort();
		expect(command.signal()?.aborted).toBe(false);

		controllers[0]?.abort(jobStopReason("person"));
		expect(command.signal()?.aborted).toBe(true);
		await until(() => outcomes.length > 0);
		expect(outcomes[0]?.summary).toContain("stopped after");
	});

	it("keeps long output where the model can read it", async () => {
		const { bus, outcomes } = recordingHost();
		const command = controllable();
		const kept: string[] = [];
		await runOrHandOff({
			command: "build",
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 10,
			keep: (name, text) => {
				kept.push(text);
				return `/tmp/${name}.log`;
			},
		});
		const lines = Array.from(
			{ length: FINISHED_LINES + 10 },
			(_, i) => `line ${i}`,
		);
		command.end(said(lines.join("\n")));
		await until(() => outcomes.length > 0);

		expect(kept).toHaveLength(1);
		expect(outcomes[0]?.summary).toContain("Full output: /tmp/");
		expect(outcomes[0]?.summary).not.toContain("line 0\n");
	});

	it("leaves pi's own saved output to pi", async () => {
		const { bus, outcomes } = recordingHost();
		const command = controllable();
		const kept: string[] = [];
		await runOrHandOff({
			command: "build",
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 10,
			keep: (_name, text) => {
				kept.push(text);
				return "";
			},
		});
		const lines = Array.from(
			{ length: FINISHED_LINES + 10 },
			(_, i) => `line ${i}`,
		);
		lines.push("[Showing lines 1-50 of 9000. Full output: /tmp/pi-bash-1.log]");
		command.end(said(lines.join("\n")));
		await until(() => outcomes.length > 0);

		expect(kept).toEqual([]);
		expect(outcomes[0]?.summary).toContain("/tmp/pi-bash-1.log");
	});

	it("says why nothing showed when the output is piped through tail", async () => {
		const { bus } = recordingHost();
		const command = controllable();
		const result = await runOrHandOff({
			command: "pnpm test 2>&1 | tail -5",
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 10,
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("pipes through tail or head");
	});
});

describe("a command's job", () => {
	it("names the call it carries on for", async () => {
		const { bus, specs } = recordingHost();
		await runOrHandOff({
			command: "nix build",
			toolCallId: "call-3",
			background: true,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: controllable().run,
		});

		expect(specs[0]?.toolCallId).toBe("call-3");
	});
});

describe("what decides whether a command moves", () => {
	it("moves at once when asked to run in the background", async () => {
		const { bus, specs } = recordingHost();
		const command = controllable();
		await runOrHandOff({
			command: "dev up",
			background: true,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
		});

		expect(specs).toHaveLength(1);
	});

	it("never moves when asked to wait", async () => {
		const { bus, specs } = recordingHost();
		const command = controllable();
		const running = runOrHandOff({
			command: "dev up",
			background: false,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 0,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		command.end(said("up"));

		expect((await running).content[0]).toEqual({ type: "text", text: "up" });
		expect(specs).toEqual([]);
	});

	it("never moves a call a codemode script made", async () => {
		const { bus, specs } = recordingHost();
		const command = controllable();
		const running = runOrHandOff({
			command: "ls",
			background: true,
			nested: true,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		command.end(said("a b"));

		await running;
		expect(specs).toEqual([]);
	});

	it("never moves when nothing could hold it", async () => {
		const command = controllable();
		const running = runOrHandOff({
			command: "ls",
			background: true,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus: createEventBus(),
			run: command.run,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		command.end(said("a b"));

		expect((await running).content[0]).toEqual({ type: "text", text: "a b" });
	});
});

describe("how a command and a span are named", () => {
	it("names a command by its first line", () => {
		expect(labelOf("cd x &&\n  make all")).toBe("cd x && ...");
		expect(labelOf("a".repeat(80))).toBe(`${"a".repeat(57)}...`);
	});

	it("says a span the way a person would", () => {
		expect(spoken(1000)).toBe("1 second");
		expect(spoken(5 * 60 * 1000)).toBe("5 minutes");
		expect(spoken(125_000)).toBe("2 minutes 5s");
	});
});
