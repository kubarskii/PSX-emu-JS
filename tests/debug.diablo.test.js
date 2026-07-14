/** Diagnostic: capture Diablo's early copyright screen (scratchy font check). */
/* eslint-env node */
import * as fs from "fs";
import {PSX} from "../src/psx";

const BIOS_PATH = "C:\\Users\\Aleksandr\\Downloads\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101] (1)\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101].bin";
const BIN = "D:\\PSX\\Diablo (USA) (En,Fr,De,Sv)\\Diablo (USA) (En,Fr,De,Sv).bin";
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

it("dumps Diablo early frames around the copyright screen", () => {
	const bin = fs.readFileSync(BIN);
	const bios = fs.readFileSync(BIOS_PATH);
	const psx = new PSX();
	psx.insertDisc(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), true);
	psx.loadBios(bios.buffer.slice(bios.byteOffset, bios.byteOffset + bios.byteLength));
	psx.fastBootDisc();
	const tag = process.env.PSX_NOJIT === "1" ? "nojit" : "jit";
	if (process.env.PSX_NOJIT === "1") psx.blocks.compile = () => null;

	const far = performance.now() + 1e9;
	for (let f2 = 0; f2 < 1200; f2++) {
		psx.runFrame(far);
		if (f2 >= 100 && f2 % 100 === 0) {
			const w = psx.gpu.hres || 320, h = psx.gpu.vres || 240;
			const out = new Uint32Array(w * h);
			psx.gpu.renderDisplay(out, w, h);
			saveBmp(`${OUT_DIR}\\diablo-${tag}-f${f2}.bmp`, out, w, h);
		}
	}
}, 1800000);
