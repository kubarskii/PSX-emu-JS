/** Diagnostic: HP — pass language selection, capture the title screen (red-dot corruption). */
/* eslint-env node */
import * as fs from "fs";
import * as path from "path";
import {PSX} from "../src/psx";
import {parseCue, buildDisc} from "../src/loader/cue";

const BIOS_PATH = "C:\\Users\\Aleksandr\\Downloads\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101] (1)\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101].bin";
const CUE = "D:\\PSX\\Harry Potter and the Sorcerer's Stone (USA) (En,Fr,Es)\\Harry Potter and the Sorcerer's Stone (USA) (En,Fr,Es).cue";
const OUT_DIR = "C:\\Users\\ALEKSA~1\\AppData\\Local\\Temp\\claude\\C--Projects-work-lambda\\939f7fa7-5a4f-4fe2-ab72-200389fccb90\\scratchpad";

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

it("boots HP to the title screen and dumps it", () => {
	const dir = path.dirname(CUE);
	const entries = parseCue(fs.readFileSync(CUE, "utf8"));
	const buffers = new Map();
	for (const e of entries) {
		const key = e.file.toLowerCase();
		if (!buffers.has(key)) {
			const b = fs.readFileSync(path.join(dir, e.file));
			buffers.set(key, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
		}
	}
	const disc = buildDisc(entries, buffers);
	const bios = fs.readFileSync(BIOS_PATH);
	const psx = new PSX();
	psx.insertDisc(disc.buffer, true, disc.tracks);
	psx.loadBios(bios.buffer.slice(bios.byteOffset, bios.byteOffset + bios.byteLength));
	psx.fastBootDisc();
	const tag = process.env.PSX_NOJIT === "1" ? "nojit" : "jit";
	if (process.env.PSX_NOJIT === "1") psx.blocks.compile = () => null; // pure interpreter

	const far = performance.now() + 1e9;
	const total = process.env.PSX_NOJIT === "1" ? 18000 : 4500;
	for (let f2 = 0; f2 < total; f2++) {
		psx.runFrame(far);
		const phase = f2 % 90;
		psx.joypad.buttons = phase < 10 ? (~0x4000 & 0xffff) : 0xffff; // hold Cross 10 frames
		if (f2 >= 4500 && f2 % 1500 === 0) {
			const w = psx.gpu.hres || 320, h = psx.gpu.vres || 240;
			const out = new Uint32Array(w * h);
			psx.gpu.renderDisplay(out, w, h);
			saveBmp(`${OUT_DIR}\\hp-title-${tag}-f${f2}.bmp`, out, w, h);
		}
	}
	const w = psx.gpu.hres || 320, h = psx.gpu.vres || 240;
	const out = new Uint32Array(w * h);
	psx.gpu.renderDisplay(out, w, h);
	saveBmp(`${OUT_DIR}\\hp-title-${tag}.bmp`, out, w, h);
	console.log("dumped", tag, w + "x" + h);
}, 1800000);
