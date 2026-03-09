/**
 * Google Slides API client.
 */

import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

export interface SlideData {
	title: string;
	slides: Array<{
		number: number;
		text: string;
	}>;
}

/**
 * Get presentation content.
 */
export async function getSlideContent(
	auth: OAuth2Client,
	presentationId: string,
): Promise<SlideData> {
	const slides = google.slides({ version: "v1", auth });

	const presentation = await slides.presentations.get({
		presentationId,
	});

	const title = presentation.data.title || "Untitled";
	const slideData: SlideData = {
		title,
		slides: [],
	};

	for (let i = 0; i < (presentation.data.slides || []).length; i++) {
		const slide = presentation.data.slides?.[i];
		if (!slide) continue;

		let text = "";

		for (const pageElement of slide.pageElements || []) {
			const shape = pageElement.shape;
			if (!shape?.text) continue;

			for (const textElement of shape.text.textElements || []) {
				const textRun = textElement.textRun;
				if (textRun?.content) {
					text += textRun.content;
				}
			}
		}

		slideData.slides.push({
			number: i + 1,
			text: text.trim(),
		});
	}

	return slideData;
}
