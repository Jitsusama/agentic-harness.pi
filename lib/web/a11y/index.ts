/**
 * The accessibility domain: the page as assistive technology
 * perceives it.
 *
 * Analysis here is capture-agnostic. Everything takes plain
 * serializable data, so a tree captured by CDP, by Playwright
 * or read back from a fixture is analyzed by the same code.
 */

export { renderAxOutline } from "./outline.js";
export {
	type AxNode,
	type AxProperties,
	normalizeAxTree,
	type RawAxNode,
	type RawAxProperty,
} from "./tree.js";
