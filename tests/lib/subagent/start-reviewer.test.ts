import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.ts";
import type { WrapUpRequest } from "../../../lib/subagent/run-contract.ts";
import type { StartedPi } from "../../../lib/subagent/runpi/supervisor.ts";
import { startReviewer } from "../../../lib/subagent/subagent.ts";

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
		wrapUp?: WrapUpRequest;
	}[] = [];
	const startPi = async (options: {
		args: readonly string[];
		reviewerId?: string;
		persistSession?: boolean;
		wrapUpReserveMs?: number;
		wrapUp?: WrapUpRequest;
	}): Promise<StartedPi> => {
		calls.push({
			args: options.args,
			...(options.wrapUp === undefined ? {} : { wrapUp: options.wrapUp }),
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

		// The run's one copy of the brief, which every reviewer of the
		// round is pointed at, so their requests open with the same bytes.
		const { briefsDir } = new ReviewerArtifactsStore(stateDir).rootPaths("run");
		const brief = noted.calls[0]?.args.find((arg) => arg.startsWith("@"));
		expect(
			brief?.startsWith(`@${briefsDir}/`),
			`${brief} points into ${briefsDir}`,
		).toBe(true);
		expect(noted.calls[0]?.args).not.toContain("x".repeat(4096));
		expect(await readFile(brief?.slice(1) ?? "", "utf8")).toBe(
			"x".repeat(4096),
		);
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

	it("persists the session and has its supervisor ask for a wrap-up", async () => {
		// A detached reviewer cannot be resumed by the parent that
		// started it, so the session on disk is what any follow-up reads.
		// It reserved nothing for a wrap-up once, since only a waiting
		// parent sent one, and three rounds on a megabyte brief ran to
		// the wall having written nothing down: 24 reviewers, 45 minutes
		// each, no findings. The supervisor now asks, so the reserve is
		// taken, and the wrap-up is spelled out for it in full.
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

		expect(noted.calls[0]).toMatchObject({
			persistSession: true,
			wrapUpReserveMs: 60_000,
			wrapUp: {
				reviewerId: "hawk+wrapup",
				timeoutMs: 60_000,
				idleTimeoutMs: 60_000,
			},
		});
		const asked = noted.calls[0]?.wrapUp?.args ?? [];
		expect(asked, "it resumes the session it was stopped in").toContain(
			"--session",
		);
		expect(asked.join(" ")).toContain("ran out of time");
	});

	it("keeps the default reserve when none is named, and still asks when it is off", async () => {
		// As the waiting path does: switched off, the reviewer runs to its
		// wall, and a reviewer the wall stopped is still asked.
		const stateDir = await tempStateDir();
		const noted = noteStart();
		const start = (more: { wrapUpReserveMs?: number }) =>
			startReviewer({
				reviewer: { id: "hawk" },
				prompt: "read it",
				cwd: stateDir,
				runId: "run",
				stateDir,
				startPi: noted.startPi,
				...more,
			});

		await start({});
		await start({ wrapUpReserveMs: 0 });

		expect(noted.calls[0]?.wrapUpReserveMs).toBe(5 * 60 * 1000);
		expect(noted.calls[0]?.wrapUp?.timeoutMs).toBe(5 * 60 * 1000);
		expect(noted.calls[1]?.wrapUpReserveMs).toBeUndefined();
		expect(noted.calls[1]?.wrapUp?.timeoutMs).toBe(5 * 60 * 1000);
	});

	it("hands the reviewer the packs it was given", async () => {
		// The whole detached story rests on this argument arriving. A
		// started reviewer's answer is only ever read off disk, so a
		// finding it did not write down before it died is one nothing
		// can recover: the pack is not a nicety here the way it is on
		// the waiting path, it is the only thing keeping the round.
		const stateDir = await tempStateDir();
		const noted = noteStart();

		await startReviewer({
			reviewer: { id: "hawk" },
			prompt: "read it",
			cwd: stateDir,
			runId: "run",
			stateDir,
			startPi: noted.startPi,
			extraExtensions: ["/packs/review-journal/index.ts"],
		});

		const args = noted.calls[0]?.args ?? [];
		expect(args).toContain("--extension");
		expect(args[args.indexOf("--extension") + 1]).toBe(
			"/packs/review-journal/index.ts",
		);
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
