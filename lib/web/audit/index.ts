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
	criteriaOf,
	type FindingKind,
	type FindingNode,
	type Impact,
	levelsOf,
	MAX_NODE_HTML,
	type RawAxeNode,
	type RawAxeResult,
	type RawAxeRun,
	readAxeRun,
	readResult,
	tallyFindings,
} from "./axe.js";
export {
	composite,
	contrastRatio,
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
export {
	MAX_LISTED_NODES,
	renderAudit,
	renderFinding,
	renderIndex,
	renderSummary,
} from "./report.js";
export {
	ENHANCED_TARGET_PX,
	judgeTarget,
	judgeTargets,
	MINIMUM_TARGET_PX,
	type Rect,
	renderTargets,
	type Target,
	type TargetException,
	type TargetLevel,
	type TargetVerdict,
} from "./target.js";
