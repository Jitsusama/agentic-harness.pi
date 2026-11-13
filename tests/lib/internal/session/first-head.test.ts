/**
 * Keeping a session's first head: the request it gives the model says
 * what pi's own head would, and the request it gives Anthropic starts
 * with the system text and tools the provider cached before.
 */

import {
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type Model,
	type SystemMessage,
	type Tool,
} from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	keepHead,
	keptHeadOf,
	MOVE_SHARE,
} from "../../../../lib/internal/session/first-head.ts";

const tool = (name: string): Tool => ({
	name,
	description: `The ${name} tool.`,
	parameters: Type.Object({}),
});

const first: SystemMessage = {
	role: "system",
	content: "You are pi.",
	sections: { tools: "<tools>read, search</tools>", cwd: "<cwd>/src</cwd>" },
	toolsAdded: [tool("read"), tool("search")],
	timestamp: 1,
};

const user = (text: string, at: number): Message => ({
	role: "user",
	content: text,
	timestamp: at,
});

/** A later patch, as pi writes one when a session's tools or sections change. */
const changed: SystemMessage = {
	role: "system",
	content: "",
	sections: { tools: "<tools>read, found</tools>", cwd: null },
	toolsAdded: [tool("found")],
	toolsRemoved: [{ name: "search" }],
	timestamp: 3,
};

/** What pi leads with after a compaction: every system message folded into one. */
const folded = getCurrentSystemMessage([first, changed]) as SystemMessage;
const afterCompaction: Message[] = [
	folded,
	user("summary", 5),
	user("next", 6),
];

describe("keeping the first head", () => {
	it("leads with the first head and a patch to where pi's head stood", () => {
		const kept = keepHead(first, afterCompaction) ?? [];

		expect(kept[0]).toBe(first);
		expect(kept.slice(2)).toEqual(afterCompaction.slice(1));
		expect(getCurrentSystemPrompt(kept)).toBe(
			getCurrentSystemPrompt(afterCompaction),
		);
		expect(getCurrentTools(kept)).toEqual(getCurrentTools(afterCompaction));
	});

	it("leaves a request that already leads with the first head alone", () => {
		const before: Message[] = [first, user("one", 2), changed, user("two", 4)];

		expect(keepHead(first, before)).toBeUndefined();
	});

	it("leaves pi's head when it doesn't continue the first one's content", () => {
		const rewritten: SystemMessage = {
			...folded,
			content: "You are someone else.",
		};

		expect(keepHead(first, [rewritten, user("next", 6)])).toBeUndefined();
	});

	it("carries content added after the first head's", () => {
		const added: SystemMessage = {
			...folded,
			content: "You are pi.\n\nBe brief.",
		};
		const kept = keepHead(first, [added, user("next", 6)]) ?? [];

		expect(getCurrentSystemPrompt(kept)).toBe(getCurrentSystemPrompt([added]));
	});

	it("leaves a request with no system head alone", () => {
		expect(keepHead(first, [user("next", 6)])).toBeUndefined();
	});

	// pi clones the context for every request, so each one hands over a
	// head equal to the last but never the same object.
	it("works a head's patch out once for every request that sends it again", () => {
		const once = keepHead(first, afterCompaction) ?? [];
		const again = keepHead(first, structuredClone(afterCompaction)) ?? [];

		expect(again[1], "the patch from the request before").toBe(once[1]);
	});

	it("works the patch out anew once the head it is sent changes", () => {
		const once = keepHead(first, afterCompaction) ?? [];
		const reworded: SystemMessage = {
			...folded,
			sections: { ...folded.sections, tools: "<tools>read</tools>" },
		};
		const after = keepHead(first, [reworded, user("next", 6)]) ?? [];

		expect(after[1]).not.toBe(once[1]);
		expect(getCurrentSystemPrompt(after)).toBe(
			getCurrentSystemPrompt([reworded]),
		);
	});
});

/** A head whose skills section is most of it, as a real session's is. */
const big: SystemMessage = {
	role: "system",
	content: "You are pi.",
	sections: { skills: "s".repeat(1_000), cwd: "<cwd>/src</cwd>" },
	toolsAdded: [tool("read")],
	timestamp: 1,
};

/** A compaction's entry, leading with the head `systemMessage`. */
const compaction = (systemMessage: SystemMessage) => ({
	type: "compaction",
	systemMessage,
});

