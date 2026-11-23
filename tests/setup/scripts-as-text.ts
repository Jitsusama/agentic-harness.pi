/**
 * Shell scripts imported as their text, so a test can import the script
 * it runs. Not written yet.
 */

/** The loader, to be given to each vitest project. */
export function scriptsAsText(): {
	name: string;
	enforce?: "pre";
	load(id: string): string | null;
} {
	return { name: "scripts-as-text", load: () => null };
}
