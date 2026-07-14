import {GPU} from "../../src/gpu/gpu";

/** @return {GPU} */
function makeGpu() {
	const gpu = new GPU(() => {});
	gpu.gp0(0xe3000000);                      // draw area TL (0,0)
	gpu.gp0(0xe4000000 | (511 << 10) | 1023); // draw area BR (1023,511)
	gpu.gp0(0xe5000000);                      // offset (0,0)
	return gpu;
}

describe("GPU", () => {
	it("fills a rectangle with GP0(02)", () => {
		const gpu = makeGpu();
		gpu.gp0(0x02_0000ff | 0);     // fill, color = red 0xff
		gpu.gp0((16 << 16) | 32);     // y=16, x=32
		gpu.gp0((8 << 16) | 32);      // h=8, w=32
		expect(gpu.vram[16 * 1024 + 32]).toBe(0x1f); // 5bit red
		expect(gpu.vram[23 * 1024 + 63]).toBe(0x1f);
		expect(gpu.vram[24 * 1024 + 32]).toBe(0);    // below
		expect(gpu.vram[16 * 1024 + 64]).toBe(0);    // right
	});

	it("rasterizes a flat triangle", () => {
		const gpu = makeGpu();
		gpu.gp0(0x20_00f800 | 0);          // flat tri, green 0xf8
		gpu.gp0(0);                        // v0 (0,0)
		gpu.gp0(64);                       // v1 (64,0)
		gpu.gp0(64 << 16);                 // v2 (0,64)
		// a pixel well inside
		expect(gpu.vram[10 * 1024 + 10]).toBe(0x1f << 5);
		// outside the hypotenuse
		expect(gpu.vram[60 * 1024 + 60]).toBe(0);
	});

	it("rasterizes a monochrome opaque rect with draw offset", () => {
		const gpu = makeGpu();
		gpu.gp0(0xe5000000 | (10 << 11) | 10); // offset (10,10)
		gpu.gp0(0x60_0000ff | 0);              // variable-size rect, red
		gpu.gp0(0);                            // xy (0,0) + offset
		gpu.gp0((2 << 16) | 4);                // 4x2
		expect(gpu.vram[10 * 1024 + 10]).toBe(0x1f);
		expect(gpu.vram[11 * 1024 + 13]).toBe(0x1f);
		expect(gpu.vram[12 * 1024 + 10]).toBe(0);
	});

	it("clips to the drawing area", () => {
		const gpu = makeGpu();
		gpu.gp0(0xe4000000 | (19 << 10) | 19); // draw area BR (19,19)
		gpu.gp0(0x60_0000ff | 0);
		gpu.gp0((15 << 16) | 15);
		gpu.gp0((10 << 16) | 10);              // 10x10 from (15,15)
		expect(gpu.vram[19 * 1024 + 19]).toBe(0x1f);
		expect(gpu.vram[20 * 1024 + 15]).toBe(0);
		expect(gpu.vram[15 * 1024 + 20]).toBe(0);
	});

	it("transfers CPU->VRAM and reads back VRAM->CPU", () => {
		const gpu = makeGpu();
		gpu.gp0(0xa0000000);
		gpu.gp0((8 << 16) | 4);       // to (4,8)
		gpu.gp0((1 << 16) | 4);       // 4x1
		gpu.gp0(0x2222_1111 | 0);
		gpu.gp0(0x4444_3333 | 0);
		expect(gpu.vram[8 * 1024 + 4]).toBe(0x1111);
		expect(gpu.vram[8 * 1024 + 7]).toBe(0x4444);

		gpu.gp0(0xc0000000);
		gpu.gp0((8 << 16) | 4);
		gpu.gp0((1 << 16) | 4);
		expect((gpu.readStatus() >> 27) & 1).toBe(1); // read pending
		expect(gpu.readData() >>> 0).toBe(0x22221111);
		expect(gpu.readData() >>> 0).toBe(0x44443333);
		expect((gpu.readStatus() >> 27) & 1).toBe(0);
	});

	it("draws 4bit CLUT textured rects", () => {
		const gpu = makeGpu();
		// texture at page (0,0): one word holding indices 1,2,3,0
		gpu.vram[0] = (0 << 12) | (3 << 8) | (2 << 4) | 1;
		// CLUT at x=0,y=1: entries
		gpu.vram[1024 + 1] = 0x7c00; // index1 = blue
		gpu.vram[1024 + 2] = 0x03e0; // index2 = green
		gpu.vram[1024 + 3] = 0x001f; // index3 = red
		gpu.gp0(0xe1000000);         // texpage 0, 4bit
		// textured rect 4x1 at (100,100), raw (no modulation)
		gpu.gp0(0x65_808080 | 0);
		gpu.gp0((100 << 16) | 100);
		const clut = (1 << 6) | 0;   // clut y=1, x=0
		gpu.gp0((clut << 16) | 0);   // uv (0,0)
		gpu.gp0((1 << 16) | 4);
		expect(gpu.vram[100 * 1024 + 100]).toBe(0x7c00);
		expect(gpu.vram[100 * 1024 + 101]).toBe(0x03e0);
		expect(gpu.vram[100 * 1024 + 102]).toBe(0x001f);
		// index 0 texel = fully transparent, pixel untouched
		expect(gpu.vram[100 * 1024 + 103]).toBe(0);
	});

	it("applies semi-transparency mode 1 (add)", () => {
		const gpu = makeGpu();
		gpu.vram[0] = 0x0010; // back: red 16
		gpu.gp0(0x62_0000f8 | 0);  // semi rect, red 0xf8 -> 31
		gpu.gp0(0);
		gpu.gp0((1 << 16) | 1);
		// default semi mode 0: B/2+F/2 = 8+15 = 23
		expect(gpu.vram[0] & 0x1f).toBe(23);
	});

	it("reports resolution and display state in GPUSTAT", () => {
		const gpu = makeGpu();
		gpu.gp1(0x08000001); // 320x240
		expect((gpu.readStatus() >> 17) & 3).toBe(1);
		gpu.gp1(0x03000000); // display on
		expect((gpu.readStatus() >> 23) & 1).toBe(0);
		gpu.gp1(0x03000001);
		expect((gpu.readStatus() >> 23) & 1).toBe(1);
	});

	it("renders the display area to RGBA", () => {
		const gpu = makeGpu();
		gpu.gp1(0x03000000);          // display on
		gpu.gp1(0x05000000);          // display from (0,0)
		gpu.vram[0] = 0x001f;         // red
		gpu.vram[1] = 0x03e0;         // green
		const out = new Uint32Array(4 * 2);
		gpu.renderDisplay(out, 4, 2);
		expect(out[0] >>> 0).toBe(0xff0000f8); // ABGR: red
		expect(out[1] >>> 0).toBe(0xff00f800); // green
	});
});