/** `big`'s size as sent: its content, its sections and its tools. */
const bigSize =
	"You are pi.".length +
	1_000 +
	"<cwd>/src</cwd>".length +
	JSON.stringify(big.toolsAdded).length;

/** `big` with a notes section `length` long added, so the patch is that section. */
const withNotes = (length: number, at: number): SystemMessage => ({
	...big,
	sections: { ...big.sections, notes: "n".repeat(length) },
	timestamp: at,
});

describe("the head a session keeps", () => {
	it("is the first system message on a branch before any compaction", () => {
		const branch = [
			{ type: "session_info" },
			{ type: "message", message: user("hi", 0) },
			{ type: "message", message: first },
			{ type: "message", message: changed },
		];

		expect(keptHeadOf(branch)).toBe(first);
		expect(
			keptHeadOf([{ type: "message", message: user("hi", 0) }]),
		).toBeUndefined();
	});

	it("stays the first through a compaction whose head differs a little", () => {
		const nearly: SystemMessage = {
			...big,
			sections: { ...big.sections, cwd: "<cwd>/elsewhere</cwd>" },
			timestamp: 5,
		};
		const branch = [{ type: "message", message: big }, compaction(nearly)];

		expect(keptHeadOf(branch)).toBe(big);
	});

	it("moves to a compaction's head once the patch reaches its share of the kept one", () => {
		const reach = Math.ceil(MOVE_SHARE * bigSize);
		const under = withNotes(reach - 1, 5);
		const at = withNotes(reach, 5);

		expect(
			keptHeadOf([{ type: "message", message: big }, compaction(under)]),
		).toBe(big);
		expect(
			keptHeadOf([{ type: "message", message: big }, compaction(at)]),
		).toBe(at);
	});

	it("measures each later compaction against the head it moved to", () => {
		const grown = withNotes(bigSize, 5);
		const thenNearly: SystemMessage = {
			...grown,
			sections: { ...grown.sections, cwd: "<cwd>/elsewhere</cwd>" },
			timestamp: 9,
		};
		const branch = [
			{ type: "message", message: big },
			compaction(grown),
			{ type: "message", message: user("on", 6) },
			compaction(thenNearly),
		];

		expect(keptHeadOf(branch)).toBe(grown);
	});

	it("moves to a compaction's head that can't be said as a patch", () => {
		const rewritten: SystemMessage = {
			...big,
			content: "You are someone else.",
		};
		const branch = [{ type: "message", message: big }, compaction(rewritten)];

		expect(keptHeadOf(branch)).toBe(rewritten);
	});

	it("ignores a compaction that recorded no head", () => {
		const branch = [{ type: "message", message: big }, { type: "compaction" }];

		expect(keptHeadOf(branch)).toBe(big);
	});
});

/** An Anthropic model that takes system messages and tool changes mid-conversation, as Claude does. */
const claude: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 200_000,
	maxTokens: 8_000,
	compat: {
		supportsMidConvoSystemMessages: true,
		supportsMidConvoToolChanges: true,
	},
};

/** The request pi-ai would send Anthropic for `messages`, caught before it leaves. */
async function payloadFor(messages: Message[]): Promise<{
	system?: unknown;
	tools?: unknown;
}> {
	let caught: unknown;
	// pi builds the branded transcript itself; a test can only claim one.
	const context = { messages } as unknown as Parameters<typeof stream>[1];
	const events = stream(claude, context, {
		apiKey: "test",
		onPayload: (payload) => {
			caught = payload;
			throw new Error("caught before sending");
		},
	});
	for await (const _event of events) {
		// Drained only so the request is built; it fails by design.
	}
	return caught as { system?: unknown; tools?: unknown };
}

describe("the request Anthropic is sent after a compaction", () => {
	const before: Message[] = [first, user("one", 2), changed, user("two", 4)];

	it("starts with the system text and tools it was sent before", async () => {
		const cached = await payloadFor(before);
		const kept = await payloadFor(keepHead(first, afterCompaction) ?? []);

		expect(cached.system).toBeDefined();
		expect(cached.tools).toBeDefined();
		expect(kept.system).toEqual(cached.system);
		expect(kept.tools).toEqual(cached.tools);
	});

	it("starts with others under pi's own head", async () => {
		const cached = await payloadFor(before);
		const pis = await payloadFor(afterCompaction);

		expect(pis.system).not.toEqual(cached.system);
		expect(pis.tools).not.toEqual(cached.tools);
	});
});
