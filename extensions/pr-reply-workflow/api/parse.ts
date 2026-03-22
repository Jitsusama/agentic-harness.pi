/**
 * Re-export shared PR reference parsing for pr-reply.
 */

export {
	extractOwnerRepo,
	type PRReference,
	parsePRReference,
} from "../../lib/github/pr-reference.js";
