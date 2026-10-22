/**
 * How the browser tools reach the model: loaded when a session needs
 * them rather than declared on every turn. Their four declarations
 * run about 28,000 characters, and from 8 October they were called in
 * 15 of 77 sessions. Reading the browser-guide skill loads all four.
 */

export const BROWSER_EXPOSURE = {
	exposure: "deferred",
	namespace: {
		name: "browser",
		description: "Drive a real browser: open pages, act on them and check them",
	},
} as const;
