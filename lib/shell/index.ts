/**
 * Shell command parsing utilities.
 *
 * Public entry point for analysing bash command strings.
 * Used by guardians, interceptors and any code that needs
 * to understand shell command structure.
 */

export {
	extractBody,
	extractBodyFilePath,
	extractFlag,
	hasUnquotedHeredoc,
	quote,
	splitAtCommand,
	stripHeredocBodies,
	stripShellData,
} from "./parse.js";
