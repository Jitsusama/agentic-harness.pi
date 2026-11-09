/** A live upgrade retains only legacy payloads the conversation already cited. */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupSessionResults,
	LEGACY_RESULT_ROOT,
	openSessionStore,
} from "../../../lib/core/result/location.ts";
import { adoptLegacyResults } from "../../../lib/core/result/migrate.ts";
import { createResultStore } from "../../../lib/core/result/store.ts";
import { resultSession } from "../../support/result-session.ts";

const sessions: ReturnType<typeof resultSession>[] = [];
const files: string[] = [];
afterEach(() => {
	for (const ctx of sessions.splice(0)) cleanupSessionResults(ctx);
	for (const file of files.splice(0)) rmSync(file, { force: true });
});
function session() {
	const ctx = resultSession();
	sessions.push(ctx);
	return ctx;
}
describe("legacy result adoption", () => {
	it("keeps cited handles after upgrade without sharing uncited payloads", () => {
		const a = session();
		const b = session();
		const legacy = createResultStore({
			dir: join(LEGACY_RESULT_ROOT, String(process.pid)),
		});
		const payload = legacy.put(
			JSON.stringify({ session: a.sessionManager.getSessionId() }),
		);
		files.push(payload.path);
		a.sessionManager.appendMessage({
			role: "user",
			content: `Query handle ${payload.handle}`,
			timestamp: Date.now(),
		});
		adoptLegacyResults(a);
		adoptLegacyResults(b);
		expect(openSessionStore(a).read(payload.handle)).toContain(
			a.sessionManager.getSessionId(),
		);
		expect(
			openSessionStore(b).has(payload.handle),
			"an uncited legacy handle is not imported into B",
		).toBe(false);
		expect(
			existsSync(payload.path),
			"the legacy original remains for other pre-upgrade conversations",
		).toBe(true);
		cleanupSessionResults(b);
		expect(
			openSessionStore(a).has(payload.handle),
			"B cleanup preserves A's imported handle",
		).toBe(true);
	});

	it("adopts from the pid/session layout without reopening the pid-only cache it already adopted", () => {
		const ctx = session();
		const pidOnly = join(LEGACY_RESULT_ROOT, String(process.pid));
		const scoped = join(
			pidOnly,
			encodeURIComponent(ctx.sessionManager.getSessionId()),
		);
		const evicted = createResultStore({ dir: pidOnly }).put("evicted");
		const kept = createResultStore({ dir: scoped }).put("kept");
		const marker = join(scoped, ".legacy-imported");
		writeFileSync(marker, "");
		files.push(evicted.path, kept.path, marker);
		ctx.sessionManager.appendMessage({
			role: "user",
			content: `${evicted.handle} ${kept.handle}`,
			timestamp: Date.now(),
		});
		adoptLegacyResults(ctx);
		expect(openSessionStore(ctx).read(kept.handle)).toBe("kept");
		expect(
			openSessionStore(ctx).has(evicted.handle),
			"a handle W5 evicted from its session is not re-read from the pid-only cache",
		).toBe(false);
	});

	it("does not resurrect results later evicted by the session quota", () => {
		const ctx = session();
		const legacy = createResultStore({
			dir: join(LEGACY_RESULT_ROOT, String(process.pid)),
		});
		const payload = legacy.put(ctx.sessionManager.getSessionId());
		files.push(payload.path);
		ctx.sessionManager.appendMessage({
			role: "user",
			content: payload.handle,
			timestamp: Date.now(),
		});
		adoptLegacyResults(ctx);
		const migrated = openSessionStore(ctx).put(
			ctx.sessionManager.getSessionId(),
		);
		rmSync(migrated.path);
		adoptLegacyResults(ctx);
		expect(
			openSessionStore(ctx).has(payload.handle),
			"a previously imported and evicted handle is not resurrected",
		).toBe(false);
	});
});
