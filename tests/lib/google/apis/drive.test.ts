import { describe, expect, it } from "vitest";
import { parseGoogleUrl } from "../../../../lib/google/apis/drive.js";

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
