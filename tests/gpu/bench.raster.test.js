import {GPU} from "../../src/gpu/gpu";

/** draws a heavy mixed scene once */
function scene(gpu, seed) {
	const xy = (x, y) => ((y & 0x7ff) << 16) | (x & 0x7ff);
	const clut = ((400 << 6) | 0) << 16;
	for (let i = 0; i < 60; i++) {
		const x = (seed + i * 37) % 700;
		const y = (seed + i * 53) % 300;
		// gouraud textured quad
		gpu.gp0(0x3c808080);
		gpu.gp0(xy(x, y)); gpu.gp0(clut | 0x0000);
		gpu.gp0(0x00c04040); gpu.gp0(xy(x + 180, y + 10)); gpu.gp0(0x0060);
		gpu.gp0(0x4040c040); gpu.gp0(xy(x + 15, y + 150)); gpu.gp0(0x3f00);
		gpu.gp0(0x40c04040); gpu.gp0(xy(x + 170, y + 160)); gpu.gp0(0x3f60);
		// flat tri
		gpu.gp0(0x2000c040);
		gpu.gp0(xy(x + 30, y)); gpu.gp0(xy(x + 200, y + 40)); gpu.gp0(xy(x + 60, y + 170));
	}
}

it("raster throughput", () => {
	const gpu = new GPU(() => {});
	gpu.gp0(0xe3000000);
	gpu.gp0(0xe4000000 | (511 << 10) | 1023);
	gpu.gp0(0xe5000000);
	for (let i = 0; i < 1024 * 64; i++) gpu.vram[i] = (Math.imul(i, 2654435761) >>> 13) & 0xffff;
	scene(gpu, 1); // warmup
	const t0 = performance.now();
	for (let n = 0; n < 40; n++) scene(gpu, n);
	const dt = performance.now() - t0;
	console.log(`raster: ${dt.toFixed(1)} ms for 40 heavy scenes (${(dt / 40).toFixed(2)} ms/scene)`);
}, 120000);
