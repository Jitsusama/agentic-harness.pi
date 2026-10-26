/**
 * Whether a value parsed from JSON, or handed over by pi, is an object whose
 * keys can be read by name. An array is not: every caller goes on to read
 * named fields, which an array never has.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
