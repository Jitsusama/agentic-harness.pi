/** Hosted review calls resolve the caller's checkout, never the host's. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSession } from "../../../extensions/review-integration/engine.ts";
import {
	clearReviewProviders,
	clearTargetBindings,
} from "../../../lib/core/review/index.ts";
import {
	type Host,
	installHost,
	releaseSession,
	withSession,
} from "../../../lib/core/session/index.ts";
import { activate, HEADLESS, toolNamed } from "../support/review-extension.ts";

let root: string;
let removeHost: () => void;
const open = new Set<string>();
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "review-cwd-"));
	vi.stubEnv("XDG_STATE_HOME", root);
	open.add("a");
	open.add("b");
	const host: Host = {
		kind: "pi-durable",
		key: "review-test",
		owner: { pid: process.pid, startedAt: 1000 },
		holds: (id) => (open.has(id) ? "idle" : undefined),
		env: () => {
			throw new Error("review resolution needs no environment");
		},
		hints: () => ({}),
		close: (id) => {
			open.delete(id);
			releaseSession(id);
		},
		stamp: () => {},
	};
	removeHost = installHost(host);
});
afterEach(() => {
	releaseSession("a");
	releaseSession("b");
	removeHost();
	open.clear();
	rememberSession(undefined);
	clearReviewProviders();
	clearTargetBindings();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const calls = [
	{ tool: "review", action: "capabilities" },
	{ tool: "review_see", action: "change" },
	{
		tool: "review_say",
		action: "comment",
		body: "Not sent for a local range.",
	},
	{ tool: "review_draft", action: "open" },
	{ tool: "review_offer", action: "ready" },
	{ tool: "review_ask", action: "runs" },
];

describe("review checkout resolution", () => {
	it.each(
		calls,
	)("$tool uses each hosted conversation's cwd", async (params) => {
		const a = join(root, "a");
		const b = join(root, "b");
		const stub = withSession("a", () =>
			activate({
				[`-C ${a} rev-parse --show-toplevel`]: { stdout: `${a}\n` },
				[`-C ${b} rev-parse --show-toplevel`]: { stdout: `${b}\n` },
			}),
		);
		const tool = toolNamed(stub, params.tool);
		const call = (id: string, cwd: string) =>
			withSession(id, () =>
				tool.execute(
					"cwd",
					{ ...params, base: "main", head: "topic" },
					undefined,
					undefined,
					{
						...HEADLESS,
						cwd,
						sessionManager: { getSessionId: () => id },
					},
				),
			);
		await Promise.all([call("a", a), call("b", b)]);

		const probes = stub.commands.filter((argv) =>
			argv.includes("--show-toplevel"),
		);
		expect(probes).toContainEqual([
			"git",
			"-C",
			a,
			"rev-parse",
			"--show-toplevel",
		]);
		expect(probes).toContainEqual([
			"git",
			"-C",
			b,
			"rev-parse",
			"--show-toplevel",
		]);
		expect(probes.some((argv) => argv.includes(process.cwd()))).toBe(false);
		open.delete("a");
		releaseSession("a");
		stub.commands.length = 0;

		await call("b", b);

		expect(stub.commands).toContainEqual([
			"git",
			"-C",
			b,
			"rev-parse",
			"--show-toplevel",
		]);
		expect(stub.commands.some((argv) => argv.includes(a))).toBe(false);
	});

	it("an explicitly named checkout outranks the conversation cwd", async () => {
		const elsewhere = join(root, "elsewhere");
		const stub = withSession("a", () =>
			activate({
				[`-C ${elsewhere} rev-parse --show-toplevel`]: {
					stdout: `${elsewhere}\n`,
				},
			}),
		);
		await withSession("b", () =>
			toolNamed(stub, "review").execute(
				"explicit",
				{ action: "capabilities", repo: elsewhere },
				undefined,
				undefined,
				{ ...HEADLESS, cwd: join(root, "b") },
			),
		);

		expect(stub.commands).toContainEqual([
			"git",
			"-C",
			elsewhere,
			"rev-parse",
			"--show-toplevel",
		]);
	});
});
