import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/slack/auth/credentials", () => ({
	getToken: vi.fn(() => undefined),
	hasToken: vi.fn(() => false),
}));

vi.mock("../../../lib/slack/resolvers/user", () => ({
	resolveUser: vi.fn(async () => "U-MOCK"),
}));

vi.mock("../../../lib/slack/api/client", () => ({
	SlackClient: vi.fn().mockImplementation(() => ({})),
}));

import {
	clearSlackClientCache,
	slackResolver,
} from "../../../lib/internal/people/resolvers/slack";
import { getToken, hasToken } from "../../../lib/slack/auth/credentials";
import { resolveUser } from "../../../lib/slack/resolvers/user";

const mockedHasToken = vi.mocked(hasToken);
const mockedGetToken = vi.mocked(getToken);
const mockedResolveUser = vi.mocked(resolveUser);

beforeEach(() => {
	clearSlackClientCache();
	mockedHasToken.mockReturnValue(false);
	mockedGetToken.mockReturnValue(undefined);
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
		mockedGetToken.mockReturnValue({
			accessToken: "xoxc-...",
			cookie: "d=abc",
		});
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
		mockedGetToken.mockReturnValue({
			accessToken: "xoxc-...",
		});
		mockedResolveUser.mockRejectedValue(new Error("slack down"));
		const result = await slackResolver.resolve("@joel.gerber");
		expect(result).toBeUndefined();
	});
});
