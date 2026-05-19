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

import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import type { PrMetadata } from "./fetch.js";

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
}

/** Top-level runtime state for the PR workflow. */
export interface PrWorkflowState {
	/** Whether the workflow is currently engaged. */
	active: boolean;
	/** The PR loaded into the session, if any. */
	pr: ActivePr | null;
}

/** Construct the initial state for a fresh session. */
export function createPrWorkflowState(): PrWorkflowState {
	return {
		active: false,
		pr: null,
	};
}
