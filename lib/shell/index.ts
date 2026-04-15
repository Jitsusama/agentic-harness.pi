/**
 * Shell command parsing utilities.
 *
 * Public entry point for analysing bash command strings.
 * Used by guardians, interceptors and any code that needs
 * to understand shell command structure.
 */

export {
	extractBody,
	extractFlag,
	quote,
	splitAtCommand,
	stripHeredocBodies,
	stripShellData,
} from "./parse.js";
