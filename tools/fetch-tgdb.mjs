/**
 * Fetches game metadata from TheGamesDB into the games folder.
 *
 * The TGDB API has no CORS headers, so the browser app cannot call it
 * directly; this script runs under Node (no CORS there), queries every
 * game found in the folder and writes psx-metadata.json next to the
 * games. The library scanner picks that file up automatically — after
 * one run the app has titles, years, genres, overviews and fallback
 * box art fully offline.
 *
 * Usage: node tools/fetch-tgdb.mjs "D:\PSX" [apikey]
 */
/* eslint-env node */

import * as fs from "fs";
import * as path from "path";

const DEFAULT_KEY = "3ce51b6ecfcbf02a55030357a20e3a719e94836c46c3af056b1eda61554e7e10";
const API = "https://api.thegamesdb.net/v1.1";
const PLATFORM_PSX = 10;

const DISC_EXT = /\.(bin|iso|img)$/i;
const CUE_EXT = /\.cue$/i;

const root = process.argv[2];
const key = process.argv[3] || DEFAULT_KEY;
if (!root) {
	console.error("usage: node tools/fetch-tgdb.mjs <games folder> [apikey]");
	process.exit(1);
}

/** @param {string} n */
const baseName = (n) => n.replace(/\.[^.]+$/, "");

/** strips release-dump noise the same way the app's cleanTitle does */
const cleanTitle = (n) => n
	.replace(/\[[^\]]*\]?/g, "")
	.replace(/\([^)]*\)?/g, "")
	.replace(/[_.]+/g, " ")
	.replace(/\s+/g, " ")
	.trim() || n;

/** collects {rawName, cleanName} for every game in the folder */
function collectGames(dir, depth = 0) {
	const out = [];
	const entries = fs.readdirSync(dir, {withFileTypes: true});
	const cue = entries.find((e) => e.isFile() && CUE_EXT.test(e.name));
	const disc = entries.find((e) => e.isFile() && DISC_EXT.test(e.name));
	if (depth > 0 && (cue || disc)) {
		// a game folder: one entry named after the folder or the file
		const raw = cue ? baseName(cue.name) : baseName(disc.name);
		out.push({rawName: path.basename(dir), altRaw: raw, cleanName: cleanTitle(path.basename(dir))});
		return out;
	}
	for (const e of entries) {
		if (e.isDirectory() && depth < 2) {
			out.push(...collectGames(path.join(dir, e.name), depth + 1));
		} else if (e.isFile() && depth === 0 && (CUE_EXT.test(e.name) || DISC_EXT.test(e.name))) {
			const raw = baseName(e.name);
			out.push({rawName: raw, altRaw: raw, cleanName: cleanTitle(raw)});
		}
	}
	return out;
}

/** @param {string} url */
async function getJson(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.json();
}

const games = collectGames(root);
if (games.length === 0) {
	console.error("no games found in", root);
	process.exit(1);
}
console.log(`found ${games.length} game(s)`);

const genresById = {};
try {
	// the genres list lives under /v1, unlike the games endpoints
	const g = await getJson(`${API.replace("v1.1", "v1")}/Genres?apikey=${key}`);
	for (const [id, v] of Object.entries(g.data.genres)) genresById[id] = v.name;
} catch (err) {
	console.error("genres lookup failed:", err.message);
}

const outPath = path.join(root, "psx-metadata.json");
const meta = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};
let allowance = null;

for (const g of games) {
	const cached = meta[g.rawName];
	// refresh entries saved before the genres lookup worked
	if (cached && (cached.genres.length > 0 || Object.keys(genresById).length === 0)) {
		console.log(`= ${g.rawName} (cached)`);
		continue;
	}
	const url = `${API}/Games/ByGameName?apikey=${key}` +
		`&name=${encodeURIComponent(g.cleanName)}` +
		`&filter%5Bplatform%5D=${PLATFORM_PSX}` +
		"&fields=overview,players,genres&include=boxart";
	try {
		const j = await getJson(url);
		allowance = j.remaining_monthly_allowance;
		const list = j.data.games || [];
		const exact = list.find((x) => x.game_title.toLowerCase() === g.cleanName.toLowerCase());
		const pick = exact || list[0];
		if (!pick) {
			console.log(`? ${g.rawName}: not found`);
			continue;
		}
		let boxart = null;
		const inc = j.include && j.include.boxart;
		if (inc && inc.data[pick.id]) {
			const front = inc.data[pick.id].find((a) => a.type === "boxart" && a.side === "front")
				|| inc.data[pick.id][0];
			if (front) boxart = inc.base_url.original + front.filename;
		}
		meta[g.rawName] = {
			title: pick.game_title,
			year: pick.release_date ? pick.release_date.slice(0, 4) : null,
			players: pick.players || null,
			genres: (pick.genres || []).map((id) => genresById[id]).filter(Boolean),
			overview: pick.overview || null,
			boxart,
		};
		console.log(`+ ${g.rawName} -> ${pick.game_title} (${meta[g.rawName].year})`);
	} catch (err) {
		console.log(`! ${g.rawName}: ${err.message}`);
	}
}

fs.writeFileSync(outPath, JSON.stringify(meta, null, "\t"));
console.log(`wrote ${outPath}${allowance !== null ? ` · monthly allowance left: ${allowance}` : ""}`);
