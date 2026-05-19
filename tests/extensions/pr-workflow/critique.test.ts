import { describe, expect, it } from "vitest";
import {
	buildCritiquePrompt,
	type CritiqueParseContext,
	parseCritiqueOutput,
	runCritique,
} from "../../../extensions/pr-workflow/critique.js";
import type {
	CouncilRun,
	Finding,
} from "../../../extensions/pr-workflow/findings.js";
import type { JudgeRun } from "../../../extensions/pr-workflow/judge.js";
import type { CouncilReviewer } from "../../../extensions/pr-workflow/reviewer.js";
import {
	type WorktreeProvider,
	WorktreeRegistry,
} from "../../../extensions/pr-workflow/worktree.js";

/**
 * Round 3 — critique.
 *
 * Original reviewers see the judge's consolidated list
 * and take a position per finding: agree, disagree,
 * qualify, or amplify. Critiques annotate findings; they
 * never remove them.
 *
 * The orchestrator fans out across the same roster used
 * in round 1, in parallel. Each reviewer gets a prompt
 * containing the consolidated list (with raisedBy
 * attribution) and their own round-1 findings for
 * recall.
 */

function council(): CouncilRun {
	const fast: Finding[] = [
		{
			id: 1,
			location: { kind: "global" },
			label: "issue",
			decorations: [],
			subject: "fast saw a null deref",
			discussion: "fast's words",
			category: "scope",
			origin: { kind: "council", runId: "c-1", reviewerId: "fast" },
			state: "draft",
		},
	];
	const skeptic: Finding[] = [
		{
			id: 2,
			location: { kind: "global" },
			label: "issue",
			decorations: [],
			subject: "skeptic saw the same null deref",
			discussion: "skeptic's words",
			category: "scope",
			origin: { kind: "council", runId: "c-1", reviewerId: "skeptic" },
			state: "draft",
		},
	];
	return {
		id: "c-1",
		startedAt: "2026-01-01T00:00:00Z",
		target: { kind: "diff", prNumber: 42 },
		reviewerOutputs: [
			{ reviewerId: "fast", findings: fast, warnings: [] },
			{ reviewerId: "skeptic", findings: skeptic, warnings: [] },
		],
	};
}

function judge(): JudgeRun {
	const consolidated: Finding[] = [
		{
			id: 10,
			location: { kind: "global" },
			label: "issue",
			decorations: [],
			subject: "Consolidated null-deref",
			discussion: "Merged finding",
			category: "scope",
			origin: { kind: "judge", runId: "j-1", judgeReviewerId: "judge" },
			state: "draft",
			agreement: { raisedBy: ["fast", "skeptic"], sourceFindingIds: [1, 2] },
		},
		{
			id: 11,
			location: { kind: "file", file: "lib/x.ts" },
			label: "nitpick",
			decorations: [],
			subject: "Variable name",
			discussion: "rename",
			category: "file",
			origin: { kind: "judge", runId: "j-1", judgeReviewerId: "judge" },
			state: "draft",
		},
	];
	return {
		id: "j-1",
		startedAt: "2026-01-01T00:05:00Z",
		judgeReviewerId: "judge",
		selfSignal: { confidence: "high", rationale: "unanimous" },
		consolidatedFindings: consolidated,
		warnings: [],
	};
}

