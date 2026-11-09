/** Preserve cited results when a live process upgrades from the pid-only layout. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSessionStore, RESULT_ROOT, sessionResultDir } from "./location.ts";
import { MINTED_HANDLE_SHAPE } from "./store.ts";

const MARKER = ".legacy-imported";

/**
 * Copy only legacy handles this conversation already cites, once per session.
 * Originals remain for other pre-upgrade conversations and dead-pid reaping.
 */
export function adoptLegacyResults(
	ctx: Pick<ExtensionContext, "sessionManager">,
): void {
	const legacy = path.join(RESULT_ROOT, String(process.pid));
	const dir = sessionResultDir(ctx);
	const marker = path.join(dir, MARKER);
	if (!fs.existsSync(legacy) || fs.existsSync(marker)) return;
	const cited = new Set(
		JSON.stringify(ctx.sessionManager.getBranch()).match(
			new RegExp(MINTED_HANDLE_SHAPE, "g"),
		) ?? [],
	);
	const store = openSessionStore(ctx);
	let imported = false;
	for (const handle of cited) {
		try {
			const file = path.join(legacy, `${handle}.json`);
			if (!fs.existsSync(file)) continue;
			if (!store.has(handle)) store.put(fs.readFileSync(file, "utf-8"));
			imported = true;
		} catch {
			// Keep the original and retry on the next start if disk access failed.
			return;
		}
	}
	if (!imported) return;
	try {
		fs.writeFileSync(marker, "", { mode: 0o600 });
	} catch {
		// Results are already safe; repeating adoption is harmless.
	}
}
