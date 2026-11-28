/**
 * Makes the strict profile's own folders before a command runs, and
 * refuses one that isn't a plain folder of this account's alone.
 *
 * landrun skips a path that isn't there, and nothing inside could make
 * one, so each folder is made first. Then each is checked without
 * following it: a fenced command, or any caller of pi-fence, can write
 * the sandbox's folder in the home, and could put a link where a
 * session's temporary folder goes; the session's next strict command
 * would then be granted write and run on wherever it leads. So a folder
 * that is a link, or anything but a folder, or another account's,
 * refuses the command. One others may write is narrowed to this
 * account's alone, since a folder made before this check may have taken
 * the umask's mode.
 */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { sandboxFolders } from "./strict-rules.ts";

/** The bits that let anyone but the owner reach a folder. */
const OTHERS = 0o077;

/** How the folders are made and read, so a test can stand in. */
export interface FolderDisk {
	make(folder: string): void;
	/** The folder itself, never what a link leads to; none when missing. */
	look(
		folder: string,
	):
		| { readonly folder: boolean; readonly uid: number; readonly mode: number }
		| undefined;
	narrow(folder: string): void;
	readonly uid: number | undefined;
}

const DISK: FolderDisk = {
	make: (folder) => mkdirSync(folder, { recursive: true, mode: 0o700 }),
	look: (folder) => {
		const seen = lstatSync(folder, { throwIfNoEntry: false });
		return seen === undefined
			? undefined
			: { folder: seen.isDirectory(), uid: seen.uid, mode: seen.mode };
	},
	narrow: (folder) => chmodSync(folder, 0o700),
	uid: process.getuid?.(),
};

/**
 * Makes the sandbox's folders for the home `home` and the session `env`
 * names, answering why no command may run when one can't be made or
 * isn't a plain folder of this account's, or nothing when all are.
 */
export function makeSandboxFolders(
	home: string,
	env: NodeJS.ProcessEnv,
	disk: FolderDisk = DISK,
): string | undefined {
	for (const folder of Object.values(sandboxFolders(home, env))) {
		try {
			disk.make(folder);
		} catch (error) {
			return `the strict sandbox couldn't make its folder ${folder} (${String(error)}), so no command runs`;
		}
		const seen = disk.look(folder);
		if (seen === undefined || !seen.folder) {
			return `the strict sandbox's folder ${folder} is a link or not a folder, so no command runs: remove it and try again`;
		}
		if (disk.uid !== undefined && seen.uid !== disk.uid) {
			return `the strict sandbox's folder ${folder} belongs to another account, so no command runs`;
		}
		if ((seen.mode & OTHERS) === 0) continue;
		try {
			disk.narrow(folder);
		} catch (error) {
			return `the strict sandbox's folder ${folder} is open to other accounts and couldn't be narrowed (${String(error)}), so no command runs`;
		}
	}
	return undefined;
}
