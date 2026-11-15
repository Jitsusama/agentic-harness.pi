import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	archiveEmail,
	createDraft,
	getEmail,
	getThread,
	markRead,
	markUnread,
	searchEmails,
	sendEmail,
	unarchiveEmail,
} from "../../../../lib/google/apis/gmail.ts";

/** Every Gmail request the client made, by method. */
const gmail = vi.hoisted(() => ({
	users: {
		messages: {
			list: vi.fn(),
			get: vi.fn(),
			send: vi.fn(),
			modify: vi.fn(),
			trash: vi.fn(),
		},
		threads: { get: vi.fn() },
		drafts: { create: vi.fn() },
	},
}));

vi.mock("../../../../lib/google/apis/client.ts", () => ({
	google: { gmail: () => gmail },
}));

const auth = {} as OAuth2Client;

/** Gmail's URL-safe base64, as message bodies arrive in. */
function urlSafe(text: string): string {
	return Buffer.from(text)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

/** A message as Gmail answers one, with the headers a reader sees. */
function message(over: Record<string, unknown> = {}) {
	return {
		id: "m1",
		threadId: "t1",
		snippet: "lunch?",
		labelIds: ["INBOX", "UNREAD"],
		payload: {
			headers: [
				{ name: "from", value: '"Ada Lovelace" <ada@example.com>' },
				{ name: "To", value: "bob@example.com, Cy <cy@example.com>" },
				{ name: "Subject", value: "Lunch" },
				{ name: "Date", value: "Mon, 2 Nov 2026 12:00:00 -0500" },
			],
			parts: [
				{ mimeType: "text/html", body: { data: urlSafe("<b>hi</b>") } },
				{ mimeType: "text/plain", body: { data: urlSafe("hi there") } },
				{
					filename: "menu.pdf",
					mimeType: "application/pdf",
					body: { size: 2048 },
				},
			],
		},
		...over,
	};
}

/** What every reader of a message sees of its headers. */
const SEEN = {
	id: "m1",
	threadId: "t1",
	subject: "Lunch",
	from: { name: "Ada Lovelace", email: "ada@example.com" },
	to: [
		{ name: "", email: "bob@example.com" },
		{ name: "Cy", email: "cy@example.com" },
	],
	cc: undefined,
	date: "Mon, 2 Nov 2026 12:00:00 -0500",
	snippet: "lunch?",
	labels: ["INBOX", "UNREAD"],
	hasAttachments: true,
};

/** What a full read adds: the plain body and the attachments. */
const FULL = {
	...SEEN,
	body: "hi there",
	attachments: [
		{ filename: "menu.pdf", mimeType: "application/pdf", size: 2048 },
	],
};

/** The raw message a send or draft carried, decoded. */
function sentRaw(call: unknown): string {
	const raw =
		(call as { requestBody: { raw?: string; message?: { raw: string } } })
			.requestBody.raw ??
		(call as { requestBody: { message: { raw: string } } }).requestBody.message
			.raw;
	expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
	return Buffer.from(
		raw.replace(/-/g, "+").replace(/_/g, "/"),
		"base64",
	).toString();
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("reading mail", () => {
	it("reads each search hit's headers the way a full read does", async () => {
		gmail.users.messages.list.mockResolvedValue({
			data: { messages: [{ id: "m1" }], nextPageToken: "next" },
		});
		gmail.users.messages.get.mockResolvedValue({ data: message() });

		const found = await searchEmails(auth, "from:ada", 10);

		expect(found).toEqual({ messages: [SEEN], nextPageToken: "next" });
	});

	it("answers an empty search without asking for any message", async () => {
		gmail.users.messages.list.mockResolvedValue({ data: {} });

		expect(await searchEmails(auth, "nothing")).toEqual({ messages: [] });
		expect(gmail.users.messages.get).not.toHaveBeenCalled();
	});

	it("reads one message with its plain body and attachments", async () => {
		gmail.users.messages.get.mockResolvedValue({ data: message() });

		expect(await getEmail(auth, "m1")).toEqual(FULL);
	});

	it("names a message without a subject and reads its cc", async () => {
		gmail.users.messages.get.mockResolvedValue({
			data: message({
				payload: {
					headers: [
						{ name: "From", value: "ada@example.com" },
						{ name: "Cc", value: "Di <di@example.com>" },
					],
				},
			}),
		});

		expect(await getEmail(auth, "m1")).toMatchObject({
			subject: "(no subject)",
			from: { name: "", email: "ada@example.com" },
			to: [],
			cc: [{ name: "Di", email: "di@example.com" }],
			hasAttachments: false,
			body: "",
			attachments: [],
		});
	});

	it("falls back to the html body, stripped, when there is no plain one", async () => {
		gmail.users.messages.get.mockResolvedValue({
			data: message({
				payload: {
					headers: [],
					parts: [
						{
							mimeType: "text/html",
							body: { data: urlSafe("<p>a &amp; b<br/>c</p>") },
						},
					],
				},
			}),
		});

		expect((await getEmail(auth, "m1")).body).toBe("a & b\nc");
	});

	it("reads every message of a thread the way a full read does", async () => {
		gmail.users.messages.get.mockResolvedValue({ data: { threadId: "t1" } });
		gmail.users.threads.get.mockResolvedValue({
			data: { messages: [message(), message({ id: "m2" })] },
		});

		expect(await getThread(auth, "m1")).toEqual([FULL, { ...FULL, id: "m2" }]);
	});
});

describe("writing mail", () => {
	it("sends a message with its recipients and subject", async () => {
		gmail.users.messages.send.mockResolvedValue({
			data: { id: "s1", threadId: "t9" },
		});

		const sent = await sendEmail(auth, {
			to: ["bob@example.com", "cy@example.com"],
			cc: ["di@example.com"],
			bcc: ["ed@example.com"],
			subject: "Lunch?",
			body: "Noon works.",
		});

		expect(sent).toEqual({ id: "s1", threadId: "t9" });
		const call = gmail.users.messages.send.mock.calls[0]?.[0];
		expect(sentRaw(call)).toBe(
			[
				"To: bob@example.com, cy@example.com",
				"Cc: di@example.com",
				"Bcc: ed@example.com",
				"Subject: Lunch?",
				"",
				"Noon works.",
			].join("\n"),
		);
		expect(call.requestBody.threadId).toBeUndefined();
	});

	it("threads a reply under the message it answers", async () => {
		gmail.users.messages.get.mockResolvedValue({
			data: {
				threadId: "t1",
				payload: {
					headers: [
						{ name: "Message-ID", value: "<b@x>" },
						{ name: "References", value: "<a@x>" },
					],
				},
			},
		});
		gmail.users.messages.send.mockResolvedValue({ data: {} });

		await sendEmail(auth, {
			to: ["ada@example.com"],
			subject: "Re: Lunch",
			body: "Yes.",
			replyTo: "m1",
		});

		const call = gmail.users.messages.send.mock.calls[0]?.[0];
		expect(sentRaw(call)).toBe(
			[
				"To: ada@example.com",
				"Subject: Re: Lunch",
				"In-Reply-To: <b@x>",
				"References: <a@x> <b@x>",
				"",
				"Yes.",
			].join("\n"),
		);
		expect(call.requestBody.threadId).toBe("t1");
	});

	it("drafts the message a send would have sent", async () => {
		gmail.users.drafts.create.mockResolvedValue({
			data: { id: "d1", message: { id: "m7" } },
		});

		const drafted = await createDraft(auth, {
			to: ["bob@example.com"],
			cc: ["di@example.com"],
			subject: "Lunch?",
			body: "Noon works.",
		});

		expect(drafted).toEqual({ id: "d1", messageId: "m7" });
		expect(sentRaw(gmail.users.drafts.create.mock.calls[0]?.[0])).toBe(
			[
				"To: bob@example.com",
				"Cc: di@example.com",
				"Subject: Lunch?",
				"",
				"Noon works.",
			].join("\n"),
		);
	});
});

describe("labelling mail", () => {
	it.each([
		["archiving", archiveEmail, { removeLabelIds: ["INBOX"] }],
		["unarchiving", unarchiveEmail, { addLabelIds: ["INBOX"] }],
		["marking read", markRead, { removeLabelIds: ["UNREAD"] }],
		["marking unread", markUnread, { addLabelIds: ["UNREAD"] }],
	] as const)("%s changes only that label", async (_name, act, change) => {
		gmail.users.messages.modify.mockResolvedValue({ data: {} });

		await act(auth, "m1");

		expect(gmail.users.messages.modify).toHaveBeenCalledWith({
			userId: "me",
			id: "m1",
			requestBody: change,
		});
	});
});
