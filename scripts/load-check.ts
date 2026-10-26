/**
 * Load this package through pi, the way a person who installs it would.
 *
 * Three missing runtime dependencies once stopped the package loading
 * on a laptop, one of them badly enough that its owner uninstalled it.
 * Lint, typecheck and the suite all run with every dependency
 * installed, dev ones included, so none of them can see a package that
 * only loads because a devDependency happens to be there.
 *
 * With `--production` this copies the files git would hand pi into a
 * scratch directory, installs them with the exact command pi runs for a
 * git package (production dependencies only, peers not auto-installed),
 * and loads that copy. Without it, it loads the checkout as it stands,
 * which is what the `reload` tool checks before it swaps a tree in.
 *
 * Run it from the package root (Node strips the types):
 *
 *   node scripts/load-check.ts [--production] [package-root]
 *
 * A native module whose build pnpm skipped loads nothing until it is
 * imported, which may be long after load, so either way the check also
 * fails when the install skipped a build.
 *
 * Exits 0 when every extension loads, 1 when any does not.
 */

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { packageName, skippedBuilds } from "../lib/internal/install/builds.ts";
import { checkLoad, describeLoad } from "../lib/internal/reload/load-check.ts";

/** What pi runs to install a git package's dependencies under pnpm. */
const PI_GIT_INSTALL = [
	"install",
	"--prod",
	"--config.auto-install-peers=false",
	"--config.strict-peer-dependencies=false",
	"--config.strict-dep-builds=false",
];

/** The pi entry script this checkout's devDependency provides. */
function piEntry(root: string): string {
	const dir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const bin =
		typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
	if (typeof bin !== "string") throw new Error(`${dir} names no pi binary`);
	return join(dir, bin);
}

/** Copy what git would check out, tracked and new files alike, into `to`. */
function copyCheckout(from: string, to: string): void {
	const listed = execFileSync(
		"git",
		[
			"-C",
			from,
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	for (const file of listed.split("\0").filter(Boolean)) {
		const target = join(to, file);
		mkdirSync(dirname(target), { recursive: true });
		try {
			copyFileSync(join(from, file), target);
		} catch {
			// A file git still lists but the tree has deleted: not part of it.
		}
	}
}

/** Says which builds the install in `root` skipped; true when none. */
function builtAll(root: string): boolean {
	const skipped = skippedBuilds(root);
	if (skipped.length === 0) return true;
	const names = skipped.map(packageName);
	console.log(
		`The install skipped building ${skipped.join(", ")}. Allow ${names.join(", ")} in package.json's pnpm.onlyBuiltDependencies.`,
	);
	return false;
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const production = args.includes("--production");
	const root = resolve(args.find((arg) => !arg.startsWith("--")) ?? ".");
	const pi = { node: process.execPath, entry: piEntry(root) };

	if (!production) {
		const report = await checkLoad(pi, root);
		console.log(describeLoad(report, root));
		return builtAll(root) && report.ok ? 0 : 1;
	}

	const scratch = mkdtempSync(join(tmpdir(), "load-check-"));
	try {
		copyCheckout(root, scratch);
		console.log(`Installing as pi would: pnpm ${PI_GIT_INSTALL.join(" ")}`);
		execFileSync("pnpm", PI_GIT_INSTALL, { cwd: scratch, stdio: "inherit" });
		const report = await checkLoad(pi, scratch);
		console.log(describeLoad(report, "The production install"));
		return builtAll(scratch) && report.ok ? 0 : 1;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

process.exitCode = await main();
