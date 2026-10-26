/**
 * Model identifier formatting for display in a co-authorship
 * trailer. Each adapter builds its own branded trailer text; this
 * is the one piece of that formatting worth sharing verbatim.
 */

/**
 * Format the model identifier for display. Strips a trailing date
 * suffix, title-cases hyphen segments and joins consecutive digit
 * segments into a version number (claude-opus-4-6 -> Claude Opus 4.6).
 */
export function formatModelName(modelId: string): string {
	const stripped = modelId.replace(/-?\d{8,}$/, "");
	const parts = stripped.split("-");

	const result: string[] = [];
	for (const part of parts) {
		const isDigit = /^\d+$/.test(part);
		const prevIsDigit =
			result.length > 0 && /^\d/.test(result[result.length - 1]);
		if (isDigit && prevIsDigit) {
			result[result.length - 1] += `.${part}`;
		} else {
			result.push(part.charAt(0).toUpperCase() + part.slice(1));
		}
	}
	return result.join(" ");
}
