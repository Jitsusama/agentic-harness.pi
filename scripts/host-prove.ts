/**
 * Prove a pi runtime for the hosts: run `pnpm test:host` on it, exactly
 * as that script runs, and only once every case has run and passed,
 * write its proof (host/service/proof.ts) and move the runtime link the
 * host checks read to it. Node runs it as it stands, from a clean
 * checkout of the harness:
 *
 *   node scripts/host-prove.ts RUNTIME [--proof FILE]
 *
 * RUNTIME is a piHostRuntime build's store path, or a link to one. The
 * proof goes to FILE, the file World's bump commits beside the runtime's
 * path, or to standard output. The link is $XDG_STATE_HOME/pi-host/runtime,
 * a GC root. Exits 0 once proven, 1 when the run fails, skips a case or
 * can't be judged, and changes nothing then.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
	type HostProof,
	PROOF_KIND,
	PROOF_VERSION,
	provenBy,
	type RunSummary,
} from "../host/service/proof.ts";
import { isRecord } from "../lib/internal/record.ts";

const HARNESS = join(import.meta.dirname, "..");

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { proof: { type: "string" } },
});

const [named, ...extra] = positionals;
if (!named || extra.length > 0)
	refuse(
		"Name one runtime to prove: node scripts/host-prove.ts RUNTIME [--proof FILE]",
	);
if (!existsSync(named)) refuse(`${named} doesn't exist`);

const runtime = realpathSync(named);
if (!existsSync(join(runtime, "lib", "node_modules", "pi-monorepo")))
	refuse(`${runtime} holds no pi-monorepo, so it isn't a pi runtime`);

const changed = git("status", "--porcelain", "--untracked-files=no");
if (changed)
	refuse(
		`The harness at ${HARNESS} has uncommitted changes, so no commit would say what proved it:\n${changed}`,
	);
const harness = git("rev-parse", "HEAD");

const scratch = mkdtempSync(join(tmpdir(), "host-prove-"));
const report = join(scratch, "report.json");
const env: NodeJS.ProcessEnv = { ...process.env, PI_HOST_RUNTIME: runtime };
// A pi named outright would be tested in the runtime's place.
delete env.PI_HOST_PACKAGE_DIR;
const ran = spawnSync(
	"pnpm",
	[
		"--silent",
		"run",
		"test:host",
		"--reporter=json",
		`--outputFile.json=${report}`,
	],
	{ cwd: HARNESS, env, stdio: "inherit" },
);

const verdict =
	ran.status === 0
		? judged(report)
		: `pnpm test:host exited ${String(ran.status ?? ran.signal)}`;
rmSync(scratch, { recursive: true, force: true });

if (typeof verdict === "string") {
	process.stderr.write(`host-prove: ${runtime} isn't proven: ${verdict}\n`);
	process.exitCode = 1;
} else {
	const proof: HostProof = {
		kind: PROOF_KIND,
		version: PROOF_VERSION,
		runtime,
		harness,
		...verdict,
		provenAt: new Date().toISOString(),
	};
	const text = `${JSON.stringify(proof, null, "\t")}\n`;
	if (values.proof) writeFileSync(values.proof, text);
	else process.stdout.write(text);
	const link = runtimeLink();
	mkdirSync(dirname(link), { recursive: true });
	execFileSync("nix-store", ["--realise", runtime, "--add-root", link], {
		stdio: ["ignore", "ignore", "inherit"],
	});
	process.stderr.write(
		`host-prove: ${runtime} passed ${proof.cases} cases in ${proof.files} files; ${link} names it now\n`,
	);
}

/** Say why nothing was proven, before anything ran or changed, and exit 1. */
function refuse(reason: string): never {
	process.stderr.write(`host-prove: ${reason}\n`);
	process.exit(1);
}

/** What the run's JSON report proves, or why it proves nothing. */
function judged(file: string): ReturnType<typeof provenBy> {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return "the run wrote no report to judge";
	}
	return isSummary(value) ? provenBy(value) : "the run's report isn't vitest's";
}

function isSummary(value: unknown): value is RunSummary {
	return (
		isRecord(value) &&
		typeof value.success === "boolean" &&
		Array.isArray(value.testResults) &&
		[
			value.numTotalTests,
			value.numPassedTests,
			value.numFailedTests,
			value.numPendingTests,
			value.numTodoTests,
		].every((count) => typeof count === "number")
	);
}

/** The link the host checks find the latest proven runtime at. */
function runtimeLink(): string {
	const state =
		process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(state, "pi-host", "runtime");
}

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: HARNESS, encoding: "utf8" }).trim();
}
