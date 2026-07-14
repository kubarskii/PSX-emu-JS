/**
 * Diagnostic: reproduce reported artifacts — NFS Porsche intro FMV stripes,
 * Harry Potter language-select background garbage.
 * Opt-in: PSX_REPRO=1 npx jest debug.repro
 */
/* eslint-env node */
import * as fs from "fs";
import * as path from "path";
import {PSX} from "../src/psx";
import {parseCue, buildDisc} from "../src/loader/cue";

const BIOS_PATH = "C:\\Users\\Aleksandr\\Downloads\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101] (1)\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101].bin";
const OUT_DIR = process.env.PSX_OUT || ".";

const GAMES = [
	{
		name: "nfsp",
		cue: "D:\\PSX\\Need for Speed - Porsche Unleashed (USA)\\Need for Speed - Porsche Unleashed (USA).cue",
		frames: process.env.PSX_LONG === "1"
			? [3600, 4200, 4800, 5400, 6000, 6600, 7200]
			: [300, 600, 900, 1200, 1800, 2400, 3000],
		press: process.env.PSX_LONG === "1",
	},
	{
		name: "hp",
		cue: "D:\\PSX\\Harry Potter and the Sorcerer's Stone (USA) (En,Fr,Es)\\Harry Potter and the Sorcerer's Stone (USA) (En,Fr,Es).cue",
		frames: [600, 1200, 1800, 2400, 3000],
		press: true,
	},
];
GAMES.push({
	name: "nfsmenu",
	cue: GAMES[0].cue,
	frames: [2100, 2400, 2700, 3000, 3300, 3600, 4200, 4800, 5400, 6000],
	press: false,
	// tap Start early to leave the title screen, then hands off the pad so
	// the main menu stays up instead of attract mode / race
	custom: (f) => (f < 3800 && (f % 60) < 6 ? (~0x0008 & 0xffff) : 0xffff),
});

const only = process.env.GAME || "";

function saveBmp(p, rgba, w, h) {
	const rowSize = w * 3 + ((4 - (w * 3) % 4) % 4);
	const buf = Buffer.alloc(54 + rowSize * h);
	buf.write("BM", 0);
	buf.writeUInt32LE(54 + rowSize * h, 2);
	buf.writeUInt32LE(54, 10);
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(w, 18);
	buf.writeInt32LE(-h, 22);
	buf.writeUInt16LE(1, 26);
	buf.writeUInt16LE(24, 28);
	buf.writeUInt32LE(rowSize * h, 34);
	for (let y = 0; y < h; y++) {
		let o = 54 + y * rowSize;
		for (let x = 0; x < w; x++) {
			const px = rgba[y * w + x];
			buf[o++] = (px >> 16) & 0xff;
			buf[o++] = (px >> 8) & 0xff;
			buf[o++] = px & 0xff;
		}
	}
	fs.writeFileSync(p, buf);
}

function loadDisc(cue) {
	const dir = path.dirname(cue);
	const entries = parseCue(fs.readFileSync(cue, "utf8"));
	const buffers = new Map();
	for (const e of entries) {
		const key = e.file.toLowerCase();
		if (!buffers.has(key)) {
			const b = fs.readFileSync(path.join(dir, e.file));
			buffers.set(key, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
		}
	}
	return buildDisc(entries, buffers);
}

const RUN = process.env.PSX_REPRO === "1";
(RUN ? it : it.skip)("dumps repro frames", () => {
	const bios = fs.readFileSync(BIOS_PATH);
	const biosBuf = bios.buffer.slice(bios.byteOffset, bios.byteOffset + bios.byteLength);
	for (const g of GAMES) {
		if (only && g.name !== only) continue;
		const disc = loadDisc(g.cue);
		const psx = new PSX();
		psx.insertDisc(disc.buffer, true, disc.tracks);
		psx.loadBios(biosBuf);
		psx.fastBootDisc();
		const far = performance.now() + 1e9;
		let f = 0;
		for (const mark of g.frames) {
			for (; f < mark; f++) {
				psx.runFrame(far);
				if (g.custom) {
					psx.joypad.buttons = g.custom(f);
				} else if (g.press && process.env.PSX_NOPRESS !== "1") {
					const phase = f % 90;
					psx.joypad.buttons = phase < 10 ? (~0x4000 & 0xffff) : 0xffff;
				}
			}
			const w = psx.gpu.hres || 320, h = psx.gpu.vres || 240;
			const out = new Uint32Array(w * h);
			psx.gpu.renderDisplay(out, w, h);
			saveBmp(path.join(OUT_DIR, `${g.name}-f${mark}.bmp`), out, w, h);
			console.log(g.name, mark, w + "x" + h);
		}
	}
}, 1800000);
