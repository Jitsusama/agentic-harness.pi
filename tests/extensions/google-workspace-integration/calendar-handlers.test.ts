import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/google/apis/calendar", () => ({
	createEvent: vi.fn(),
	deleteEvent: vi.fn(),
	getEvent: vi.fn(),
	listEvents: vi.fn(),
	queryFreeBusy: vi.fn(),
	respondToEvent: vi.fn(),
	updateEvent: vi.fn(),
}));

import { handleCreateEvent } from "../../../extensions/google-workspace-integration/router/calendar-handlers";
import { createEvent } from "../../../lib/google/apis/calendar";

const mockedCreateEvent = vi.mocked(createEvent);

/**
 * A context with no UI, which is how a confirmation gate is reached
 * from a headless run: it approves without prompting, so the handler
 * proceeds to the API call these tests are about.
 */
function headlessContext(): ExtensionContext {
	return { hasUI: false } as unknown as ExtensionContext;
}

/** Credentials the mocked API layer never looks at. */
function anyAuth(): OAuth2Client {
	return {} as unknown as OAuth2Client;
}

const validEvent = {
	summary: "Design review",
	start: "2026-07-27T14:00:00-04:00",
	end: "2026-07-27T15:00:00-04:00",
};

/** The text of a result, joined, so a claim can be made about all of it. */
function textOf(result: { content: Array<{ type: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => {
			return block.type === "text" && "text" in block;
		})
		.map((block) => block.text)
		.join("\n");
}

describe("creating a calendar event", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reports a refused creation instead of throwing over it", async () => {
		mockedCreateEvent.mockRejectedValue(
			new Error("Calendar usage limits exceeded"),
		);

		// The point of the test: the failure path quotes the requested
		// times back, and it must be able to reach them. Reading them
		// from a binding scoped to the try block threw a ReferenceError
		// from inside the catch, so a calendar Google had refused
		// surfaced as a crash in the tool instead of a message saying
		// what was asked for and what came back.
		const result = await handleCreateEvent(
			validEvent,
			anyAuth(),
			headlessContext(),
		);

		const text = textOf(result);
		expect(text).toContain("Calendar usage limits exceeded");
		expect(text).toContain(validEvent.start);
		expect(text).toContain(validEvent.end);
	});

	it("renders the event it created", async () => {
		// The normalized event, not Google's wire shape: the API layer
		// flattens start and end to ISO strings before a handler sees
		// them, so a fixture carrying { dateTime } would be testing
		// against a shape this seam never receives.
		mockedCreateEvent.mockResolvedValue({
			id: "evt-1",
			summary: validEvent.summary,
			start: validEvent.start,
			end: validEvent.end,
		});

		const result = await handleCreateEvent(
			validEvent,
			anyAuth(),
			headlessContext(),
		);

		expect(textOf(result)).toContain(validEvent.summary);
		expect(result.details).toEqual({
			event: expect.objectContaining({ id: "evt-1" }),
		});
	});

	it("asks for what it needs rather than calling out half-formed", async () => {
		const result = await handleCreateEvent(
			{ summary: "No times given" },
			anyAuth(),
			headlessContext(),
		);

		expect(textOf(result)).toContain("Missing required parameters");
		expect(mockedCreateEvent).not.toHaveBeenCalled();
	});
});
