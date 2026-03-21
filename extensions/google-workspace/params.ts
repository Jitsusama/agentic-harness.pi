/**
 * Type-safe parameter extraction helpers that use proper type
 * guards instead of unsafe casts.
 */

import type { ActionParams } from "./router.js";

/**
 * Extract a string parameter, returning undefined if not present or wrong type.
 */
export function getStringParam(
	params: ActionParams,
	key: string,
): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Extract a number parameter, returning undefined if not present or wrong type.
 */
export function getNumberParam(
	params: ActionParams,
	key: string,
): number | undefined {
	const value = params[key];
	return typeof value === "number" ? value : undefined;
}

/**
 * Extract a boolean parameter, returning undefined if not present or wrong type.
 */
export function getBooleanParam(
	params: ActionParams,
	key: string,
): boolean | undefined {
	const value = params[key];
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Extract a string array parameter, returning undefined if not present or wrong type.
 */
export function getStringArrayParam(
	params: ActionParams,
	key: string,
): string[] | undefined {
	const value = params[key];
	if (!Array.isArray(value)) return undefined;
	// Validate all elements are strings
	return value.every((v) => typeof v === "string")
		? (value as string[])
		: undefined;
}
