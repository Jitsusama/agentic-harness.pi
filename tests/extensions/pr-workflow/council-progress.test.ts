import { describe, expect, it } from "vitest";
import type { CouncilDispatch } from "../../../extensions/pr-workflow/council.js";
import { runCouncil } from "../../../extensions/pr-workflow/council.js";
import type {
	CouncilProgress,
	CouncilProgressEntry,
} from "../../../extensions/pr-workflow/council-progress.js";
import type {
	CouncilReviewer,
	RunReviewerResult,
} from "../../../extensions/pr-workflow/reviewer.js";
import { WorktreeRegistry } from "../../../extensions/pr-workflow/worktree.js";
import { fakeProvider } from "./council.test-helpers.js";

interface ProgressEvent {
	readonly tag:
		| "start"
		| "started"
		| "activity"
		| "completed"
		| "failed"
		| "finish";
	readonly reviewerId?: string;
	readonly findingCount?: number;
	readonly error?: string;
	readonly activity?: string;
	readonly snapshot?: readonly CouncilProgressEntry[];
}

function recorder(): {
	events: ProgressEvent[];
	progress: CouncilProgress;
} {
	const events: ProgressEvent[] = [];
	const progress: CouncilProgress = {
		start(entries) {
			events.push({ tag: "start", snapshot: entries });
		},
		reviewerStarted(reviewerId) {
			events.push({ tag: "started", reviewerId });
		},
		reviewerActivity(reviewerId, activity) {
			events.push({ tag: "activity", reviewerId, activity });
		},
		reviewerCompleted(reviewerId, output) {
			events.push({
				tag: "completed",
				reviewerId,
				findingCount: output.findings.length,
			});
		},
		reviewerFailed(reviewerId, error) {
			events.push({ tag: "failed", reviewerId, error });
		},
		finish() {
			events.push({ tag: "finish" });
		},
	};
	return { events, progress };
}

const roster: CouncilReviewer[] = [
	{ id: "fast", model: "anthropic/claude-haiku-4-5" },
	{ id: "slow", model: "anthropic/claude-opus-4-7" },
];

const target = {
	owner: "o",
	repo: "r",
	sha: "abc",
	prNumber: 1,
	title: "t",
	description: "",
	files: [],
};

