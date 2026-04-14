/**
 * Converts a redirect note into a guardian block result.
 * Guardians return this directly from review() when the
 * user steers toward a different approach.
 */

import { formatRedirectReason } from "../ui/redirect.js";

/**
 * Format a redirect as a guardian block result.
 * Guardians return this directly from review().
 */
export function formatRedirectBlock(
	note: string,
	context: string,
): { block: true; reason: string } {
	return { block: true, reason: formatRedirectReason(note, context) };
}
