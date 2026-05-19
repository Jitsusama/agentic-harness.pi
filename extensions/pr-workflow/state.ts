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
import type { PrMetadata } from "./fetch.js";
import type { CouncilRun } from "./findings.js";
import type { CouncilReviewer } from "./reviewer.js";
import type { Stack } from "./stack.js";

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
	/** Most recent council run (null until one completes). */
	lastRun: CouncilRun | null;
}

/** Top-level runtime state for the PR workflow. */
export interface PrWorkflowState {
	/** Whether the workflow is currently engaged. */
	active: boolean;
	/** The PR loaded into the session, if any. */
	pr: ActivePr | null;
	/** Council configuration and history. */
	council: CouncilState;
}

/** Construct the initial state for a fresh session. */
export function createPrWorkflowState(): PrWorkflowState {
	return {
		active: false,
		pr: null,
		council: { roster: [], lastRun: null },
	};
}
