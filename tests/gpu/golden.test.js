import {GPU} from "../../src/gpu/gpu";

/**
 * Pixel-perfect regression suite for the rasterizer: every scenario
 * hashes the whole VRAM. Any change to pixel coverage, blending,
 * texturing or masking shows up as a hash mismatch. GOLDEN values are
 * captured from the reference implementation - update them ONLY when a
 * rendering difference is intended and visually verified.
 */

/**
 * @param {Uint16Array} vram
 * @return {number} - FNV-1a over the VRAM bytes
 */
function hashVram(vram) {
	let h = 0x811c9dc5;
	for (let i = 0; i < vram.length; i++) {
		h ^= vram[i] & 0xff;
		h = Math.imul(h, 0x01000193);
		h ^= vram[i] >>> 8;
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** @return {GPU} - GPU with an open draw area and a seeded texture+CLUT */
function makeGpu() {
	const gpu = new GPU(() => {});
	gpu.gp0(0xe3000000);
	gpu.gp0(0xe4000000 | (511 << 10) | 1023);
	gpu.gp0(0xe5000000);
	// deterministic "noise" texture at page (0,0), rows 0-63
	for (let i = 0; i < 1024 * 64; i++) {
		gpu.vram[i] = (Math.imul(i, 2654435761) >>> 13) & 0xffff;
	}
	// CLUT at y=400: 256 entries
	for (let i = 0; i < 256; i++) {
		gpu.vram[400 * 1024 + i] = (Math.imul(i + 7, 40503) & 0x7fff) | ((i & 1) << 15);
	}
	return gpu;
}

/** scenario table: name -> GP0 command stream */
const SCENARIOS = {
	flat_tri: [0x2000c040, xy(50, 30), xy(300, 60), xy(120, 220)],
	flat_tri_ccw: [0x2000c040, xy(120, 220), xy(300, 60), xy(50, 30)],
	gouraud_tri: [0x300000ff, xy(10, 10), 0x0000ff00, xy(250, 40), 0x00ff0000, xy(90, 200)],
	semi0_tri: [0x22808080, xy(40, 40), xy(200, 50), xy(100, 180)],
	semi_modes: null, // custom
	tex4_tri: null,
	tex8_gouraud_quad: null,
	tex15_raw_quad: null,
	texture_window: null,
	rect_flat: [0x60ff2010, xy(500, 100), xy(60, 40)],
	rect_tex_raw: null,
	rect_16x16: [0x7c3040f0, xy(600, 300), (((400 << 6) | 0) << 16) | 0x0a04],
	line_gouraud: [0x50ff0000, xy(30, 400), 0x0000ff00 | 0, xy(280, 480)],
	polyline: [0x48ffffff, xy(300, 300), xy(340, 340), xy(300, 380), 0x55555555],
	masked: null,
	offset_clip: null,
};

/** @return {number} */
function xy(x, y) {
	return ((y & 0x7ff) << 16) | (x & 0x7ff);
}

/**
 * @param {GPU} gpu
 * @param {string} name
 */
function run(gpu, name) {
	const words = SCENARIOS[name];
	if (words !== null) {
		for (const w of words) gpu.gp0(w | 0);
		return;
	}
	switch (name) {
	case "semi_modes":
		for (let mode = 0; mode < 4; mode++) {
			gpu.gp0(0xe1000000 | (mode << 5));
			gpu.gp0(0x2200ffff | 0);
			gpu.gp0(xy(40 + mode * 90, 250));
			gpu.gp0(xy(110 + mode * 90, 260));
			gpu.gp0(xy(70 + mode * 90, 350));
		}
		gpu.gp0(0xe1000000);
		return;
	case "tex4_tri": {
		// flat textured tri, 4bit CLUT at (0,400), page (0,0)
		const clut = ((400 << 6) | 0) << 16;
		gpu.gp0(0x24808080 | 0);
		gpu.gp0(xy(400, 20));
		gpu.gp0(clut | 0x0000);          // uv (0,0) + clut
		gpu.gp0(xy(560, 30));
		gpu.gp0(0x00000000 | 0x0050);    // uv (80,0) + page 0 (4bit)
		gpu.gp0(xy(430, 170));
		gpu.gp0(0x00003f28);             // uv (40,63)
		return;
	}
	case "tex8_gouraud_quad": {
		// gouraud textured quad, 8bit (page word sets depth bit 7)
		const clut = ((400 << 6) | 0) << 16;
		const page = (1 << 7) << 16;     // texDepth=1 (8bit)
		gpu.gp0(0x3c4040c0 | 0);
		gpu.gp0(xy(420, 120));
		gpu.gp0(clut | 0x0000);
		gpu.gp0(0x00c04040 | 0);
		gpu.gp0(xy(560, 130));
		gpu.gp0(page | 0x0060);          // uv (96,0)
		gpu.gp0(0x4040c040 | 0);
		gpu.gp0(xy(430, 250));
		gpu.gp0(0x00003f00);             // uv (0,63)
		gpu.gp0(0x40c04040 | 0);
		gpu.gp0(xy(555, 245));
		gpu.gp0(0x00003f60);             // uv (96,63)
		return;
	}
	case "tex15_raw_quad": {
		const page = (2 << 7) << 16;     // texDepth=2 (15bit direct)
		gpu.gp0(0x2d000000 | 0);
		gpu.gp0(xy(700, 50));
		gpu.gp0(0x00000000);             // uv (0,0), clut unused
		gpu.gp0(xy(860, 55));
		gpu.gp0(page | 0x00c0);          // uv (192,0)
		gpu.gp0(xy(705, 200));
		gpu.gp0(0x00003f00);             // uv (0,63)
		gpu.gp0(xy(850, 210));
		gpu.gp0(0x00003fc0);             // uv (192,63)
		return;
	}
	case "texture_window": {
		const clut = ((400 << 6) | 0) << 16;
		gpu.gp0(0xe2000000 | 3 | (1 << 5) | (3 << 10) | (2 << 15)); // masks+offsets
		gpu.gp0(0x24ffffff | 0);
		gpu.gp0(xy(150, 380));
		gpu.gp0(clut | 0x0000);
		gpu.gp0(xy(260, 385));
		gpu.gp0(0x00000070);             // uv (112,0), page 0
		gpu.gp0(xy(160, 470));
		gpu.gp0(0x00003f38);             // uv (56,63)
		gpu.gp0(0xe2000000);
		return;
	}
	case "masked":
		gpu.gp0(0xe6000001); // set mask bit on writes
		gpu.gp0(0x2000ff00 | 0);
		gpu.gp0(xy(640, 300));
		gpu.gp0(xy(760, 310));
		gpu.gp0(xy(690, 400));
		gpu.gp0(0xe6000002); // check mask
		gpu.gp0(0x200000ff | 0);
		gpu.gp0(xy(660, 320));
		gpu.gp0(xy(780, 330));
		gpu.gp0(xy(700, 420));
		gpu.gp0(0xe6000000);
		return;
	case "offset_clip":
		gpu.gp0(0xe3000000 | (350 << 10) | 60);
		gpu.gp0(0xe4000000 | (430 << 10) | 240);
		gpu.gp0(0xe5000000 | ((20 & 0x7ff) << 11) | (40 & 0x7ff));
		gpu.gp0(0x28c040ff | 0);
		gpu.gp0(xy(0, 300));
		gpu.gp0(xy(250, 305));
		gpu.gp0(xy(5, 420));
		gpu.gp0(xy(240, 430));
		gpu.gp0(0xe3000000);
		gpu.gp0(0xe4000000 | (511 << 10) | 1023);
		gpu.gp0(0xe5000000);
		return;
	case "rect_tex_raw":
		gpu.gp0(0xe1000080); // 8bit
		gpu.gp0(0x65808080 | 0);
		gpu.gp0(xy(30, 440));
		gpu.gp0((((400 << 6) | 0) << 16) | 0x0503);
		gpu.gp0(xy(90, 50));
		return;
	default:
		throw new Error("unknown scenario " + name);
	}
}

/** golden hashes captured from the reference implementation (git HEAD) */
const GOLDEN = {
	flat_tri: "8236d2f7",
	flat_tri_ccw: "8236d2f7",
	gouraud_tri: "1a45e769",
	semi0_tri: "2a0b111a",
	semi_modes: "ee542487",
	tex4_tri: "1741cdfe",
	tex8_gouraud_quad: "187186fd",
	tex15_raw_quad: "34a7bd8d",
	texture_window: "15e48d47",
	rect_flat: "990e27c6",
	rect_tex_raw: "1c7192f7",
	rect_16x16: "3e8870f2",
	line_gouraud: "814d8b01",
	polyline: "10886314",
	masked: "d42cb700",
	offset_clip: "bb58b2b5",
	combined: "453339e1",
};

describe("rasterizer golden images", () => {
	const names = Object.keys(SCENARIOS);
	for (const name of names) {
		it(`matches golden hash: ${name}`, () => {
			const gpu = makeGpu();
			run(gpu, name);
			const h = hashVram(gpu.vram).toString(16);
			if (GOLDEN[name] === undefined) {
				console.log(`GOLDEN ${name}: 0x${h}`);
			} else {
				expect(h).toBe(GOLDEN[name]);
			}
		});
	}

	it("all-scenarios combined hash", () => {
		const gpu = makeGpu();
		for (const name of Object.keys(SCENARIOS)) run(gpu, name);
		const h = hashVram(gpu.vram).toString(16);
		if (GOLDEN.combined === undefined) console.log(`GOLDEN combined: 0x${h}`);
		else expect(h).toBe(GOLDEN.combined);
	});
});
