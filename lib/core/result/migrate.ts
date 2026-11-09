/** Preserve cited results when upgrading from the pid-only or pid/session layouts. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	LEGACY_RESULT_ROOT,
	openSessionStore,
	sessionResultDir,
} from "./location.ts";
import { MINTED_HANDLE_SHAPE } from "./store.ts";

const MARKER = ".legacy-imported";

/**
 * Copy only legacy handles this conversation already cites, once per session.
 * Originals remain for other pre-upgrade conversations and dead-pid reaping.
 */
export function adoptLegacyResults(
	ctx: Pick<ExtensionContext, "sessionManager">,
): void {
	const legacy = path.join(LEGACY_RESULT_ROOT, String(process.pid));
	const dir = sessionResultDir(ctx);
	const marker = path.join(dir, MARKER);
	if (!fs.existsSync(legacy) || fs.existsSync(marker)) return;
	const scoped = path.join(
		legacy,
		encodeURIComponent(ctx.sessionManager.getSessionId()),
	);
	// W5 already adopted the old shared cache; never bring back its evicted payloads.
	const sources = fs.existsSync(path.join(scoped, MARKER))
		? [scoped]
		: [scoped, legacy];
	const cited = new Set(
		JSON.stringify(ctx.sessionManager.getBranch()).match(
			new RegExp(MINTED_HANDLE_SHAPE, "g"),
		) ?? [],
	);
	const store = openSessionStore(ctx);
	let imported = false;
	for (const handle of cited) {
		try {
			for (const source of sources) {
				const file = path.join(source, `${handle}.json`);
				if (!fs.existsSync(file)) continue;
				if (!store.has(handle)) store.put(fs.readFileSync(file, "utf-8"));
				imported = true;
				break;
			}
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
