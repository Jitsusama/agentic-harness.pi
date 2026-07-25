/**
 * The accessibility domain: the page as assistive technology
 * perceives it.
 *
 * Analysis here is capture-agnostic. Everything takes plain
 * serializable data, so a tree captured by CDP, by Playwright
 * or read back from a fixture is analyzed by the same code.
 */

export {
	isWeakName,
	type NameSource,
	nameSource,
} from "./naming.js";
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
