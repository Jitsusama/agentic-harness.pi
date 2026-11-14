/**
 * The fence's pre-flight, run from an ordinary attended pi session on
 * the machine the fence installs to, before it installs: every check in
 * `lib/internal/fence-preflight-checks.ts`, fenced as that session's
 * commands would be. Any failure stops the install (ISXEG8, 14 November).
 *
 * It prints a line a check as each ends, then a summary, and answers 0
 * when every check passed, 1 when any failed, and 2 when none failed
 * but some name a step only a session can take with its own tools.
 *
 * Node runs it as it stands, stripping the types:
 *
 *   node scripts/fence-preflight.ts [--core-tree <path>] [--heavy] [--only 1,7a,13b]
 *
 * --core-tree names a held core.nix tree for the checks that need one;
 * --heavy also runs those that send builds to the builders or download
 * a lot; --only runs the checks named.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	exitStatus,
	reportLine,
	runChecks,
	summary,
} from "../lib/internal/fence-preflight.ts";
import { CHECKS } from "../lib/internal/fence-preflight-checks.ts";

/** The value after `flag` in the arguments, if given. */
function option(args: readonly string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: readonly string[]): Promise<number> {
	const session = process.env.PI_SESSION_ID;
	if (!session) {
		process.stderr.write(
			"fence-preflight: run it from a pi session, whose fence the checks use (PI_SESSION_ID is unset).\n",
		);
		return 1;
	}
	const only = option(args, "--only")?.split(",");
	const checks = only
		? CHECKS.filter((check) => only.includes(check.id))
		: CHECKS;
	const scratch = mkdtempSync(join(tmpdir(), "fence-preflight-"));
	try {
		const verdicts = await runChecks(
			checks,
			{
				session,
				repo: join(dirname(fileURLToPath(import.meta.url)), ".."),
				scratch,
				coreTree: option(args, "--core-tree"),
				heavy: args.includes("--heavy"),
			},
			(check, verdict) =>
				process.stdout.write(`${reportLine(check, verdict)}\n`),
		);
		process.stdout.write(`${summary(verdicts)}\n`);
		return exitStatus(verdicts);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

process.exitCode = await main(process.argv.slice(2));
