/**
 * Re-export shared PR reference parsing for pr-review.
 */

export {
	extractOwnerRepo,
	type PRReference,
	parsePRReference,
} from "../../lib/parse/pr-reference.js";
