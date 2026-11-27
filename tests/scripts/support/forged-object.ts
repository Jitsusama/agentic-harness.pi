/**
 * A loose commit in a checkout's objects folder rewritten to say what it
 * likes, as a session that can write that folder could. Git checks an
 * object's hash only as it takes the object in, never as it reads one, so
 * the commit keeps its id and every read of it gets the forged contents.
 * The merge gates' tests forge a head to hold main's tree and name main as
 * its parent, which reads as no change at all, to hold the gates to
 * reading only objects they hashed themselves.
 */

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { git } from "../../support/git-fixture.ts";

/**
 * Rewrites `commit`, loose in `checkout`'s objects, to hold `main`'s tree
 * and name `main` as its only parent, keeping its id.
 */
export async function forgeAsMerged(
	checkout: string,
	commit: string,
	main: string,
): Promise<void> {
	const common = await git(
		checkout,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	);
	const path = join(common, "objects", commit.slice(0, 2), commit.slice(2));
	if (!existsSync(path)) throw new Error(`${commit} isn't loose in ${common}`);
	const tree = await git(checkout, "rev-parse", `${main}^{tree}`);
	const body = [
		`tree ${tree}`,
		`parent ${main}`,
		"author A <a@example.com> 1 +0000",
		"committer A <a@example.com> 1 +0000",
		"",
		"forged",
		"",
	].join("\n");
	const object = Buffer.concat([
		Buffer.from(`commit ${Buffer.byteLength(body)}\0`),
		Buffer.from(body),
	]);
	// Git writes loose objects read-only, which their owner may still change.
	chmodSync(path, 0o644);
	writeFileSync(path, deflateSync(object));
}
