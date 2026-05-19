/**
 * Runtime state for the PR workflow extension.
 *
 * Holds the active PR reference, any findings collected so
 * far, and the state of side-channel surfaces (council
 * pipeline, neovim companion, stack awareness). The shape
 * grows as each capability is scaffolded.
 *
 * Everything lives in memory for the session; nothing is
 * written to disk by this module. Persistence helpers, when
 * needed, will live in a separate file and call into this
 * one.
 */

import type { DiffFile } from "../../lib/internal/github/diff.js";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import type { CritiqueRun } from "./critique.js";
import type { PrMetadata } from "./fetch.js";
import type { CouncilRun } from "./findings.js";
import type { JudgeRun } from "./judge.js";
import type { CouncilReviewer } from "./reviewer.js";
import type { Stack } from "./stack.js";
import type { StackCriticRun } from "./stack-critic.js";
import type { FindingDecision } from "./synthesis.js";

/**
 * Snapshot of the PR currently loaded into the workflow.
 *
 * Once stacks land, this widens to `PRReference[]` (parent
 * to child) and gains a `cursor` field for the PR the agent
 * is currently discussing.
 */
export interface ActivePr {
	/** The PR loaded into the session. */
	reference: PRReference;
	/** ISO 8601 timestamp of when the PR was loaded. */
	loadedAt: string;
	/** Fetched PR metadata. `null` between load and fetch. */
	metadata: PrMetadata | null;
	/** Parsed per-file diff. `null` until the diff is fetched. */
	files: DiffFile[] | null;
	/** Discovered PR stack with cursor position. `null` until detected. */
	stack: Stack | null;
}

/**
 * Council roster and the most recent run.
 *
 * The roster persists across `/reload` (held in session
 * state), so once the user picks reviewers they don't have
 * to reconfigure them every time. `lastRun` is the latest
 * round-1 fan-out; the post-gate and downstream rounds
 * (judge, critique, user synthesis) consult it.
 */
export interface CouncilState {
	/** Reviewers that will fan out on the next council action. */
	roster: CouncilReviewer[];
	/** Judge reviewer for round-2 consolidation. */
	judge: CouncilReviewer | null;
	/**
	 * Stack critic reviewer (Phase 1 of stack-aware
	 * review). Configured separately from the judge so
	 * the user can pick a different model for cross-PR
	 * pattern detection. `null` until the user runs
	 * `stack-critic-config`.
	 */
	stackCritic: CouncilReviewer | null;
	/** Most recent council run (null until one completes). */
	lastRun: CouncilRun | null;
	/** Most recent judge run (null until round 2 completes). */
	lastJudge: JudgeRun | null;
	/** Most recent critique run (null until round 3 completes). */
	lastCritique: CritiqueRun | null;
	/**
	 * Round-4 user decisions keyed by finding id. The
	 * map is mutable: the user can revise a decision
	 * before posting.
	 */
	decisions: Map<number, FindingDecision>;
}

/**
 * Per-PR run state that survives cursor moves through a
 * stack.
 *
 * Phase 0 of stack-aware review: as the user sweeps
 * through a stack, each PR's runs and decisions get
 * stashed under its PR number so they rehydrate on
 * re-visit. Roster and judge config are session-global
 * and live on `CouncilState` directly.
 */
export interface PrRunSnapshot {
	lastRun: CouncilRun | null;
	lastJudge: JudgeRun | null;
	lastCritique: CritiqueRun | null;
	decisions: Map<number, FindingDecision>;
}

/** Top-level runtime state for the PR workflow. */
export interface PrWorkflowState {
	/** Whether the workflow is currently engaged. */
	active: boolean;
	/** The PR loaded into the session, if any. */
	pr: ActivePr | null;
	/** Council configuration and history. */
	council: CouncilState;
	/**
	 * Per-PR run snapshots keyed by PR number. Populated
	 * by `loadPr` when the cursor moves off a PR that
	 * actually has runs or decisions to remember.
	 */
	stackRuns: Map<number, PrRunSnapshot>;
	/**
	 * Most recent stack-critic run. Cross-PR by nature,
	 * so it lives at the top level rather than on any
	 * single PR's slot.
	 */
	stackCritic: StackCriticRun | null;
	/**
	 * Decisions on stack-level findings, keyed by
	 * finding id. Separate from per-PR
	 * `council.decisions` so the two id spaces never
	 * collide: a stack finding and a per-PR finding can
	 * both be id 3 without confusion.
	 */
	stackDecisions: Map<number, FindingDecision>;
	/**
	 * Most recent review-threads snapshot for the
	 * loaded PR. Populated by action=threads; consumed
	 * by action=reply and action=resolve to translate
	 * the user's display index into a thread id. Lives
	 * on the top-level state because threads are a
	 * per-PR concern but never need to survive cursor
	 * moves: re-running `threads` after navigation is
	 * cheap and avoids the staleness traps snapshots
	 * would introduce.
	 */
	threads: ThreadsSnapshot | null;
}

/**
 * The set of review threads fetched at a point in time,
 * plus the metadata needed to detect drift.
 *
 * The display index is the position in `threads` (1-based
 * for users; 0-based in code). Reply / resolve target this
 * index, so re-running `threads` after merging upstream
 * activity refreshes the index in one shot.
 */
export interface ThreadsSnapshot {
	readonly prNumber: number;
	readonly fetchedAt: string;
	readonly threads: readonly import("./threads.js").ReviewThread[];
}

/** Construct the initial state for a fresh session. */
export function createPrWorkflowState(): PrWorkflowState {
	return {
		active: false,
		pr: null,
		council: {
			roster: [],
			judge: null,
			stackCritic: null,
			lastRun: null,
			lastJudge: null,
			lastCritique: null,
			decisions: new Map(),
		},
		stackRuns: new Map(),
		stackCritic: null,
		stackDecisions: new Map(),
		threads: null,
	};
}
