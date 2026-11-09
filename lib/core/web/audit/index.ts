/**
 * Judging a page against accessibility criteria.
 *
 * The arithmetic here is pure and capture-agnostic: colours and
 * rectangles in, verdicts out. Nothing in this subdomain talks
 * to a browser, which is what lets the same functions judge a
 * live page, a stored capture or a design token.
 */

export {
	type A11yFinding,
	type ConformanceBar,
	enabledRules,
	mergeFindings,
	type RawAxeRun,
	readAxeRun,
	tallyFindings,
	withinBar,
} from "./axe.ts";
export {
	type BehindReport,
	foldBehind,
	renderBehind,
} from "./behind.ts";
export {
	type AxFacts,
	buildStructure,
} from "./capture.ts";
export { parseRgb } from "./colour.ts";
export type { ContrastLevel } from "./contrast.ts";
export {
	type Part,
	renderHealth,
} from "./health.ts";
export {
	analyseMotion,
	MOTION_CAPTURE,
	type MotionCapture,
} from "./motion.ts";
export {
	foldPair,
	type PaintedSide,
	type PairReport,
	renderPair,
} from "./pair.ts";
export {
	TARGET_CAPTURE,
	visualCaptureSource,
} from "./probe.ts";
export {
	MAX_LISTED_NODES,
	renderAudit,
} from "./report.ts";
export {
	analyseStructure,
	type StructureNode,
	SUPERSEDED_BY,
} from "./structure.ts";
export {
	type Condition,
	conditionFrom,
	headlineOf,
	renderSweep,
	standingOf,
	widthsToSweep,
} from "./sweep.ts";
export {
	type CapturedTarget,
	targetFindings,
} from "./target.ts";
export { renderVerdict } from "./verdict.ts";
export {
	analyseVisual,
	type PageBox,
	type VisualNode,
} from "./visual.ts";
