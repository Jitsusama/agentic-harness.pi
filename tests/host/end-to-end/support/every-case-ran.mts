// A vitest reporter for `pnpm test:host`, failing the run when any host case skipped, naming each and why.
/**
 * `pnpm test:host` is the host's one gate, and no CI runs it, so a case
 * that skipped there is a check nobody made. An ordinary run skips a host
 * case saying which build to point it at; under this reporter any skip,
 * for want of a pi, a hook the pi lacks or a flag, fails the run and is
 * listed with its note.
 */
import { relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";

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

/** Each case that skipped, as a line naming its file (from `root`, when given), its name and why. */
export function skipsIn(modules: readonly Ran[], root = ""): string[] {
	const skipped: string[] = [];
	for (const module of modules)
		for (const test of module.children.allTests()) {
			const result = test.result();
			if (result.state === "skipped")
				skipped.push(
					`${root ? relative(root, module.moduleId) : module.moduleId}: ${test.fullName}: ${result.note ?? "skipped, saying nothing of why"}`,
				);
		}
	return skipped;
}

/** Fails the run, listing them, when any case skipped. */
export default class EveryCaseRan implements Reporter {
	onTestRunEnd(modules: readonly TestModule[]): void {
		const skipped = skipsIn(modules, process.cwd());
		if (skipped.length === 0) return;
		// biome-ignore lint/suspicious/noConsole: the gate says what it refused, as vitest's own reporters do.
		console.error(
			`pnpm test:host runs every host case; ${skipped.length} skipped:\n${skipped.map((line) => `  ${line}`).join("\n")}`,
		);
		process.exitCode = 1;
	}
}
