import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@jitsusama/agentic-harness.core/slack", async (importOriginal) => ({
	...(await importOriginal()),
	getToken: vi.fn(() => null),
	hasToken: vi.fn(() => false),
	resolveUser: vi.fn(async () => "U-MOCK"),
	// Bare vi.fn() is constructable and returns a truthy mock instance,
	// which is all the resolver checks before handing the client to the
	// separately-mocked resolveUser. An arrow implementation would fail
	// under `new` in Vitest 4, and a function expression trips
	// useArrowFunction, so the auto-mock is the honest fit here.
	SlackClient: vi.fn(),
}));

import type { StoredToken } from "@jitsusama/agentic-harness.core/slack";
import {
	getToken,
	hasToken,
	resolveUser,
} from "@jitsusama/agentic-harness.core/slack";
import {
	clearSlackClientCache,
	slackResolver,
} from "../../../lib/internal/people/resolvers/slack";

/**
 * A stored credential, complete.
 *
 * The resolver only reads the access token, so these tests used to
 * pass a fragment of one. That is a fixture the real code could
 * never receive: `getToken` either returns a whole credential or
 * null, and a test that narrows a type by hand stops noticing when
 * the type gains a field the code starts relying on.
 */
function storedToken(over: Partial<StoredToken> = {}): StoredToken {
	return {
		accessToken: "xoxc-...",
		userId: "U08ME9KASG7",
		teamId: "T-TEST",
		scopes: "search:read,users:read",
		...over,
	};
}

const mockedHasToken = vi.mocked(hasToken);
const mockedGetToken = vi.mocked(getToken);
const mockedResolveUser = vi.mocked(resolveUser);

beforeEach(() => {
	clearSlackClientCache();
	mockedHasToken.mockReturnValue(false);
	mockedGetToken.mockReturnValue(null);
	mockedResolveUser.mockResolvedValue("U-MOCK");
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("slackResolver", () => {
	it("skips inputs without a leading @ so bare names don't trigger Slack traffic", async () => {
		mockedHasToken.mockReturnValue(true);
		const result = await slackResolver.resolve("Joel Gerber");
		expect(result).toBeUndefined();
		expect(mockedResolveUser).not.toHaveBeenCalled();
	});

	it("returns undefined when hint is set and is not 'handle'", async () => {
		mockedHasToken.mockReturnValue(true);
		const result = await slackResolver.resolve("@anyone", { hint: "name" });
		expect(result).toBeUndefined();
		expect(mockedResolveUser).not.toHaveBeenCalled();
	});

	it("returns undefined when no token is stored (silent skip)", async () => {
		mockedHasToken.mockReturnValue(false);
		const result = await slackResolver.resolve("@joel.gerber");
		expect(result).toBeUndefined();
		expect(mockedResolveUser).not.toHaveBeenCalled();
	});

	it("looks up the handle and returns an identity when authenticated", async () => {
		mockedHasToken.mockReturnValue(true);
		mockedGetToken.mockReturnValue(storedToken({ cookie: "d=abc" }));
		mockedResolveUser.mockResolvedValue("U08ME9KASG7");
		const result = await slackResolver.resolve("@joel.gerber");
		expect(result).toEqual({
			id: "joel.gerber",
			names: ["joel.gerber"],
			handles: [{ type: "slack", value: "U08ME9KASG7" }],
		});
		expect(mockedResolveUser).toHaveBeenCalledTimes(1);
	});

	it("swallows Slack errors and returns undefined", async () => {
		mockedHasToken.mockReturnValue(true);
		mockedGetToken.mockReturnValue(storedToken());
		mockedResolveUser.mockRejectedValue(new Error("slack down"));
		const result = await slackResolver.resolve("@joel.gerber");
		expect(result).toBeUndefined();
	});
});
