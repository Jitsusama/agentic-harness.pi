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
} from "./announcements.js";
export { isWeakName, type NameSource, nameSource } from "./naming.js";
export { renderAxOutline } from "./outline.js";
export { renderReading } from "./reading.js";
export {
	type Skeleton,
	scopeTree,
	subtreeAt,
	type TreeScope,
} from "./scope.js";
export {
	type AxNode,
	type AxProperties,
	isMeaningful,
	normalizeAxTree,
	type RawAxNameSource,
	type RawAxNode,
	type RawAxProperty,
} from "./tree.js";
export {
	analyseWalk,
	type FocusStyle,
	type Indicator,
	indicatorOf,
	renderWalk,
	type Trap,
	type Unreachable,
	type WalkCandidate,
	type WalkCapture,
	type WalkFindings,
	type WalkStop,
} from "./walk.js";
// The page-side halves of the keyboard walk, in the order they
// run: collect what can hold focus, remember where the caller
// left things, read each stop, then put the page back.
export {
	WALK_COLLECT,
	WALK_READ,
	WALK_REMEMBER,
	WALK_RESTORE,
} from "./walkprobe.js";
