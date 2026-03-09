/**
 * Google Sheets API client.
 */

import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

export interface SheetData {
	title: string;
	sheets: Array<{
		name: string;
		rows: string[][];
	}>;
}

/**
 * Get spreadsheet content.
 */
export async function getSheetContent(
	auth: OAuth2Client,
	spreadsheetId: string,
): Promise<SheetData> {
	const sheets = google.sheets({ version: "v4", auth });

	const spreadsheet = await sheets.spreadsheets.get({
		spreadsheetId,
	});

	const title = spreadsheet.data.properties?.title || "Untitled";
	const sheetNames =
		spreadsheet.data.sheets?.map((s) => s.properties?.title || "") || [];

	const sheetData: SheetData = {
		title,
		sheets: [],
	};

	// Get data from each sheet
	for (const sheetName of sheetNames) {
		if (!sheetName) continue;

		// Escape single quotes in sheet name by doubling them
		const escapedName = sheetName.replace(/'/g, "''");

		try {
			const result = await sheets.spreadsheets.values.get({
				spreadsheetId,
				range: `'${escapedName}'`,
			});

			const rows = (result.data.values || []) as string[][];

			sheetData.sheets.push({
				name: sheetName,
				rows,
			});
		} catch (error) {
			// If a sheet fails, continue with other sheets
			const errorMsg = error instanceof Error ? error.message : String(error);

			// Special case for connected sheets or unsupported sheet types
			let friendlyMessage = `Error loading sheet: ${errorMsg}`;
			if (errorMsg.includes("Invalid range")) {
				friendlyMessage =
					`This sheet ("${sheetName}") cannot be read via API. ` +
					"It may be a Connected Sheet or other special sheet type that " +
					"doesn't support range queries.";
			}

			sheetData.sheets.push({
				name: sheetName,
				rows: [[friendlyMessage]],
			});
		}
	}

	return sheetData;
}
