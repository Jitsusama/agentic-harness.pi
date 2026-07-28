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
} from "./axe.js";
export {
	type BehindReport,
	foldBehind,
	type Pixels,
	type Rgb,
	renderBehind,
} from "./behind.js";
export {
	type AxFacts,
	buildStructure,
	selectorFor,
} from "./capture.js";
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
} from "./colour.js";
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
} from "./contrast.js";
export { overallOf, type Part, renderHealth } from "./health.js";
export { TARGET_CAPTURE, visualCaptureSource } from "./probe.js";
export {
	MAX_LISTED_NODES,
	renderAudit,
	renderFinding,
	renderIndex,
	renderSummary,
} from "./report.js";
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
} from "./structure.js";
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
} from "./sweep.js";
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
} from "./target.js";
export {
	renderVerdict,
	type Standing,
	standingFor,
	type Verdict,
} from "./verdict.js";
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
} from "./visual.js";
