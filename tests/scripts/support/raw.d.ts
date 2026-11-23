/**
 * A file imported as its text through Vite's `?raw`, as the check-there
 * tests import the script they run, so vitest's import graph reaches it.
 */
declare module "*?raw" {
	const text: string;
	export default text;
}
