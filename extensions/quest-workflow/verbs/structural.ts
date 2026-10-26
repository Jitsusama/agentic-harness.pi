/**
 * Structural verbs: reparent (single or bulk), bulk conclude/
 * retire, and undo. Fully pi-agnostic; the implementation
 * lives in agentic-harness.core.
 */

export {
	bulkConcludeOrRetire,
	reparent,
	undo,
} from "../../../lib/core/quest/verbs/structural.ts";
