// A vitest reporter for `pnpm test:host`, failing the run when any host case skipped, naming each and why.
/**
 * `pnpm test:host` is the host's one gate, and no CI runs it, so a case
 * that skipped there is a check nobody made. An ordinary run skips a host
 * case saying which build to point it at; under this reporter any skip,
 * for want of a pi, a hook the pi lacks or a flag, fails the run and is
 * listed with its note. On a Mac, a case whose meta names Linux as the
 * only platform it runs on (only-on.mts) is the one skip let by, listed as
 * such, so the Mac's run proves the rest. On Linux nothing is let by:
 * optimus is the only platform whose run clears a merge, so every case
 * must run there, and a case marked as only a Mac's, or any other
 * platform's, is refused like any other skip (LINUX_ONLY_ON_A_MAC).
 */
import { relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import { letsBy, ONLY_ON_KEY } from "../../../../host/service/proof.ts";

/** A case as the reporter reads it: its name, how it ended and its meta. */
interface Ended {
	readonly fullName: string;
	result(): { readonly state: string; readonly note?: string | undefined };
	meta(): { readonly [ONLY_ON_KEY]?: unknown };
}

/** A test file as the reporter reads it. */
interface Ran {
	readonly moduleId: string;
	readonly children: { allTests(): Iterable<Ended> };
}

/** The cases that skipped, split by whether the run may let them by. */
export interface Skips {
	/** Each that skipped but as LINUX_ONLY_ON_A_MAC lets by, failing the run. */
	readonly refused: string[];
	/** Each only Linux runs, skipped on a Mac. */
	readonly elsewhere: string[];
}

/**
 * Each case that skipped, as a line naming its file (from `root`, when
 * given), its name and why, split by whether it is a case only Linux
 * runs while `platform` is a Mac's.
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
			const only = test.meta()[ONLY_ON_KEY];
			if (letsBy(only, platform)) elsewhere.push(line);
			else refused.push(line);
		}
	return { refused, elsewhere };
}

/** Fails the run, listing them, when any case skipped but one only Linux runs on a Mac. */
export default class EveryCaseRan implements Reporter {
	onTestRunEnd(modules: readonly TestModule[]): void {
		const { refused, elsewhere } = skipsIn(modules, process.cwd());
		if (elsewhere.length > 0)
			// biome-ignore lint/suspicious/noConsole: the gate says what it let by, as vitest's own reporters do.
			console.info(
				`pnpm test:host let by ${elsewhere.length} only Linux runs:\n${indented(elsewhere)}`,
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
