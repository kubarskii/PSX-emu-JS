import {MDEC} from "../../src/mdec/mdec";

/**
 * Uploads the canonical IDCT scale table: 15bit fixed-point cosines,
 * row 0 = 0x5A82 — exactly what the SDK/games upload on real hardware
 * (verified live: Diablo uploads these values).
 */
function uploadScale(mdec) {
	const t = new Int16Array(64);
	for (let y = 0; y < 8; y++) {
		for (let x = 0; x < 8; x++) {
			const c = y === 0 ? Math.SQRT1_2 : 1;
			t[x + y * 8] = Math.round(c * Math.cos(((2 * x + 1) * y * Math.PI) / 16) * 0x8000);
		}
	}
	mdec.writeWord(0x60000000);
	for (let i = 0; i < 64; i += 2) {
		mdec.writeWord((t[i] & 0xffff) | (t[i + 1] << 16));
	}
}

/** uploads flat quant tables (all ones) */
function uploadQuant(mdec) {
	mdec.writeWord(0x40000001);
	for (let i = 0; i < 32; i++) mdec.writeWord(0x01010101);
}

/**
 * Feeds a color macroblock where every block is DC-only.
 * @param {MDEC} mdec
 * @param {number} depth - 2=24bpp 3=15bpp
 * @param {number} dc - 10bit signed DC for the luma blocks
 */
function decodeDcMacroblock(mdec, depth, dc) {
	const qscale = 1;
	const dcCode = (qscale << 10) | (dc & 0x3ff);
	const codes = [];
	for (let b = 0; b < 6; b++) {
		codes.push(b < 2 ? (qscale << 10) : dcCode); // Cr/Cb DC=0, Y DC=dc
		codes.push(0xfe00);
	}
	if (codes.length & 1) codes.push(0xfe00);
	const words = codes.length / 2;
	mdec.writeWord((1 << 29) | (depth << 27) | words);
	for (let i = 0; i < codes.length; i += 2) {
		mdec.writeWord(codes[i] | (codes[i + 1] << 16));
	}
}

describe("MDEC", () => {
	it("decodes a DC-only macroblock into a uniform 15bpp tile", () => {
		const mdec = new MDEC();
		uploadScale(mdec);
		uploadQuant(mdec);
		decodeDcMacroblock(mdec, 3, 200);
		// 16x16 pixels, 2 per word
		expect(mdec.outLen).toBe(128);
		const first = mdec.readWord() >>> 0;
		let uniform = true;
		for (let i = 1; i < 128; i++) {
			if ((mdec.readWord() >>> 0) !== first) uniform = false;
		}
		expect(uniform).toBe(true);
		// theoretical flat IDCT output: DC/8 = 25 -> +128 bias = 153,
		// 5bit channel = 19. Pins the pipeline's absolute brightness.
		const px = first & 0xffff;
		expect(px & 0x1f).toBe(19);
	});

	it("emits 24bpp macroblocks as 192 words", () => {
		const mdec = new MDEC();
		uploadScale(mdec);
		uploadQuant(mdec);
		decodeDcMacroblock(mdec, 2, 100);
		expect(mdec.outLen).toBe(192); // 256 px * 3 bytes / 4
	});

	it("reports fifo and request status", () => {
		const mdec = new MDEC();
		expect(mdec.readStatus() >>> 31).toBe(1);       // out empty
		uploadScale(mdec);
		uploadQuant(mdec);
		mdec.writeControl(0x60000000);                  // enable both DMA requests
		expect((mdec.readStatus() >>> 28) & 1).toBe(1); // in request
		expect((mdec.readStatus() >>> 27) & 1).toBe(0); // no data yet
		decodeDcMacroblock(mdec, 3, 50);
		expect(mdec.readStatus() >>> 31).toBe(0);       // data available
		expect((mdec.readStatus() >>> 27) & 1).toBe(1); // out request
		while (mdec.outPos < mdec.outLen) mdec.readWord();
		expect(mdec.readStatus() >>> 31).toBe(1);
	});

	it("reset aborts everything", () => {
		const mdec = new MDEC();
		uploadScale(mdec);
		uploadQuant(mdec);
		decodeDcMacroblock(mdec, 3, 50);
		mdec.writeControl(0x80000000);
		expect(mdec.readStatus() >>> 31).toBe(1);
		expect(mdec.outLen).toBe(0);
	});

	it("negative DC darkens, positive brightens", () => {
		const grey = (dc) => {
			const m = new MDEC();
			uploadScale(m);
			uploadQuant(m);
			decodeDcMacroblock(m, 3, dc);
			return m.readWord() & 0x1f;
		};
		expect(grey(300)).toBeGreaterThan(grey(0));
		expect(grey(0)).toBeGreaterThan(grey(-300));
	});
});
