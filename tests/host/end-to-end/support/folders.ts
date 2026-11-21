/**
 * Working folders for a seal's conversations, and pi's trust store in its
 * agent folder, which decides whether pi asks to trust one. pi counts any
 * .agents/skills above a folder but HOME's as the project's, and a seal
 * may sit under a home holding one, as a quest's TMPDIR does, so a folder
 * a case means to open without asking is trusted as its person would
 * have trusted it.
 *
 * The host loads code a folder's .pi holds only as it was allowed, so a
 * case that writes code into a folder after its host first looked, and
 * means it to load as a person's yes would let it, allows it first.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pin, projectCode } from "../../../../host/engine/project-code.ts";
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
	/** Allow the code `cwd`'s .pi holds now, as a person's yes to it would. */
	allowCode(cwd: string): string;
}

/** Working folders under `seal`'s root, judged by the trust store in its agent folder. */
export function folders(seal: Seal): Folders {
	const agentDir = join(seal.home, ".pi", "agent");
	const file = join(agentDir, "trust.json");
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
		allowCode(cwd) {
			const code = projectCode(cwd);
			if (!code) throw new Error(`${cwd}'s .pi holds no code to allow`);
			mkdirSync(agentDir, { recursive: true });
			pin(cwd, agentDir, code);
			return cwd;
		},
	};
}
