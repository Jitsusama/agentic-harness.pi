/** Telling whether pi already runs inside a Mac's sandbox. */
import { describe, expect, it } from "vitest";
import {
	insideMacSandbox,
	keeping,
	macSandbox,
	RETRY_MS,
	type Trial,
	trialOf,
} from "../../../../lib/internal/sandbox/mac-sandbox.ts";

const answer = (trial: Partial<Trial>): Trial => ({
	status: 0,
	stderr: "",
	failed: false,
	...trial,
});
const ran = (trial: Partial<Trial>) => () => answer(trial);
const errno = (code: string) =>
	Object.assign(new Error(`spawnSync sandbox-exec ${code}`), { code });

const NESTED = "sandbox-exec: sandbox_apply: Operation not permitted\n";

describe("whether pi runs inside a Mac's sandbox", () => {
	it("reads a trial profile sandbox-exec ran but couldn't apply as a sandbox around pi", () => {
		expect(
			insideMacSandbox(ran({ status: 71, stderr: NESTED })),
			"a nested refusal says pi runs inside a sandbox",
		).toBe(true);
	});

	it("reads a trial that applied as no sandbox around pi", () => {
		expect(
			insideMacSandbox(ran({ status: 0 })),
			"a trial that applied says no sandbox is around pi",
		).toBe(false);
	});

	it("reads sandbox-exec refused before it runs as no sandbox, since a tool vetting programs refuses it alike", () => {
		expect(
			insideMacSandbox(ran({ status: null, failed: true, stderr: NESTED })),
			"a refused exec read as a sandbox by its wording alone",
		).toBe(false);
	});

	it("reads a refusal that isn't macOS's refusal of a second profile as no sandbox", () => {
		expect(
			insideMacSandbox(
				ran({
					status: 71,
					stderr:
						"sandbox-exec: execvp() of '/usr/bin/true' failed: Operation not permitted\n",
				}),
			),
			"a refusal of the command itself says no sandbox is around pi",
		).toBe(false);
	});

	it("counts what it can't tell as no sandbox, so a fenced command is refused", () => {
		expect(
			insideMacSandbox(ran({ status: null, failed: true, passing: true })),
			"a trial that timed out",
		).toBe(false);
		expect(
			insideMacSandbox(ran({ status: 1, stderr: "something else broke" })),
			"another failure",
		).toBe(false);
	});

	it("tells a trial that timed out apart from no sandbox, so nothing acts on it for good", () => {
		expect(macSandbox(ran({ status: null, failed: true, passing: true }))).toBe(
			"unknown",
		);
		expect(macSandbox(ran({ status: 0 }))).toBe("outside");
		expect(macSandbox(ran({ status: 71, stderr: NESTED }))).toBe("inside");
	});

	it("reads a timeout, a kill or a busy machine's spawn error as passing", () => {
		for (const code of ["ETIMEDOUT", "EAGAIN", "ENOMEM", "EMFILE"]) {
			const trial = trialOf({
				status: null,
				signal: code === "ETIMEDOUT" ? "SIGTERM" : null,
				error: errno(code),
			});
			expect(trial.passing, code).toBe(true);
			expect(
				macSandbox(() => trial),
				code,
			).toBe("unknown");
		}
		expect(
			trialOf({ status: null, signal: "SIGKILL" }).passing,
			"killed with no error",
		).toBe(true);
		expect(
			trialOf({ status: 71, signal: null, stderr: NESTED }).passing,
			"a run that finished",
		).toBe(false);
	});

	it("reads sandbox-exec missing or refused before it runs as no sandbox, for good", () => {
		for (const code of ["ENOENT", "EACCES", "EPERM"]) {
			const trial = trialOf({ status: null, signal: null, error: errno(code) });
			expect(trial, code).toMatchObject({ failed: true, passing: false });
			expect(
				macSandbox(() => trial),
				code,
			).toBe("outside");
		}
	});
});

describe("keeping the trial's answer", () => {
	const counted = (...answers: Trial[]) => {
		let runs = 0;
		const run = () => {
			const next = answers[Math.min(runs, answers.length - 1)];
			runs += 1;
			return next ?? answer({});
		};
		return { run, runs: () => runs };
	};

	it("runs a trial that finished once for the process", () => {
		const trial = counted(answer({ status: 71, stderr: NESTED }));
		const kept = keeping(trial.run);
		kept();
		kept();
		expect(trial.runs(), "the trial ran again").toBe(1);
		expect(
			insideMacSandbox(kept),
			"the kept trial still says pi runs inside a sandbox",
		).toBe(true);
	});

	it("tries again after a trial that ran out of time", () => {
		const trial = counted(
			answer({ status: null, failed: true, passing: true }),
			answer({ status: 71, stderr: NESTED }),
		);
		let clock = 0;
		const kept = keeping(trial.run, () => clock);
		expect(insideMacSandbox(kept), "a timeout read as a sandbox").toBe(false);
		clock = RETRY_MS - 1;
		expect(macSandbox(kept), "tried again within the wait").toBe("unknown");
		expect(trial.runs(), "a busy Mac ran a trial for every draw").toBe(1);
		clock = RETRY_MS;
		expect(insideMacSandbox(kept), "the timeout was kept").toBe(true);
		expect(trial.runs()).toBe(2);
	});
});
