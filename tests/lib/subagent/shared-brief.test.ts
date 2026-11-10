/**
 * Reviewers sent one brief open their requests with the same bytes.
 *
 * pi puts an `@file` argument's path at the very head of the first
 * message. Named at random, every reviewer of a round had a different
 * first line, so nothing after it could be read from the cache another
 * reviewer wrote: measured, each of four reviewers read 1,280 tokens
 * on its first call and wrote the rest of a 206,000 token brief.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.ts";
import type { StartedPi } from "../../../lib/subagent/runpi/supervisor.ts";
import {
	type RunPi,
	runReviewer,
	startReviewer,
} from "../../../lib/subagent/subagent.ts";

const ANSWER = JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text: "{}" }] },
});

/** A runner that records each run's args and answers at once. */
function recording() {
	const calls: string[][] = [];
	const runPi: RunPi = async (opts) => {
		calls.push(opts.args);
		return { stdout: ANSWER, stderr: "", exitCode: 0 };
	};
	return { calls, runPi };
}

const brief = (args: readonly string[]) =>
	args.find((arg) => arg.startsWith("@"));

describe("a brief several reviewers share", () => {
	it("is handed to each of them at the same path", async () => {
		const { calls, runPi } = recording();
		const prompt = `the brief ${Date.now()}`;

		await runReviewer({ reviewer: { id: "a" }, prompt, cwd: "/t", runPi });
		await runReviewer({ reviewer: { id: "b" }, prompt, cwd: "/t", runPi });

		expect(brief(calls[0] ?? [])).toBeDefined();
		expect(brief(calls[0] ?? [])).toBe(brief(calls[1] ?? []));
	});

	it("is named by what it says, so another brief gets another path", async () => {
		const { calls, runPi } = recording();

		await runReviewer({
			reviewer: { id: "a" },
			prompt: "one",
			cwd: "/t",
			runPi,
		});
		await runReviewer({
			reviewer: { id: "a" },
			prompt: "two",
			cwd: "/t",
			runPi,
		});

		expect(brief(calls[0] ?? [])).not.toBe(brief(calls[1] ?? []));
	});

	it("comes before what each reviewer alone is asked, which is all that differs", async () => {
		const { calls, runPi } = recording();
		const prompt = `the brief ${Date.now()}`;

		for (const [id, ask] of [
			["a", "## Your lens\n\nDistrust a green suite."],
			["b", "## Your lens\n\nAttack it."],
		] as const) {
			await runReviewer({
				reviewer: { id },
				prompt,
				ask,
				systemPrompt: "You review through a lens.",
				cwd: "/t",
				runPi,
			});
		}

		const [one = [], two = []] = calls;
		expect(one.at(-1)).toBe("## Your lens\n\nDistrust a green suite.");
		expect(two.at(-1)).toBe("## Your lens\n\nAttack it.");
		expect(one.slice(0, -1)).toEqual(two.slice(0, -1));
	});

	it("loads the pack that marks the brief's end only for a reviewer with an ask", async () => {
		const { calls, runPi } = recording();

		await runReviewer({
			reviewer: { id: "a" },
			prompt: "p",
			ask: "q",
			cwd: "/t",
			runPi,
		});
		await runReviewer({ reviewer: { id: "a" }, prompt: "p", cwd: "/t", runPi });

		const packs = (args: readonly string[]) =>
			args.filter((_, at) => args[at - 1] === "--extension");
		expect(packs(calls[0] ?? [])).toEqual([
			expect.stringMatching(/packs\/shared-brief\/index\.ts$/),
		]);
		const pack = packs(calls[0] ?? [])[0] ?? "";
		expect(existsSync(pack), `${pack} exists`).toBe(true);
		expect(calls[1]).not.toContain("--extension");
	});

	it("stays on disk until the last reviewer reading it is done", async () => {
		// A round starts its first reviewer before the rest, and the first
		// can fail fast. Removing the brief then would leave the next
		// reviewer's pi with a path that is not there.
		const prompt = `held ${Date.now()}`;
		const seen: Record<string, boolean> = {};
		let letSecondFinish = () => {};
		const secondMayFinish = new Promise<void>((resolve) => {
			letSecondFinish = resolve;
		});
		let path = "";
		const runPi: RunPi = async (opts) => {
			path = (brief(opts.args) ?? "").slice(1);
			seen[opts.reviewerId ?? ""] = existsSync(path);
			if (opts.reviewerId === "b") await secondMayFinish;
			return { stdout: ANSWER, stderr: "", exitCode: 0 };
		};

		const second = runReviewer({
			reviewer: { id: "b" },
			prompt,
			cwd: "/t",
			runPi,
		});
		await runReviewer({ reviewer: { id: "a" }, prompt, cwd: "/t", runPi });

		expect(existsSync(path), `${path} is kept while b reads it`).toBe(true);
		letSecondFinish();
		await second;
		expect(seen).toEqual({ a: true, b: true });
		expect(existsSync(path), `${path} is gone once both are done`).toBe(false);
	});

	it("holds the brief whole, which the reviewer reads as its prompt", async () => {
		let held = "";
		const runPi: RunPi = async (opts) => {
			held = readFileSync((brief(opts.args) ?? "").slice(1), "utf8");
			return { stdout: ANSWER, stderr: "", exitCode: 0 };
		};

		await runReviewer({
			reviewer: { id: "a" },
			prompt: "the whole brief",
			cwd: "/t",
			runPi,
		});

		expect(held).toBe("the whole brief");
	});

	it("is never taken from one conversation of a host by another sending it too", async () => {
		// Pi loads a fresh copy of the module for each conversation in a
		// host, and each copy counts only its own holders.
		vi.resetModules();
		const one = await import("../../../lib/subagent/subagent.ts");
		vi.resetModules();
		const other = await import("../../../lib/subagent/subagent.ts");
		const prompt = `the brief ${Date.now()}`;
		let started = (): void => {};
		const waiting = new Promise<void>((resolve) => {
			started = resolve;
		});
		let finish = (): void => {};
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let found = "";
		const slow: RunPi = async (opts) => {
			started();
			await finished;
			found = readFileSync((brief(opts.args) ?? "").slice(1), "utf8");
			return { stdout: ANSWER, stderr: "", exitCode: 0 };
		};

		const holding = other.runReviewer({
			reviewer: { id: "b" },
			prompt,
			cwd: "/t",
			runPi: slow,
		});
		await waiting;
		await one.runReviewer({
			reviewer: { id: "a" },
			prompt,
			cwd: "/t",
			runPi: recording().runPi,
		});
		finish();
		await holding;

		expect(
			found,
			"the other conversation's reviewer still reads its brief",
		).toBe(prompt);
	});
});

