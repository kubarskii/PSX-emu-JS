/**
 * Online box art from the libretro-thumbnails project. Thumbnails are
 * named after Redump titles ("Tekken 3 (USA).png"), which is exactly how
 * dumped game files are usually named, so the raw file/folder name of a
 * library entry doubles as the lookup key. Images are fetched from
 * raw.githubusercontent.com (it sends Access-Control-Allow-Origin: *)
 * and cached as blobs in IndexedDB, so a scanned library keeps its
 * covers offline and rescans do not hit the network.
 */

import {saveCover, loadCover} from "../loader/db";

const REPO = "https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation/master/Named_Boxarts/";

/**
 * libretro replaces characters that are invalid in filenames with '_'.
 * @param {string} rawName - file/folder name without extension
 * @return {string}
 */
export function thumbName(rawName) {
	return rawName.replace(/[&*/:`<>?\\|"]/g, "_").trim();
}

/**
 * @param {string} rawName
 * @return {Promise<string | null>} - object URL of the cover, or null
 */
export async function fetchCover(rawName) {
	if (!rawName) return null;
	const key = thumbName(rawName);
	try {
		const cached = await loadCover(key);
		if (cached !== null) return URL.createObjectURL(cached);
	} catch (err) {
		// cache is best-effort: fall through to the network
	}
	try {
		const res = await fetch(REPO + encodeURIComponent(key) + ".png");
		if (!res.ok) return null;
		const blob = await res.blob();
		saveCover(key, blob).catch(() => {});
		return URL.createObjectURL(blob);
	} catch (err) {
		return null; // offline or blocked: the placeholder tile stays
	}
}
