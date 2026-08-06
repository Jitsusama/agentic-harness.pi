import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.js";
import type { StartedPi } from "../../../lib/subagent/runpi/supervisor.js";
import { startReviewer } from "../../../lib/subagent/subagent.js";

async function tempStateDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pr-start-reviewer-"));
}

/** A start that records what it was told and starts nothing. */
function noteStart() {
	const calls: {
		args: readonly string[];
		reviewerId?: string;
		persistSession?: boolean;
		wrapUpReserveMs?: number;
	}[] = [];
	const startPi = async (options: {
		args: readonly string[];
		reviewerId?: string;
		persistSession?: boolean;
		wrapUpReserveMs?: number;
	}): Promise<StartedPi> => {
		calls.push({
			args: options.args,
			...(options.reviewerId ? { reviewerId: options.reviewerId } : {}),
			...(options.persistSession === undefined
				? {}
				: { persistSession: options.persistSession }),
			...(options.wrapUpReserveMs === undefined
				? {}
				: { wrapUpReserveMs: options.wrapUpReserveMs }),
		});
		return {
			runId: "run",
			reviewerId: options.reviewerId ?? "reviewer",
			pid: 99,
			requestPath: "/dev/null",
		};
	};
	return { calls, startPi };
}

describe("starting one reviewer nobody will wait for", () => {
	it("keeps the prompt in the reviewer's own directory", async () => {
		// Not a temp file. The running path deletes its prompt in a
		// finally, which is correct when the run has finished and fatal
		// when the parent walks away: the child may not have read it
		// yet, and even once it has, the prompt is the only record of
		// what a round that outlived its session was asked.
		const stateDir = await tempStateDir();
		const noted = noteStart();

		await startReviewer({
			reviewer: { id: "hawk" },
			prompt: "read the diff and say what is wrong",
			cwd: stateDir,
			runId: "run",
			stateDir,
			startPi: noted.startPi,
		});

		const { promptPath } = new ReviewerArtifactsStore(stateDir).paths(
			"run",
			"hawk",
		);
		expect(await readFile(promptPath, "utf8")).toBe(
			"read the diff and say what is wrong",
		);
	});

	it("points the reviewer at that prompt rather than passing it on argv", async () => {
		// A stack review's prompt runs past ARG_MAX, which crashes the
		// child at spawn rather than reporting anything.
		const stateDir = await tempStateDir();
		const noted = noteStart();

		await startReviewer({
			reviewer: { id: "hawk" },
			prompt: "x".repeat(4096),
			cwd: stateDir,
			runId: "run",
			stateDir,
			startPi: noted.startPi,
		});

		const { promptPath } = new ReviewerArtifactsStore(stateDir).paths(
			"run",
			"hawk",
		);
		expect(noted.calls[0]?.args).toContain(`@${promptPath}`);
	});

	it("carries the reviewer's model and persona through", async () => {
		const stateDir = await tempStateDir();
		const noted = noteStart();

		await startReviewer({
			reviewer: { id: "hawk", model: "opus-5", thinkingLevel: "xhigh" },
			prompt: "read it",
			cwd: stateDir,
			runId: "run",
			stateDir,
			startPi: noted.startPi,
		});

		const said = noted.calls[0]?.args.join(" ") ?? "";
		expect(said).toContain("opus-5");
		expect(said).toContain("xhigh");
	});

	it("persists the session and reserves nothing for a wrap-up", async () => {
		// The two decisions this path documents most heavily and pinned
		// nowhere. A detached reviewer cannot be resumed by the parent
		// that started it, so the session on disk is the only thing that
		// makes a later resume possible at all. And a reserve buys time
		// for a wrap-up nobody will dispatch, so taking one spends review
		// time on nothing: note the configured value being dropped here
		// rather than passed on.
		const stateDir = await tempStateDir();
		const noted = noteStart();

		await startReviewer({
			reviewer: { id: "hawk" },
			prompt: "read it",
			cwd: stateDir,
			runId: "run",
			stateDir,
			startPi: noted.startPi,
			wrapUpReserveMs: 60_000,
		});

		expect(noted.calls[0]?.persistSession).toBe(true);
		expect(noted.calls[0]?.wrapUpReserveMs).toBeUndefined();
	});

	it("refuses a budget the runner would refuse", async () => {
		// The same validation the waiting path does. A detached round
		// is the worst place to discover a nonsense budget, since
		// nobody is watching it burn.
		const stateDir = await tempStateDir();
		const noted = noteStart();

		await expect(
			startReviewer({
				reviewer: { id: "hawk" },
				prompt: "read it",
				cwd: stateDir,
				runId: "run",
				stateDir,
				startPi: noted.startPi,
				timeoutMs: 1000,
				idleTimeoutMs: 5000,
			}),
		).rejects.toThrow();
	});
});
