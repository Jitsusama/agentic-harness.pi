/**
 * The accessibility domain: the page as assistive technology
 * perceives it.
 *
 * Analysis here is capture-agnostic. Everything takes plain
 * serializable data, so a tree captured by CDP, by Playwright
 * or read back from a fixture is analyzed by the same code.
 */

export {
	ANNOUNCE_BINDING,
	ANNOUNCEMENT_OBSERVER,
	type Announcement,
	type AnnouncementCandidate,
	CANDIDATE_REGISTRY,
	renderAnnouncements,
} from "./announcements.ts";
export {
	ACTION_VIEW_BUDGET_BYTES,
	type BudgetedOutline,
	MAX_OUTLINE_BUDGET_BYTES,
	OUTLINE_BUDGET_BYTES,
	outlineBudget,
	withinOutlineBudget,
} from "./budget.ts";
export {
	FOCUS_PROBE,
	type FocusHolder,
	renderFocus,
} from "./focus.ts";
export { isWeakName, type NameSource, nameSource } from "./naming.ts";
export { renderAxOutline } from "./outline.ts";
export { renderReading } from "./reading.ts";
export {
	type Skeleton,
	scopeTree,
	subtreeAt,
	type TreeScope,
} from "./scope.ts";
// Exported because a stored page has to carry the same states the
// rendered outline shows. Two vocabularies for one set of facts
// would make a payload that disagrees with the view it came from.
export { describeStates, type StateOptions } from "./states.ts";
export {
	type AxNode,
	type AxProperties,
	type FrameAxTree,
	isMeaningful,
	normalizeAxTree,
	type RawAxNameSource,
	type RawAxNode,
	type RawAxProperty,
	spliceFrames,
} from "./tree.ts";
export {
	analyseWalk,
	type FocusStyle,
	type Indicator,
	indicatorOf,
	MAX_LISTED_FINDINGS,
	renderWalk,
	type Trap,
	type Unreachable,
	type WalkCandidate,
	type WalkCapture,
	type WalkFindings,
	type WalkStop,
} from "./walk.ts";
// The page-side halves of the keyboard walk, in the order they
// run: collect what can hold focus, remember where the caller
// left things, read each stop, then put the page back.
export {
	WALK_COLLECT,
	WALK_READ,
	WALK_REMEMBER,
	WALK_RESTORE,
} from "./walkprobe.ts";
