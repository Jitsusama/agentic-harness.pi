import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createEvent,
	updateEvent,
} from "../../../../lib/google/apis/calendar.ts";

/** Every Calendar request the client made, by method. */
const calendar = vi.hoisted(() => ({
	events: { insert: vi.fn(), get: vi.fn(), update: vi.fn() },
}));

vi.mock("../../../../lib/google/apis/client.ts", () => ({
	google: { calendar: () => calendar },
}));

const auth = {} as OAuth2Client;

/** The zone this machine keeps, which every event it writes is put in. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The event a request carried. */
function sent(method: typeof calendar.events.insert): {
	start?: unknown;
	end?: unknown;
} {
	return method.mock.calls[0]?.[0].requestBody;
}

beforeEach(() => {
	vi.clearAllMocks();
	calendar.events.insert.mockResolvedValue({ data: {} });
	calendar.events.update.mockResolvedValue({ data: {} });
});

describe("writing calendar events", () => {
	it("puts a new event's start and end in this machine's zone", async () => {
		await createEvent(auth, {
			summary: "Lunch",
			start: "2026-11-02T12:00:00",
			end: "2026-11-02T13:00:00",
		});

		expect(sent(calendar.events.insert)).toMatchObject({
			start: { dateTime: "2026-11-02T12:00:00", timeZone: ZONE },
			end: { dateTime: "2026-11-02T13:00:00", timeZone: ZONE },
		});
	});

	it("moves an event in this machine's zone and keeps what it was not told", async () => {
		calendar.events.get.mockResolvedValue({
			data: {
				summary: "Lunch",
				start: { dateTime: "2026-11-02T12:00:00Z", timeZone: "UTC" },
				end: { dateTime: "2026-11-02T13:00:00Z", timeZone: "UTC" },
			},
		});

		await updateEvent(auth, "e1", { start: "2026-11-02T12:30:00" });

		expect(sent(calendar.events.update)).toMatchObject({
			summary: "Lunch",
			start: { dateTime: "2026-11-02T12:30:00", timeZone: ZONE },
			end: { dateTime: "2026-11-02T13:00:00Z", timeZone: "UTC" },
		});
	});
});