describe("buildCritiquePrompt", () => {
	it("includes the consolidated findings with their judge-assigned ids and raisedBy attribution", async () => {
		const text = buildCritiquePrompt({
			reviewerId: "fast",
			council: council(),
			judge: judge(),
		});
		// Each consolidated finding shows up with its id
		// so the reviewer can reference it in the
		// critique output.
		expect(text).toMatch(/\b10\b/);
		expect(text).toMatch(/\b11\b/);
		expect(text).toContain("Consolidated null-deref");
		expect(text).toContain("Variable name");
		// raisedBy attribution is preserved so the
		// reviewer sees who agreed.
		expect(text).toContain("fast");
		expect(text).toContain("skeptic");
	});

	it("recalls the reviewer's own round-1 findings so they remember what they said", async () => {
		const text = buildCritiquePrompt({
			reviewerId: "fast",
			council: council(),
			judge: judge(),
		});
		expect(text).toContain("fast saw a null deref");
		// Does NOT include the other reviewer's prose
		// verbatim — only their attribution via the
		// judge's raisedBy.
		expect(text).not.toContain("skeptic's words");
	});

	it("documents the four positions: agree, disagree, qualify, amplify", async () => {
		// Design 12: "agree / disagree / qualify /
		// amplify, with rationale." The prompt must
		// instruct on all four.
		const text = buildCritiquePrompt({
			reviewerId: "fast",
			council: council(),
			judge: judge(),
		});
		expect(text).toContain("agree");
		expect(text).toContain("disagree");
		expect(text).toContain("qualify");
		expect(text).toContain("amplify");
	});

	it("asks for a JSON block with a critiques array keyed by findingId", async () => {
		const text = buildCritiquePrompt({
			reviewerId: "fast",
			council: council(),
			judge: judge(),
		});
		expect(text).toContain("```json");
		expect(text).toContain("critiques");
		expect(text).toContain("findingId");
		expect(text).toContain("position");
	});

	it("embeds the critique JSON schema and instructs verify_output", async () => {
		// The critique subagent gets pr-workflow-verify
		// loaded so it can self-validate before ending.
		// The prompt must teach the model to use the tool
		// and embed the schema it's being validated
		// against.
		const text = buildCritiquePrompt({
			reviewerId: "fast",
			council: council(),
			judge: judge(),
		});
		expect(text).toContain("verify_output");
		expect(text).toMatch(/stage[=:].?["']?critique/i);
		expect(text).toMatch(/JSON Schema/i);
		// All four critique positions appear in the
		// embedded schema's enum.
		expect(text).toContain("amplify");
		expect(text).toContain("qualify");
	});
});

describe("parseCritiqueOutput", () => {
	const CTX: CritiqueParseContext = {
		runId: "critique-1",
		reviewerId: "fast",
	};

	it("extracts critique entries from a fenced JSON block", async () => {
		const text = [
			"```json",
			JSON.stringify({
				critiques: [
					{ findingId: 10, position: "agree", rationale: "matches my finding" },
					{
						findingId: 11,
						position: "qualify",
						rationale: "soften to suggestion",
					},
				],
			}),
			"```",
		].join("\n");
		const result = parseCritiqueOutput(text, CTX);
		expect(result.critiques).toHaveLength(2);
		expect(result.critiques[0]).toMatchObject({
			reviewerId: "fast",
			findingId: 10,
			position: "agree",
			rationale: "matches my finding",
		});
		expect(result.critiques[1].position).toBe("qualify");
	});

	it("validates position is one of the four allowed values", async () => {
		const text = [
			"```json",
			JSON.stringify({
				critiques: [
					{ findingId: 10, position: "shrug", rationale: "?" },
					{ findingId: 11, position: "amplify", rationale: "make it blocking" },
				],
			}),
			"```",
		].join("\n");
		const result = parseCritiqueOutput(text, CTX);
		expect(result.critiques).toHaveLength(1);
		expect(result.critiques[0].position).toBe("amplify");
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("drops entries where findingId is not a number", async () => {
		const text = [
			"```json",
			JSON.stringify({
				critiques: [
					{ findingId: "ten", position: "agree", rationale: "x" },
					{ findingId: 11, position: "agree", rationale: "ok" },
				],
			}),
			"```",
		].join("\n");
		const result = parseCritiqueOutput(text, CTX);
		expect(result.critiques).toHaveLength(1);
		expect(result.critiques[0].findingId).toBe(11);
	});

	it("treats missing rationale as a parse failure for that entry", async () => {
		// A position without a rationale is noise; the
		// user-synthesis round expects something to read.
		const text = [
			"```json",
			JSON.stringify({
				critiques: [
					{ findingId: 10, position: "agree" },
					{ findingId: 11, position: "disagree", rationale: "would block" },
				],
			}),
			"```",
		].join("\n");
		const result = parseCritiqueOutput(text, CTX);
		expect(result.critiques).toHaveLength(1);
		expect(result.critiques[0].findingId).toBe(11);
	});

	it("returns empty critiques + warning when no JSON is present", async () => {
		const result = parseCritiqueOutput("prose only", CTX);
		expect(result.critiques).toHaveLength(0);
		expect(result.warnings.length).toBeGreaterThan(0);
	});
});

describe("runCritique", () => {
	const ROSTER: CouncilReviewer[] = [
		{ id: "fast", model: "m-fast" },
		{ id: "skeptic", model: "m-skep" },
	];

	function fakeProvider(): WorktreeProvider {
		return {
			id: "fake",
			async ensure(req) {
				return {
					path: `/wt/${req.sha}`,
					sha: req.sha,
					providerId: "fake",
					reusable: true,
					createdAt: new Date(0),
				};
			},
			async release() {},
		};
	}

	function dispatchEcho() {
		const calls: string[] = [];
		const dispatch = async (opts: {
			reviewer: CouncilReviewer;
			prompt: string;
			cwd: string;
		}) => {
			calls.push(opts.reviewer.id);
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: [
					"```json",
					JSON.stringify({
						critiques: [
							{
								findingId: 10,
								position: opts.reviewer.id === "fast" ? "agree" : "qualify",
								rationale: `${opts.reviewer.id} rationale`,
							},
						],
					}),
					"```",
				].join("\n"),
				stderr: "",
				warnings: [],
			};
		};
		return { dispatch, calls };
	}

	it("fans out across the roster and produces one output per reviewer", async () => {
		const { dispatch, calls } = dispatchEcho();
		const result = await runCritique({
			runId: "critique-1",
			council: council(),
			judge: judge(),
			roster: ROSTER,
			target: { owner: "o", repo: "r", sha: "abc" },
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
		});
		expect(calls.sort()).toEqual(["fast", "skeptic"]);
		expect(result.reviewerOutputs).toHaveLength(2);
		const fastOut = result.reviewerOutputs.find((o) => o.reviewerId === "fast");
		expect(fastOut?.critiques[0].position).toBe("agree");
	});

	it("dispatches reviewers concurrently against a single shared worktree", async () => {
		// All reviewers see the same cwd; if dispatch
		// were serial the second await would only start
		// after the first resolved.
		const seen = new Set<string>();
		let resolveBarrier: (() => void) | null = null;
		const barrier = new Promise<void>((r) => {
			resolveBarrier = r;
		});
		const dispatch = async (opts: {
			reviewer: CouncilReviewer;
			cwd: string;
		}) => {
			seen.add(opts.cwd);
			if (opts.reviewer.id === "skeptic") resolveBarrier?.();
			else await barrier;
			return {
				reviewerId: opts.reviewer.id,
				exitCode: 0,
				finalAssistantText: '```json\n{"critiques":[]}\n```',
				stderr: "",
				warnings: [],
			};
		};
		await runCritique({
			runId: "critique-1",
			council: council(),
			judge: judge(),
			roster: ROSTER,
			target: { owner: "o", repo: "r", sha: "abc" },
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
		});
		expect(seen).toEqual(new Set(["/wt/abc"]));
	});

	it("carries each reviewer's usage block through to ReviewerCritiqueOutput", async () => {
		// Critique fans out a roster like council does. Cost
		// tracking is per reviewer so the status panel can
		// attribute critique spend by model.
		const dispatch = async (opts: {
			reviewer: CouncilReviewer;
			prompt: string;
			cwd: string;
		}) => ({
			reviewerId: opts.reviewer.id,
			exitCode: 0,
			finalAssistantText: '```json\n{"critiques":[]}\n```',
			stderr: "",
			warnings: [],
			usage: {
				tokens: {
					input: opts.reviewer.id === "fast" ? 50 : 75,
					output: opts.reviewer.id === "fast" ? 5 : 7,
					cacheRead: 0,
					cacheWrite: 0,
					total: opts.reviewer.id === "fast" ? 55 : 82,
				},
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: opts.reviewer.id === "fast" ? 0.0005 : 0.0008,
				},
			},
		});
		const result = await runCritique({
			runId: "critique-cost",
			council: council(),
			judge: judge(),
			roster: ROSTER,
			target: { owner: "o", repo: "r", sha: "abc" },
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
		});
		const fast = result.reviewerOutputs.find((r) => r.reviewerId === "fast");
		const skeptic = result.reviewerOutputs.find(
			(r) => r.reviewerId === "skeptic",
		);
		expect(fast?.usage?.tokens.total).toBe(55);
		expect(fast?.usage?.cost.total).toBeCloseTo(0.0005);
		expect(skeptic?.usage?.tokens.total).toBe(82);
	});

	it("links to the judge run it critiques", async () => {
		const { dispatch } = dispatchEcho();
		const result = await runCritique({
			runId: "critique-1",
			council: council(),
			judge: judge(),
			roster: ROSTER,
			target: { owner: "o", repo: "r", sha: "abc" },
			registry: new WorktreeRegistry(fakeProvider()),
			dispatch,
		});
		expect(result.judgeRunId).toBe("j-1");
	});
});
