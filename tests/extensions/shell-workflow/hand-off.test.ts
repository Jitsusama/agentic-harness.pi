/**
 * A long command moves to the background rather than holding the session,
 * and a short one is left exactly as it was.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	createEventBus,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	labelOf,
	runOrHandOff,
} from "../../../extensions/shell-workflow/hand-off.ts";
import { sessionEnv } from "../../../lib/core/session/index.ts";
import {
	FINISHED_LINES,
	HAND_OFF_MS,
	spoken,
} from "../../../lib/jobs/hand-off.ts";
import {
	announceJobHost,
	type JobOutcome,
	type JobSpec,
	jobStopReason,
} from "../../../lib/jobs/index.ts";
import { installTestHost } from "../../support/session-host.ts";
import { until } from "../../support/until.ts";

/** The conversation calling: one per test process, as each pi has its own. */
const SESSION = `test-${process.pid}`;

/**
 * How long a handed-off job gets to end. Short of the test's own
 * timeout, so a job that never ends fails naming what was waited on.
 */
const ENDS_WITHIN_MS = 2_000;

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
			session: SESSION,
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
			session: SESSION,
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
			session: SESSION,
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
			session: SESSION,
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
		expect(text).toContain("as background command j1");
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
			session: SESSION,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 10,
		});
		command.end(said("2 failed", 1));
		await until(
			"the job to say how it ended",
			() => outcomes.length > 0,
			ENDS_WITHIN_MS,
		);

		expect(outcomes[0]).toMatchObject({ failed: true });
		expect(outcomes[0]?.summary).toMatch(/^`pnpm test` exited 1 after /);
		expect(outcomes[0]?.summary).toContain("2 failed");
	});

	it("outlives the call's Escape, but not the job's stop", async () => {
		const { bus, outcomes, controllers } = recordingHost();
		const command = controllable();
		const escapeKey = new AbortController();
		await runOrHandOff({
			command: "pnpm build",
			session: SESSION,
			nested: false,
			signal: escapeKey.signal,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 10,
		});

		escapeKey.abort();
		expect(
			command.signal()?.aborted,
			"the call's Escape leaves the command running",
		).toBe(false);

		controllers[0]?.abort(jobStopReason("person"));
		expect(command.signal()?.aborted, "the job's stop stops the command").toBe(
			true,
		);
		await until(
			"the stopped job to end",
			() => outcomes.length > 0,
			ENDS_WITHIN_MS,
		);
		expect(outcomes[0]?.summary).toContain("stopped after");
	});

	it("keeps long output where the model can read it", async () => {
		const { bus, outcomes } = recordingHost();
		const command = controllable();
		const kept: string[] = [];
		await runOrHandOff({
			command: "build",
			session: SESSION,
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
		await until(
			"the job with long output to end",
			() => outcomes.length > 0,
			ENDS_WITHIN_MS,
		);

		expect(kept).toHaveLength(1);
		expect(outcomes[0]?.summary).toContain("Full output: /tmp/");
		expect(outcomes[0]?.summary).not.toContain("line 0\n");
	});

	it("keeps long output in its conversation's TMPDIR on a host, named for the conversation", async () => {
		const installed = installTestHost();
		const temp = mkdtempSync(join(tmpdir(), "conversation-output-"));
		disposers.push(() => rmSync(temp, { recursive: true, force: true }));
		disposers.push(installed.dispose);
		sessionEnv("a").set("TMPDIR", temp);
		sessionEnv("b").set("TMPDIR", join(temp, "b"));
		const { bus, outcomes } = recordingHost();
		const command = controllable();
		await runOrHandOff({
			command: "build",
			session: "a",
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 10,
		});
		const lines = Array.from(
			{ length: FINISHED_LINES + 10 },
			(_, i) => `line ${i}`,
		);
		command.end(said(lines.join("\n")));
		await until(
			"the conversation's job with long output to end",
			() => outcomes.length > 0,
			ENDS_WITHIN_MS,
		);

		const kept = /Full output: (\S+\.log)/.exec(
			outcomes[0]?.summary ?? "",
		)?.[1];
		expect(dirname(kept ?? ""), "in A's TMPDIR, not the host's").toBe(temp);
		expect(kept, "named for A").toMatch(/pi-bash-a-\d+-j1\.log$/);
		expect(readFileSync(kept ?? "", "utf8")).toContain(
			`line ${FINISHED_LINES + 9}`,
		);
	});

	it("leaves pi's own saved output to pi", async () => {
		const { bus, outcomes } = recordingHost();
		const command = controllable();
		const kept: string[] = [];
		await runOrHandOff({
			command: "build",
			session: SESSION,
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
		await until(
			"the job with pi's saved output to end",
			() => outcomes.length > 0,
			ENDS_WITHIN_MS,
		);

		expect(kept).toEqual([]);
		expect(outcomes[0]?.summary).toContain("/tmp/pi-bash-1.log");
	});

	it("says why nothing showed when the output is piped through tail", async () => {
		const { bus } = recordingHost();
		const command = controllable();
		const result = await runOrHandOff({
			command: "pnpm test 2>&1 | tail -5",
			session: SESSION,
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

describe("a moved command's printing of the environment", () => {
	/** Made as the test runs, so the repository holds no credential's shape. */
	const fresh = () => `z9${randomBytes(19).toString("hex")}`;

	/**
	 * Too short to read as a dump by its lines, so only the command says it
	 * is one: FOO_SECRET's name gives it away, PROXY_ACCESS's doesn't.
	 */
	function dump() {
		const secret = fresh();
		const access = fresh();
		return {
			text: [
				"HOME=/home/someone",
				`FOO_SECRET=${secret}`,
				`PROXY_ACCESS=${access}`,
			].join("\n"),
			values: [secret, access],
		};
	}

	/** A file named as pi names a command's saved output, removed after. */
	function savedOutput(text: string): string {
		const file = join(
			tmpdir(),
			`pi-bash-${randomBytes(8).toString("hex")}.log`,
		);
		writeFileSync(file, text, { mode: 0o600 });
		disposers.push(() => rmSync(file, { force: true }));
		return file;
	}

	function expectScrubbed(said: string, values: readonly string[]) {
		for (const value of values) {
			expect(said.includes(value), "no value of the dump is said").toBe(
				false,
			);
		}
		expect(said).toContain("PROXY_ACCESS=[secret scrubbed: PROXY_ACCESS]");
	}

	async function moved(
		command: string,
		step: { background?: boolean; session?: string } = {},
	) {
		const host = recordingHost();
		const running = controllable();
		await runOrHandOff({
			command,
			session: step.session ?? SESSION,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus: host.bus,
			run: running.run,
			...(step.background ? { background: true } : { afterMs: 10 }),
		});
		const ended = async () => {
			await until(
				`${command} to end`,
				() => host.outcomes.length > 0,
				ENDS_WITHIN_MS,
			);
			return host.outcomes[0];
		};
		return { running, ended };
	}

	it("is scrubbed when it moved after the minute: sleep 61; printenv", async () => {
		const { text, values } = dump();
		const { running, ended } = await moved("sleep 61; printenv");
		running.end(said(text));
		expectScrubbed((await ended())?.summary ?? "", values);
	});

	for (const hosted of [false, true]) {
		it(`is scrubbed when run in the background ${hosted ? "on a host" : "in plain pi"}, the whole output it keeps too: printenv`, async () => {
			const temp = mkdtempSync(join(tmpdir(), "moved-dump-"));
			disposers.push(() => rmSync(temp, { recursive: true, force: true }));
			if (hosted) {
				const installed = installTestHost();
				disposers.push(installed.dispose);
				sessionEnv("a").set("TMPDIR", temp);
			}
			const { text, values } = dump();
			const filler = Array.from(
				{ length: FINISHED_LINES + 10 },
				(_, i) => `line ${i}`,
			);
			const { running, ended } = await moved("printenv", {
				background: true,
				session: hosted ? "a" : SESSION,
			});
			running.end(said([text, ...filler].join("\n")));
			const summary = (await ended())?.summary ?? "";
			const kept = /Full output: (\S+\.log)/.exec(summary)?.[1] ?? "";
			if (!hosted) disposers.push(() => rmSync(kept, { force: true }));
			if (hosted) {
				expect(dirname(kept), "kept in the conversation's TMPDIR").toBe(
					temp,
				);
			}
			const whole = readFileSync(kept, "utf8");
			for (const value of values) {
				expect(whole.includes(value), "no value is kept").toBe(false);
			}
			expect(whole).toContain("PROXY_ACCESS=[secret scrubbed: PROXY_ACCESS]");
		});
	}

	it("withholds its output when the scrub cannot read the answer", async () => {
		const { text, values } = dump();
		const { running, ended } = await moved("printenv", { background: true });
		const structuredContent: JsonObject = { output: text, exit_code: 0 };
		structuredContent.self = structuredContent;
		running.end({ ...said(text), structuredContent });
		const outcome = await ended();
		// How it ended holds nothing to hide, so a command that worked says so.
		expect(outcome?.failed, "it exited 0").not.toBe(true);
		expect(outcome?.summary).toContain("exited 0");
		for (const value of values) {
			expect(
				outcome?.summary.includes(value),
				"no value is said raw",
			).toBe(false);
		}
		expect(outcome?.summary).toContain("withheld");
		expect(outcome?.summary, "the failure's kind").toContain("(RangeError)");
	});

	it("is scrubbed when it exits non-zero: printenv; exit 1", async () => {
		const { text, values } = dump();
		const { running, ended } = await moved("printenv; exit 1", {
			background: true,
		});
		running.end(said(text, 1));
		const outcome = await ended();
		expect(outcome).toMatchObject({ failed: true });
		expectScrubbed(outcome?.summary ?? "", values);
	});

	it("is scrubbed when it throws, the saved output its words name too", async () => {
		const { text, values } = dump();
		const file = savedOutput(text);
		const { running, ended } = await moved("printenv; exit 1", {
			background: true,
		});
		running.fail(
			new Error(
				`${text}\n\n[Showing lines 1-3 of 3. Full output: ${file}]\n\nCommand timed out after 5 seconds`,
			),
		);
		expectScrubbed((await ended())?.summary ?? "", values);
		expectScrubbed(readFileSync(file, "utf8"), values);
	});

	it("is not read into a command that prints no environment", async () => {
		const commit = "commit 3f9c2a7be41d08e5c6a1f2b3d4e5f60718293a4b";
		const { running, ended } = await moved("make", { background: true });
		running.end(said(commit));
		expect((await ended())?.summary).toContain(commit);
	});

	it("has the output pi saved scrubbed, as named in its answer", async () => {
		const { text, values } = dump();
		const file = savedOutput(text);
		const { running, ended } = await moved("printenv", { background: true });
		running.end({
			...said("done"),
			structuredContent: { output: "done", fullOutputPath: file },
		});
		await ended();
		expectScrubbed(readFileSync(file, "utf8"), values);
	});

	it("keeps a long one's whole output scrubbed", async () => {
		const { text, values } = dump();
		const kept: string[] = [];
		const host = recordingHost();
		const running = controllable();
		await runOrHandOff({
			command: "printenv",
			session: SESSION,
			background: true,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus: host.bus,
			run: running.run,
			keep: (_name, whole) => {
				kept.push(whole);
				return "/tmp/kept.log";
			},
		});
		const filler = Array.from(
			{ length: FINISHED_LINES + 10 },
			(_, i) => `line ${i}`,
		);
		running.end(said([text, ...filler].join("\n")));
		await until(
			"the long dump to end",
			() => host.outcomes.length > 0,
			ENDS_WITHIN_MS,
		);
		expect(kept).toHaveLength(1);
		expectScrubbed(kept[0] ?? "", values);
	});
});

describe("a command's job", () => {
	it("names the call it carries on for", async () => {
		const { bus, specs } = recordingHost();
		await runOrHandOff({
			command: "nix build",
			session: SESSION,
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

	for (const [command, dumps] of [
		["cd /srv/app\nprintenv", true],
		["cd /srv/app\nmake", false],
	] as const) {
		it(`carries whether its command prints the environment: ${dumps}`, async () => {
			const { bus, specs } = recordingHost();
			await runOrHandOff({
				command,
				session: SESSION,
				background: true,
				nested: false,
				signal: undefined,
				onUpdate: undefined,
				bus,
				run: controllable().run,
				carryOf: () => ({ what: () => ({ kind: "shell" }), handed() {} }),
			});
			// Its label is its first line alone, which says nothing of it.
			expect(specs[0]?.carry?.what()?.dumps === true, command).toBe(dumps);
		});
	}
});

describe("what decides whether a command moves", () => {
	it("moves at once when asked to run in the background", async () => {
		const { bus, specs } = recordingHost();
		const command = controllable();
		await runOrHandOff({
			command: "dev up",
			session: SESSION,
			background: true,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
		});

		expect(specs).toHaveLength(1);
	});

	it("moves after a while even when asked to wait, so the session can still be reached", async () => {
		const { bus, specs } = recordingHost();
		const command = controllable();
		const running = runOrHandOff({
			command: "dev up",
			session: SESSION,
			background: false,
			nested: false,
			signal: undefined,
			onUpdate: undefined,
			bus,
			run: command.run,
			afterMs: 0,
		});

		const result = await running;
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("as background command j1");
		expect(specs).toHaveLength(1);
		command.end(said("up"));
	});

	it("waits no longer than a minute", () => {
		expect(HAND_OFF_MS).toBeLessThanOrEqual(60_000);
	});

	it("never moves a call a codemode script made", async () => {
		const { bus, specs } = recordingHost();
		const command = controllable();
		const running = runOrHandOff({
			command: "ls",
			session: SESSION,
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
			session: SESSION,
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
