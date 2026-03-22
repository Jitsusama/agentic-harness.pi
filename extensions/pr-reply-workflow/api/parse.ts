/**
 * Re-export shared PR reference parsing for pr-reply.
 */

export {
	extractOwnerRepo,
	type PRReference,
	parsePRReference,
} from "../../lib/parse/pr-reference.js";
