/**
 * Two machines' homes and a bare origin, for carrying work between them
 * through real git: a fake exec would answer whatever it was told and
 * prove nothing about a bundle or a patch.
 */

import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnExec } from "../../../../../lib/core/exec/index.ts";
import { freshRepo, git } from "../../../../support/git-fixture.ts";

const run = promisify(execFile);

/** git as the library runs it: unattended, never prompting. */
export const exec = spawnExec();

/** A folder of its own, at its real path; `made` keeps it for removal. */
export function folder(made: string[], name: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `carry-${name}-`)));
	made.push(dir);
	return dir;
}

/** Removes every folder `made` holds. */
export function removeAll(made: string[]): void {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

/** A bare origin holding `main` with one commit. */
export async function bareOrigin(made: string[]): Promise<string> {
	const seed = await freshRepo("carry-seed");
	made.push(seed);
	const origin = join(folder(made, "origin"), "origin.git");
	await run("git", ["clone", "-q", "--bare", seed, origin]);
	return origin;
}

/** A clone of `origin` at `path`, able to commit. */
export async function cloneAt(origin: string, path: string): Promise<string> {
	mkdirSync(join(path, ".."), { recursive: true });
	await run("git", ["clone", "-q", origin, path]);
	await git(path, "config", "user.email", "test@example.com");
	await git(path, "config", "user.name", "Test");
	await git(path, "config", "commit.gpgsign", "false");
	return path;
}

/** Commits `file` holding `text` in the tree at `path`. */
export async function commit(
	path: string,
	file: string,
	text: string,
): Promise<string> {
	writeFileSync(join(path, file), text);
	await git(path, "add", file);
	await git(path, "commit", "-q", "-m", `add ${file}`);
	return git(path, "rev-parse", "HEAD");
}
