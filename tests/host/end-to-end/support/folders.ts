/**
 * Working folders for a seal's conversations, and pi's trust store in its
 * agent folder, which decides whether pi asks to trust one. pi counts any
 * .agents/skills above a folder but HOME's as the project's, and a seal
 * may sit under a home holding one, as a quest's TMPDIR does, so a folder
 * a case means to open without asking is trusted as its person would
 * have trusted it.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../../../lib/internal/record.ts";
import type { Seal } from "./seal.ts";

/** A seal's working folders, each fresh, named by its real path as pi's store names it. */
export interface Folders {
	/** A folder pi's store trusts, so it opens without asking. */
	trusted(): string;
	/** A folder pi's store says nothing of. */
	untrusted(): string;
	/** What pi's store holds, by folder. */
	store(): Record<string, unknown>;
}

/** Working folders under `seal`'s root, judged by the trust store in its agent folder. */
export function folders(seal: Seal): Folders {
	const file = join(seal.home, ".pi", "agent", "trust.json");
	let made = 0;
	const store = (): Record<string, unknown> => {
		if (!existsSync(file)) return {};
		const held: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isRecord(held) ? held : {};
	};
	const untrusted = () => {
		const path = join(seal.root, `w${++made}`);
		mkdirSync(path);
		return realpathSync(path);
	};
	return {
		trusted() {
			const cwd = untrusted();
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, JSON.stringify({ ...store(), [cwd]: true }));
			return cwd;
		},
		untrusted,
		store,
	};
}
