/**
 * Which browser tools a session carries.
 *
 * Every active tool's definition is sent at the front of every request.
 * The four browser tools are the largest definitions in the package,
 * about 28,000 characters together, and in the month measured 47 of 61
 * sessions never called one. So a session carries them only once browser
 * work starts: the browser skill is read, which the skill list and the
 * tools' own descriptions send the model to first, or the session has
 * already called a browser tool, so a reload in the middle of a task
 * does not take them away.
 *
 * Switching tools on mid-session rewrites the prompt cache once, since
 * definitions lead the prompt, which happens once when the work begins.
 */

export const BROWSER_TOOLS: readonly string[] = [
	"browser_go",
	"browser_see",
	"browser_do",
	"browser_check",
];

const BROWSER: ReadonlySet<string> = new Set(BROWSER_TOOLS);

/** Directories of the skills that start browser work. */
const BROWSER_SKILL_DIRS: readonly string[] = [
	"/skills/browser-guide/",
	"/skills/browser-accessibility-guide/",
];

/**
 * The active tool list with the browser tools set for whether browser
 * work has started. Every other tool is left exactly as it was, in
 * order, so another extension's choices are neither undone nor
 * overridden.
 */
export function browserToolSurface(
	active: readonly string[],
	registered: readonly string[],
	engaged: boolean,
): string[] {
	const others = active.filter((name) => !BROWSER.has(name));
	const browser = engaged ? registered.filter((name) => BROWSER.has(name)) : [];
	return [...others, ...browser];
}

/** Whether a tool call reads one of the browser skills. */
export function readsBrowserSkill(toolName: string, input: unknown): boolean {
	if (toolName !== "read") return false;
	if (typeof input !== "object" || input === null || !("path" in input)) {
		return false;
	}
	const { path } = input;
	return (
		typeof path === "string" &&
		BROWSER_SKILL_DIRS.some((dir) => path.includes(dir))
	);
}

/** Whether a session's history already has a browser tool call in it. */
export function calledBrowserBefore(toolNames: readonly string[]): boolean {
	return toolNames.some((name) => BROWSER.has(name));
}
