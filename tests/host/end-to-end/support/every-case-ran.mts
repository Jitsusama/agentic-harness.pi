// A vitest reporter for `pnpm test:host`, failing the run when any host case skipped, naming each and why.
/**
 * `pnpm test:host` is the host's one gate, and no CI runs it, so a case
 * that skipped there is a check nobody made. An ordinary run skips a host
 * case saying which build to point it at; under this reporter any skip,
 * for want of a pi, a hook the pi lacks or a flag, fails the run and is
 * listed with its note. A case only another platform can run (only-on.mts)
 * is the one skip let by, listed as such, so the Mac's run proves the rest.
 */
import { relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import { onlyOnPlatform } from "./only-on.mts";

/** A case as the reporter reads it: its name, and how it ended. */
interface Ended {
	readonly fullName: string;
	result(): { readonly state: string; readonly note?: string | undefined };
}

/** A test file as the reporter reads it. */
interface Ran {
	readonly moduleId: string;
	readonly children: { allTests(): Iterable<Ended> };
}

/** The cases that skipped, split by whether the run may let them by. */
export interface Skips {
	/** Each that skipped with no other platform's leave, failing the run. */
	readonly refused: string[];
	/** Each only another platform than this one can run. */
	readonly elsewhere: string[];
}

/**
 * Each case that skipped, as a line naming its file (from `root`, when
 * given), its name and why, split by whether it runs only on a platform
 * other than `platform`.
 */
export function skipsIn(
	modules: readonly Ran[],
	root = "",
	platform: string = process.platform,
): Skips {
	const refused: string[] = [];
	const elsewhere: string[] = [];
	for (const module of modules)
		for (const test of module.children.allTests()) {
			const result = test.result();
			if (result.state !== "skipped") continue;
			const line = `${root ? relative(root, module.moduleId) : module.moduleId}: ${test.fullName}: ${result.note ?? "skipped, saying nothing of why"}`;
			const only = onlyOnPlatform(result.note);
			if (only !== undefined && only !== platform) elsewhere.push(line);
			else refused.push(line);
		}
	return { refused, elsewhere };
}

/** Fails the run, listing them, when any case skipped but for another platform's. */
export default class EveryCaseRan implements Reporter {
	onTestRunEnd(modules: readonly TestModule[]): void {
		const { refused, elsewhere } = skipsIn(modules, process.cwd());
		if (elsewhere.length > 0)
			// biome-ignore lint/suspicious/noConsole: the gate says what it let by, as vitest's own reporters do.
			console.info(
				`pnpm test:host let by ${elsewhere.length} only another platform runs:\n${indented(elsewhere)}`,
			);
		if (refused.length === 0) return;
		// biome-ignore lint/suspicious/noConsole: the gate says what it refused, as vitest's own reporters do.
		console.error(
			`pnpm test:host runs every host case; ${refused.length} skipped:\n${indented(refused)}`,
		);
		process.exitCode = 1;
	}
}

/** Lines as the reporter lists them, one a line, indented. */
function indented(lines: readonly string[]): string {
	return lines.map((line) => `  ${line}`).join("\n");
}