function findings(text: string): RunReviewerResult {
	return {
		reviewerId: "",
		exitCode: 0,
		finalAssistantText: text,
		stderr: "",
		warnings: [],
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("CouncilProgress integration with runCouncil", () => {
	it("emits start, per-reviewer started+completed, and finish", async () => {
		const { events, progress } = recorder();
		const dispatch: CouncilDispatch = async ({ reviewer }) => ({
			...findings(
				JSON.stringify({
					findings: [
						{
							location: { kind: "global" },
							label: "issue",
							subject: `s-${reviewer.id}`,
							discussion: "d",
						},
					],
				}),
			),
			reviewerId: reviewer.id,
		});

		await runCouncil({
			runId: "council-1",
			target,
			reviewers: roster,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			progress,
		});

		const tags = events.map((e) => e.tag);
		expect(tags[0]).toBe("start");
		expect(tags[tags.length - 1]).toBe("finish");
		expect(tags.filter((t) => t === "started")).toHaveLength(2);
		expect(tags.filter((t) => t === "completed")).toHaveLength(2);

		const completed = events.filter((e) => e.tag === "completed");
		const ids = completed.map((e) => e.reviewerId).sort();
		expect(ids).toEqual(["fast", "slow"]);
		expect(completed.every((e) => e.findingCount === 1)).toBe(true);
	});

	it("reports a reviewer as complete as soon as that dispatch settles", async () => {
		const { events, progress } = recorder();
		const fast = deferred<RunReviewerResult>();
		const slow = deferred<RunReviewerResult>();
		const dispatch: CouncilDispatch = ({ reviewer }) =>
			reviewer.id === "fast" ? fast.promise : slow.promise;

		const run = runCouncil({
			runId: "council-early-complete",
			target,
			reviewers: roster,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			progress,
		});

		for (let i = 0; i < 20; i++) {
			if (events.some((event) => event.tag === "started")) break;
			await Promise.resolve();
		}

		fast.resolve({
			...findings(JSON.stringify({ findings: [] })),
			reviewerId: "fast",
		});
		for (let i = 0; i < 20; i++) {
			if (events.some((event) => event.tag === "completed")) break;
			await Promise.resolve();
		}

		expect(
			events.some(
				(event) => event.tag === "completed" && event.reviewerId === "fast",
			),
		).toBe(true);
		expect(events.some((event) => event.tag === "finish")).toBe(false);

		slow.resolve({
			...findings(JSON.stringify({ findings: [] })),
			reviewerId: "slow",
		});
		await run;
	});

	it("reports the full roster as pending in the start snapshot", async () => {
		const { events, progress } = recorder();
		const dispatch: CouncilDispatch = async ({ reviewer }) => ({
			...findings("{}"),
			reviewerId: reviewer.id,
		});
		await runCouncil({
			runId: "council-2",
			target,
			reviewers: roster,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			progress,
		});

		const start = events.find((e) => e.tag === "start");
		expect(start?.snapshot).toBeDefined();
		expect(start?.snapshot?.map((e) => e.reviewer.id)).toEqual([
			"fast",
			"slow",
		]);
		expect(start?.snapshot?.every((e) => e.state === "pending")).toBe(true);
	});

	it("reports a failed reviewer without aborting the rest", async () => {
		const { events, progress } = recorder();
		const dispatch: CouncilDispatch = async ({ reviewer }) => {
			if (reviewer.id === "slow") {
				throw new Error("dispatch boom");
			}
			return {
				...findings(
					JSON.stringify({
						findings: [
							{
								location: { kind: "global" },
								label: "issue",
								subject: "s",
								discussion: "d",
							},
						],
					}),
				),
				reviewerId: reviewer.id,
			};
		};

		await runCouncil({
			runId: "council-3",
			target,
			reviewers: roster,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			progress,
		});

		const failed = events.find((e) => e.tag === "failed");
		const completed = events.filter((e) => e.tag === "completed");
		expect(failed?.reviewerId).toBe("slow");
		expect(failed?.error).toMatch(/dispatch boom/);
		expect(completed.map((e) => e.reviewerId)).toEqual(["fast"]);
	});

	it("forwards mid-flight tool events to reviewerActivity", async () => {
		const { events, progress } = recorder();
		const dispatch: CouncilDispatch = async ({ reviewer, onEvent }) => {
			onEvent?.({
				type: "tool_execution_start",
				toolName: "read",
				args: { path: "task.go" },
			});
			onEvent?.({
				type: "tool_execution_start",
				toolName: "grep",
				args: { pattern: "Save" },
			});
			// Non-tool events shouldn't produce activity entries.
			onEvent?.({ type: "message_end", message: {} });
			return { ...findings("{}"), reviewerId: reviewer.id };
		};

		await runCouncil({
			runId: "council-activity",
			target,
			reviewers: [roster[0]],
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			progress,
		});

		const activities = events.filter((e) => e.tag === "activity");
		expect(activities).toHaveLength(2);
		expect(activities[0]?.reviewerId).toBe("fast");
		expect(activities[0]?.activity).toBe("reading task.go");
		expect(activities[1]?.activity).toBe("grep Save");
	});

	it("survives a broken reporter without crashing the run", async () => {
		const broken: CouncilProgress = {
			start() {
				throw new Error("start broke");
			},
			reviewerStarted() {
				throw new Error("started broke");
			},
			reviewerActivity() {
				throw new Error("activity broke");
			},
			reviewerCompleted() {
				throw new Error("completed broke");
			},
			reviewerFailed() {
				throw new Error("failed broke");
			},
			finish() {
				throw new Error("finish broke");
			},
		};
		const dispatch: CouncilDispatch = async ({ reviewer }) => ({
			...findings("{}"),
			reviewerId: reviewer.id,
		});

		const run = await runCouncil({
			runId: "council-4",
			target,
			reviewers: roster,
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
			progress: broken,
		});

		expect(run.reviewerOutputs).toHaveLength(2);
	});
});