describe("a brief a detached round's reviewers share", () => {
	/** A start that records what it was told and starts nothing. */
	function noting() {
		const calls: (readonly string[])[] = [];
		const startPi = async (options: {
			args: readonly string[];
			reviewerId?: string;
		}): Promise<StartedPi> => {
			calls.push(options.args);
			return {
				runId: "run",
				reviewerId: options.reviewerId ?? "reviewer",
				pid: 99,
				requestPath: "/dev/null",
			};
		};
		return { calls, startPi };
	}

	it("is kept once for the run, at one path every reviewer is handed", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "shared-brief-"));
		const { calls, startPi } = noting();

		for (const id of ["a", "b"]) {
			await startReviewer({
				reviewer: { id },
				prompt: "the brief",
				ask: `lens ${id}`,
				cwd: stateDir,
				runId: "run",
				stateDir,
				startPi,
			});
		}

		const [one = [], two = []] = calls;
		const path = brief(one)?.slice(1) ?? "";
		expect(brief(two)).toBe(`@${path}`);
		const { briefsDir } = new ReviewerArtifactsStore(stateDir).rootPaths("run");
		expect(path.startsWith(briefsDir), `${path} is under ${briefsDir}`).toBe(
			true,
		);
		expect(await readFile(path, "utf8")).toBe("the brief");
		expect(one.at(-1)).toBe("lens a");
	});

	it("leaves each reviewer's record of the whole question it was asked", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "shared-brief-"));
		const { startPi } = noting();

		await startReviewer({
			reviewer: { id: "a" },
			prompt: "the brief",
			ask: "lens a",
			cwd: stateDir,
			runId: "run",
			stateDir,
			startPi,
		});

		const { promptPath } = new ReviewerArtifactsStore(stateDir).paths(
			"run",
			"a",
		);
		expect(await readFile(promptPath, "utf8")).toBe("the brief\n\nlens a");
	});
});
