/**
 * Rollover in a multi-session host: a conversation's auth is put back
 * into its own environment rather than the process's, and rolling over
 * is the host's to do, so it never happens from inside a conversation.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTH_PUT_BACK,
	HOSTED_ROLLOVER,
	restoreModelBeforeTurn,
	rollOverNow,
	rollsOver,
} from "../../../extensions/rollover-workflow/index.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import {
	forgetAuth,
	rememberAuth,
} from "../../../lib/internal/session/carried-model.ts";
import { installTestHost } from "../../support/session-host.ts";

/** The variable the provider's key names, never set by anything else. */
const KEY = "ROLLOVER_HOSTED_TEST_KEY";
const PROVIDER = "proxied";

/** A conversation on a model whose provider pi can no longer find auth for. */
function conversation(id: string) {
	const entries: { type: string; data: unknown }[] = [];
	const pi = {
		setModel: async () => true,
		getThinkingLevel: () => "high" as const,
		setThinkingLevel: () => {},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
		events: createEventBus(),
		registerProvider: () => {},
	};
	const ctx = {
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => `/sessions/${id}.jsonl`,
			getBranch: () => [],
		},
		model: { provider: PROVIDER, id: "faux-1" },
		modelRegistry: {
			getProviderAuth: async () => undefined,
			getRegisteredProviderConfig: () => undefined,
			getProviderAuthStatus: () => ({}),
		},
		hasUI: true,
		ui: { notify: () => {} },
	};
	// Only what setting a model back reads of pi and the context.
	return {
		pi: pi as unknown as Parameters<typeof restoreModelBeforeTurn>[0],
		ctx: ctx as unknown as Parameters<typeof restoreModelBeforeTurn>[1] &
			Parameters<typeof rollOverNow>[1],
		entries,
	};
}

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
	forgetAuth();
	delete process.env[KEY];
});

describe("rollover in a host", () => {
	it("puts a conversation's auth back in its own environment only", async () => {
		const test = installTestHost();
		dispose = test.dispose;
		const a = conversation("a");
		await withSession("a", async () => {
			rememberAuth(PROVIDER, { variables: { [KEY]: "secret-a" } });
			await restoreModelBeforeTurn(a.pi, a.ctx);
		});
		expect(test.host.env("a").get(KEY), "A's key is back in A").toBe(
			"secret-a",
		);
		expect(test.host.env("b").get(KEY), "B is given nothing of A's").toBe(
			undefined,
		);
		expect(process.env[KEY], "the process is given nothing").toBe(undefined);
		expect(
			a.entries.find((entry) => entry.type === AUTH_PUT_BACK)?.data,
		).toMatchObject({ put: [KEY] });
	});

	it("never rolls over, by itself or when asked", async () => {
		const test = installTestHost();
		dispose = test.dispose;
		const a = conversation("a");
		expect(rollsOver(a.ctx, { PI_ROLLOVER: "on" })).toBe("off");
		const said = await withSession("a", () =>
			rollOverNow(a.pi as Parameters<typeof rollOverNow>[0], a.ctx),
		);
		expect(said).toBe(HOSTED_ROLLOVER);
	});
});

describe("rollover on plain pi", () => {
	it("puts auth back in the process's environment, as before", async () => {
		const a = conversation("a");
		rememberAuth(PROVIDER, { variables: { [KEY]: "secret" } });
		await restoreModelBeforeTurn(a.pi, a.ctx);
		expect(process.env[KEY], "the key is back in the process").toBe("secret");
	});
});
