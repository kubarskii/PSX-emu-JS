import {GPU} from "../../src/gpu/gpu";

/** records backend calls without any GL */
function mockHw() {
	const calls = [];
	return {
		calls,
		setEnv() {},
		triangle(...a) { calls.push(["triangle", ...a.slice(6)]); },
		rect(o, x, y, w, h) { calls.push(["rect", x, y, w, h]); },
		line(x0, y0, c0, x1, y1) { calls.push(["line", x0, y0, x1, y1]); },
		fill(x, y, w, h) { calls.push(["fill", x, y, w, h]); },
		copy(sx, sy, dx, dy, w, h) { calls.push(["copy", sx, sy, dx, dy, w, h]); },
		imageIn(x, y, w, h) { calls.push(["imageIn", x, y, w, h]); },
		imageOut(x, y, w, h) {
			calls.push(["imageOut", x, y, w, h]);
			return new Int32Array(Math.ceil(w * h / 2));
		},
	};
}

describe("hardware backend dispatch", () => {
	it("routes polygons, rects and lines to the backend", () => {
		const gpu = new GPU(() => {});
		gpu.hw = mockHw();
		// flat triangle
		gpu.gp0(0x20_000000 | 0xff0000);
		gpu.gp0(0x0000_0000);
		gpu.gp0(0x0000_0040);
		gpu.gp0(0x0040_0040);
		// flat quad -> two triangles
		gpu.gp0(0x28_000000);
		gpu.gp0(0);
		gpu.gp0(0x40);
		gpu.gp0(0x0040_0000);
		gpu.gp0(0x0040_0040);
		// 16x16 rect
		gpu.gp0(0x78_000000);
		gpu.gp0(0x0010_0010);
		// flat line
		gpu.gp0(0x40_000000);
		gpu.gp0(0);
		gpu.gp0(0x0020_0020);
		const kinds = gpu.hw.calls.map((c) => c[0]);
		expect(kinds).toEqual(["triangle", "triangle", "triangle", "rect", "line"]);
		expect(gpu.hw.calls[3]).toEqual(["rect", 16, 16, 16, 16]);
	});

	it("mirrors fills, copies and uploads into shadow VRAM and the backend", () => {
		const gpu = new GPU(() => {});
		gpu.hw = mockHw();
		gpu.gp0(0x02_00007c); // fill 32x16 at (16,16) with color
		gpu.gp0(0x0010_0010);
		gpu.gp0(0x0010_0020);
		expect(gpu.hw.calls[0]).toEqual(["fill", 16, 16, 32, 16]);
		expect(gpu.vram[16 * 1024 + 16]).not.toBe(0);

		// upload a 4x2 rect, then copy it
		gpu.gp0(0xa0_000000);
		gpu.gp0(0x0000_0000);
		gpu.gp0(0x0002_0004);
		gpu.gp0(0x1111_2222);
		gpu.gp0(0x3333_4444);
		gpu.gp0(0x5555_6666);
		gpu.gp0(0x7777_0001);
		expect(gpu.hw.calls[1]).toEqual(["imageIn", 0, 0, 4, 2]);
		expect(gpu.vram[0]).toBe(0x2222);

		gpu.gp0(0x80_000000);
		gpu.gp0(0x0000_0000);
		gpu.gp0(0x0000_0100);
		gpu.gp0(0x0002_0004);
		expect(gpu.hw.calls[2]).toEqual(["copy", 0, 0, 256, 0, 4, 2]);
		expect(gpu.vram[256]).toBe(0x2222); // shadow copy still applied
	});

	it("reads VRAM->CPU through the backend", () => {
		const gpu = new GPU(() => {});
		gpu.hw = mockHw();
		gpu.gp0(0xc0_000000);
		gpu.gp0(0x0000_0000);
		gpu.gp0(0x0001_0002);
		expect(gpu.hw.calls[0]).toEqual(["imageOut", 0, 0, 2, 1]);
		expect(gpu.readStatus() & (1 << 27)).not.toBe(0); // read ready
	});
});
