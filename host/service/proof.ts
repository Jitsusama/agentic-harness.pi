/**
 * A pi runtime's proof: what scripts/host-prove.ts writes once `pnpm
 * test:host` has passed on that runtime with no case skipped, and what a
 * host won't start without. World's bump writes it beside the runtime's
 * store path, core's host module refuses at evaluation a runtime the
 * proof doesn't name, and the host program checks it again as it starts.
 * Between them, no pi reaches a host unproven.
 *
 * It proves the pi, not the harness. The harness commit it names is only
 * a record of what ran; a harness change passes its own `pnpm test:host`
 * before it merges.
 */

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isRecord } from "../../lib/internal/record.ts";

/** The variable a host unit names its runtime's proof in. */
export const PROOF_VARIABLE = "PI_HOST_PROOF";

/** What a proof file says it is, so another JSON file isn't read as one. */
export const PROOF_KIND = "pi-host-runtime-proof";

/** The proof format this harness writes and reads. */
export const PROOF_VERSION = 1;

/** That a runtime passed every host check. */
export interface HostProof {
	readonly kind: typeof PROOF_KIND;
	readonly version: typeof PROOF_VERSION;
	/** The runtime's store path, the folder its pi-monorepo is under. */
	readonly runtime: string;
	/** The harness commit whose `pnpm test:host` passed on it. */
	readonly harness: string;
	/** How many test files ran, and how many cases, every one passing. */
	readonly files: number;
	readonly cases: number;
	/** When it passed, as an ISO time. */
	readonly provenAt: string;
}

/** The part of vitest's JSON report a proof is judged from. */
export interface RunSummary {
	readonly success: boolean;
	readonly numTotalTests: number;
	readonly numPassedTests: number;
	readonly numFailedTests: number;
	readonly numPendingTests: number;
	readonly numTodoTests: number;
	readonly testResults: readonly unknown[];
}

/** A proof as a file holds it, or why it isn't one. */
export function parseProof(text: string): HostProof {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("The runtime's proof isn't JSON");
	}
	if (!isRecord(value) || value.kind !== PROOF_KIND)
		throw new Error(`The runtime's proof isn't a ${PROOF_KIND}`);
	if (value.version !== PROOF_VERSION)
		throw new Error(
			`The runtime's proof is version ${String(value.version)}; this host reads ${PROOF_VERSION}`,
		);
	const { runtime, harness, files, cases, provenAt } = value;
	if (
		!(
			typeof runtime === "string" &&
			isAbsolute(runtime) &&
			typeof harness === "string" &&
			typeof files === "number" &&
			typeof cases === "number" &&
			typeof provenAt === "string"
		)
	)
		throw new Error(
			"The runtime's proof lacks its runtime, harness, counts or time",
		);
	return {
		kind: PROOF_KIND,
		version: PROOF_VERSION,
		runtime,
		harness,
		files,
		cases,
		provenAt,
	};
}

/** The proof a host unit names, read and checked against its pi. */
export function hostProof(
	env: NodeJS.ProcessEnv,
	packageDir: string,
): HostProof {
	const file = env[PROOF_VARIABLE];
	if (!(file && isAbsolute(file)))
		throw new Error(
			`${PROOF_VARIABLE} must name the proof that pnpm test:host passed on this pi; prove it with node scripts/host-prove.ts ${runtimeOf(packageDir)}`,
		);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		throw new Error(`${PROOF_VARIABLE} names ${file}, which can't be read`);
	}
	const proof = parseProof(text);
	const refused = proofRefusal(proof, packageDir);
	if (refused) throw new Error(refused);
	return proof;
}

/** Why a proof doesn't prove this pi, or nothing when it does. */
export function proofRefusal(
	proof: HostProof,
	packageDir: string,
): string | undefined {
	const pi = resolved(packageDir);
	const runtime = resolved(proof.runtime);
	if (pi.startsWith(`${runtime}/`)) return undefined;
	return `The runtime's proof is for ${proof.runtime}, not the pi at ${packageDir}; prove that pi with node scripts/host-prove.ts ${runtimeOf(packageDir)}`;
}

/**
 * Every case ran and passed, as a proof's counts, or why the run proves
 * nothing. A run with no case at all proves nothing either.
 */
export function provenBy(
	summary: RunSummary,
): { files: number; cases: number } | string {
	const skipped = summary.numPendingTests + summary.numTodoTests;
	if (summary.numFailedTests > 0)
		return `${summary.numFailedTests} of ${summary.numTotalTests} cases failed`;
	if (skipped > 0)
		return `${skipped} of ${summary.numTotalTests} cases skipped`;
	if (!summary.success) return "the run failed outside any case";
	if (summary.numTotalTests === 0) return "no case ran";
	if (summary.numPassedTests !== summary.numTotalTests)
		return `${summary.numPassedTests} of ${summary.numTotalTests} cases passed`;
	return { files: summary.testResults.length, cases: summary.numTotalTests };
}

/** The runtime store path a pi-monorepo folder sits in, for a refusal to name. */
export function runtimeOf(packageDir: string): string {
	const store = /^(\/nix\/store\/[^/]+)/.exec(resolved(packageDir));
	return store?.[1] ?? packageDir;
}

/**
 * A path with its links followed as far as it exists, so a pi that isn't
 * there still compares with its runtime through the same links.
 */
function resolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A pi that isn't there is refused by its loader, which says so;
		// here only the folders above it are followed.
		const parent = dirname(path);
		return parent === path ? path : join(resolved(parent), basename(path));
	}
}
