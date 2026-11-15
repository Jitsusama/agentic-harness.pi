import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getFileMetadata,
	listFiles,
	parseGoogleUrl,
} from "../../../../lib/google/apis/drive.ts";

/** Every Drive request the client made, by method. */
const drive = vi.hoisted(() => ({
	files: { list: vi.fn(), get: vi.fn() },
}));

vi.mock("../../../../lib/google/apis/client.ts", () => ({
	google: { drive: () => drive },
}));

const auth = {} as OAuth2Client;

/** A file as Drive answers one. */
const ANSWERED = {
	id: "f1",
	name: "Plan",
	mimeType: "application/vnd.google-apps.document",
	size: "2048",
	modifiedTime: "2026-11-02T12:00:00Z",
	owners: [{ displayName: "Ada", emailAddress: "ada@example.com" }],
	webViewLink: "https://docs.google.com/document/d/f1",
	iconLink: "https://drive.example/icon.png",
};

/** The same file as a reader of the client sees it. */
const SEEN = {
	id: "f1",
	name: "Plan",
	mimeType: "application/vnd.google-apps.document",
	size: 2048,
	modifiedTime: "2026-11-02T12:00:00Z",
	owners: [{ displayName: "Ada", emailAddress: "ada@example.com" }],
	webViewLink: "https://docs.google.com/document/d/f1",
	iconLink: "https://drive.example/icon.png",
};

/** A file Drive answered with nothing but its id. */
const BARE = {
	id: "f2",
	name: "",
	mimeType: "",
	size: undefined,
	modifiedTime: "",
	owners: [],
	webViewLink: undefined,
	iconLink: undefined,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("reading Drive files", () => {
	it("lists files as a metadata read sees each one", async () => {
		drive.files.list.mockResolvedValue({
			data: { files: [ANSWERED, { id: "f2" }], nextPageToken: "next" },
		});

		expect(await listFiles(auth)).toEqual({
			files: [SEEN, BARE],
			nextPageToken: "next",
		});
	});

	it("reads one file's metadata", async () => {
		drive.files.get.mockResolvedValue({ data: ANSWERED });

		expect(await getFileMetadata(auth, "f1")).toEqual(SEEN);
	});

	it("reads a file Drive says little about", async () => {
		drive.files.get.mockResolvedValue({ data: { id: "f2" } });

		expect(await getFileMetadata(auth, "f2")).toEqual(BARE);
	});

	it("asks for the newest untrashed files of a type by default", async () => {
		drive.files.list.mockResolvedValue({ data: {} });

		expect(await listFiles(auth, { type: "doc", owner: "me" })).toEqual({
			files: [],
			nextPageToken: undefined,
		});
		expect(drive.files.list).toHaveBeenCalledWith(
			expect.objectContaining({
				q: "trashed = false and mimeType = 'application/vnd.google-apps.document' and 'me' in owners",
				pageSize: 25,
				orderBy: "modifiedTime desc",
			}),
		);
	});
});

describe("parseGoogleUrl", () => {
	it("reads a document id and types it as a doc", () => {
		expect(
			parseGoogleUrl("https://docs.google.com/document/d/DOC123/edit"),
		).toEqual({ id: "DOC123", type: "doc" });
	});

	it("types a spreadsheet url as a sheet", () => {
		expect(
			parseGoogleUrl("https://docs.google.com/spreadsheets/d/SHEET1/edit"),
		).toEqual({ id: "SHEET1", type: "sheet" });
	});

	it("types a presentation url as slides", () => {
		expect(
			parseGoogleUrl("https://docs.google.com/presentation/d/SLIDE1/edit"),
		).toEqual({ id: "SLIDE1", type: "slides" });
	});

	it("types a drive file url as a file", () => {
		expect(
			parseGoogleUrl("https://drive.google.com/file/d/FILE1/view"),
		).toEqual({ id: "FILE1", type: "file" });
	});

	it("carries a tab id through when the url names one", () => {
		expect(
			parseGoogleUrl(
				"https://docs.google.com/document/d/DOC123/edit?tab=t.abc123",
			),
		).toEqual({ id: "DOC123", type: "doc", tabId: "t.abc123" });
	});

	it("returns null for a non-Google url", () => {
		expect(parseGoogleUrl("https://example.com/document/d/DOC123")).toBeNull();
	});
});
