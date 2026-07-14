/**
 * Diagnostic: boot every library game headless and dump proof frames.
 * Opt-in (machine-specific game/BIOS paths): PSX_GAMES=1 npx jest debug.games
 */
/* eslint-env node */
import * as fs from "fs";
import * as path from "path";
import {PSX} from "../src/psx";
import {parseCue, buildDisc} from "../src/loader/cue";

const BIOS_PATH = "C:\\Users\\Aleksandr\\Downloads\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101] (1)\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101].bin";
const OUT_DIR = "C:\\Users\\ALEKSA~1\\AppData\\Local\\Temp\\claude\\C--Projects-work-lambda\\939f7fa7-5a4f-4fe2-ab72-200389fccb90\\scratchpad";

const ALL_GAMES = [
	{name: "tekken", cue: "D:\\PSX\\Tekken 3 (USA)\\Tekken 3 (USA).cue", frames: [900, 1800, 2700]},
	{name: "diablo", cue: "D:\\PSX\\Diablo (USA) (En,Fr,De,Sv)\\Diablo (USA) (En,Fr,De,Sv).cue", frames: [900, 1800, 2700]},
	{name: "crash", bin: "D:\\PSX\\Crash Bandicoot (USA)\\Crash Bandicoot (USA).bin", frames: [900, 1800]},
	{name: "nekketsu", bin: null, frames: [900, 1800]},
];
const only = process.env.GAME || "";
const GAMES = only ? ALL_GAMES.filter((g) => g.name === only) : ALL_GAMES;

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

function loadDisc(g) {
	if (g.cue) {
		const dir = path.dirname(g.cue);
		const entries = parseCue(fs.readFileSync(g.cue, "utf8"));
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
	const b = fs.readFileSync(g.bin);
	return {buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), tracks: null};
}

const RUN = process.env.PSX_GAMES === "1";
(RUN ? it : it.skip)("boots every game", () => {
	const bios = fs.readFileSync(BIOS_PATH);
	const biosBuf = bios.buffer.slice(bios.byteOffset, bios.byteOffset + bios.byteLength);
	const report = [];
	for (const g of GAMES) {
		if (g.bin === null && g.name === "nekketsu") {
			const dir = "D:\\PSX\\Nekketsu Oyako (Japan) [En by PentarouZero v1.0d]";
			const bin = fs.readdirSync(dir).find((f) => /\.(bin|img)$/i.test(f));
			if (!bin) { report.push([g.name, "no bin found"]); continue; }
			g.bin = path.join(dir, bin);
		}
		const disc = loadDisc(g);
		const psx = new PSX();
		let tty = "";
		psx.cpu.onTty = (ch) => { tty += ch; };
		psx.insertDisc(disc.buffer, true, disc.tracks);
		psx.loadBios(biosBuf);
		psx.fastBootDisc();
		const far = performance.now() + 1e9;
		const hashes = [];
		let f = 0;
		for (const mark of g.frames) {
			for (; f < mark; f++) {
				psx.runFrame(far);
				// tap X and Start now and then to advance past title screens
				psx.joypad.buttons = (f % 150) < 8 ? ((f % 300) < 150 ? ~0x0040 : ~0x0008) & 0xffff : 0xffff;
			}
			let sum = 0;
			for (let i = 0; i < psx.gpu.vram.length; i += 1031) sum = (sum + psx.gpu.vram[i]) | 0;
			hashes.push((sum >>> 0).toString(16));
			const w = psx.gpu.hres || 320;
			const h = psx.gpu.vres || 240;
			const out = new Uint32Array(w * h);
			psx.gpu.renderDisplay(out, w, h);
			saveBmp(`${OUT_DIR}\\${g.name}-f${mark}.bmp`, out, w, h);
		}
		report.push([g.name, hashes.join(","), JSON.stringify(tty.slice(-90))]);
	}
	console.log(JSON.stringify(report, null, 1));
}, 1800000);
