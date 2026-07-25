/**
 * The styles domain: how an element is painted and laid out.
 *
 * Analysis here is capture-agnostic. Everything takes plain
 * serializable data, so styles read by CDP, by another driver
 * or from a fixture are curated by the same code.
 */

export {
	asCall,
	COMPUTED_STYLE_PROBE,
	INITIALS_PROBE,
	SHORTHAND_PROPERTIES,
} from "./capture.js";
export {
	type ComputedStyles,
	type CurateOptions,
	curateStyles,
	type StyleEntry,
	type StyleGroup,
} from "./curation.js";
