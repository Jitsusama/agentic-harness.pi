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
	type Authority,
	type AxeTally,
	authorityOf,
	type ConformanceBar,
	criteriaOf,
	ENHANCED_WCAG_RULES,
	EXPERIMENTAL_WCAG_RULES,
	enabledRules,
	type FindingKind,
	type FindingNode,
	hardestLevel,
	type Impact,
	levelsOf,
	MAX_NODE_HTML,
	mergeFindings,
	type RawAxeNode,
	type RawAxeResult,
	type RawAxeRun,
	readAxeRun,
	readResult,
	tallyFindings,
	withinBar,
} from "./axe.ts";
export {
	type BehindReport,
	foldBehind,
	type Pixels,
	type Rgb,
	renderBehind,
} from "./behind.ts";
export {
	type AxFacts,
	buildStructure,
	selectorFor,
} from "./capture.ts";
export {
	composite,
	contrastRatio,
	deltaE,
	formatRgb,
	isOpaque,
	isTransparent,
	parseRgb,
	type Rgba,
	relativeLuminance,
} from "./colour.ts";
export {
	BOLD_WEIGHT,
	type ContrastLevel,
	type ContrastVerdict,
	isLargeText,
	judgeNonText,
	judgeText,
	LARGE_BOLD_PX,
	LARGE_TEXT_PX,
	NON_TEXT_MINIMUM,
	renderContrast,
	type TextSizing,
	textThreshold,
	undecidable,
} from "./contrast.ts";
export { overallOf, type Part, renderHealth } from "./health.ts";
export {
	analyseMotion,
	BRIEF_MS,
	MOTION_CAPTURE,
	type MotionAnimation,
	type MotionCapture,
	type MotionVideo,
	PAUSE_STOP_HIDE_MS,
} from "./motion.ts";
export {
	foldPair,
	type PaintedSide,
	type PairReport,
	renderPair,
} from "./pair.ts";
export { TARGET_CAPTURE, visualCaptureSource } from "./probe.ts";
export {
	MAX_LISTED_NODES,
	renderAudit,
	renderFinding,
	renderIndex,
	renderSummary,
} from "./report.ts";
export {
	analyseStructure,
	autocompleteTokens,
	brokenReferences,
	formLabelling,
	headingOutline,
	hiddenButFocusable,
	IDREF_ATTRIBUTES,
	LANDMARK_ROLES,
	landmarkNaming,
	manualTabOrder,
	nestedInteractives,
	SINGLE_IDREF_ATTRIBUTES,
	type StructureNode,
	SUPERSEDED_BY,
} from "./structure.ts";
export {
	type Condition,
	conditionFrom,
	DEFAULT_WIDTHS,
	headlineOf,
	renderSweep,
	type Sweepable,
	standingOf,
	widthsToSweep,
	worstOf,
} from "./sweep.ts";
export {
	type CapturedTarget,
	ENHANCED_TARGET_PX,
	type HitTarget,
	judgeTarget,
	judgeTargets,
	MINIMUM_TARGET_PX,
	renderTargets,
	type TargetException,
	type TargetLevel,
	type TargetVerdict,
	targetFindings,
} from "./target.ts";
export {
	renderVerdict,
	type Standing,
	standingFor,
	type Verdict,
} from "./verdict.ts";
export {
	ASPECT_TOLERANCE,
	analyseVisual,
	brokenImages,
	clippedContent,
	distortedImages,
	escapedElements,
	HIDDEN_BOX_PX,
	horizontalOverflow,
	isVisuallyHidden,
	type PageBox,
	SMALL_TEXT_PX,
	tinyText,
	type VisualNode,
} from "./visual.ts";
