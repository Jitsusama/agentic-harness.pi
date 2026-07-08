/**
 * Check-command resolution: pick the command the verify layer
 * runs, by precedence. A quest's verify field wins because it
 * is the most specific to the work in hand; then an explicit
 * verify script; then detection of the conventional lint,
 * typecheck and test scripts, joined so all run.
 */

/** Where a check command could come from. */
export interface CheckCommandSources {
	/** A verify command declared in the loaded quest's frontmatter. */
	readonly questVerify?: string;
	/** The scripts block from the project's package.json. */
	readonly packageScripts?: Readonly<Record<string, string>>;
	/** The package manager to invoke scripts with. Defaults to pnpm. */
	readonly packageManager?: string;
}

/** The resolved command and where it came from. */
export interface ResolvedCheck {
	readonly command: string;
	readonly source: "quest" | "script" | "detected";
}

/** Scripts probed for detection, in the order they run. */
const DETECTED_SCRIPTS = ["lint", "typecheck", "test"] as const;

/**
 * Resolve the check command, or null when nothing is
 * available and the caller should degrade to the LSP fast
 * layer alone.
 */
export function resolveCheckCommand(
	sources: CheckCommandSources,
): ResolvedCheck | null {
	const quest = sources.questVerify?.trim();
	if (quest) return { command: quest, source: "quest" };

	const pm = sources.packageManager ?? "pnpm";
	const scripts = sources.packageScripts ?? {};
	if (scripts.verify) {
		return { command: `${pm} run verify`, source: "script" };
	}
	const detected = DETECTED_SCRIPTS.filter((name) => scripts[name]).map(
		(name) => `${pm} run ${name}`,
	);
	if (detected.length === 0) return null;
	return { command: detected.join(" && "), source: "detected" };
}
