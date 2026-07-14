import {GPU} from "../../src/gpu/gpu";

/**
 * Adjacent-primitive coverage: meshes built from triangles/quads sharing
 * edges (the way every PSX game draws) must cover their interior exactly,
 * with no cracks between neighbours. This is what shows up in games as
 * 1px horizontal/vertical tears.
 */

/** @return {GPU} */
function makeGpu() {
	const gpu = new GPU(() => {});
	gpu.gp0(0xe3000000);
	gpu.gp0(0xe4000000 | (511 << 10) | 1023);
	gpu.gp0(0xe5000000);
	return gpu;
}

const xy = (x, y) => ((y & 0x7ff) << 16) | (x & 0x7ff);

/** draws a quad as two triangles, like games do */
function quad(gpu, x0, y0, x1, y1) {
	gpu.gp0(0x2800ffff | 0); // opaque flat quad (white-ish)
	gpu.gp0(xy(x0, y0));
	gpu.gp0(xy(x1, y0));
	gpu.gp0(xy(x0, y1));
	gpu.gp0(xy(x1, y1));
}

/**
 * @return {number} - unpainted pixels strictly inside [x0,y0)-(x1,y1)
 */
function holes(gpu, x0, y0, x1, y1) {
	let n = 0;
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			if (gpu.vram[y * 1024 + x] === 0) n++;
		}
	}
	return n;
}

describe("mesh seams", () => {
	it("a quad grid sharing horizontal and vertical edges has no cracks", () => {
		const gpu = makeGpu();
		for (let gy = 0; gy < 4; gy++) {
			for (let gx = 0; gx < 4; gx++) {
				quad(gpu, 100 + gx * 40, 100 + gy * 30, 100 + (gx + 1) * 40, 100 + (gy + 1) * 30);
			}
		}
		expect(holes(gpu, 100, 100, 100 + 160, 100 + 120)).toBe(0);
	});

	it("a triangle fan around a center has no cracks", () => {
		const gpu = makeGpu();
		const cx = 400, cy = 300, R = 60;
		const pts = [];
		for (let i = 0; i <= 12; i++) {
			const a = (i / 12) * Math.PI * 2;
			pts.push([Math.round(cx + R * Math.cos(a)), Math.round(cy + R * Math.sin(a))]);
		}
		for (let i = 0; i < 12; i++) {
			gpu.gp0(0x2000ff40 | 0);
			gpu.gp0(xy(cx, cy));
			gpu.gp0(xy(pts[i][0], pts[i][1]));
			gpu.gp0(xy(pts[i + 1][0], pts[i + 1][1]));
		}
		// check a disc safely inside the fan
		let n = 0;
		const r2 = (R - 3) * (R - 3);
		for (let y = cy - R + 3; y < cy + R - 3; y++) {
			for (let x = cx - R + 3; x < cx + R - 3; x++) {
				const dx = x - cx, dy = y - cy;
				if (dx * dx + dy * dy <= r2 && gpu.vram[y * 1024 + x] === 0) n++;
			}
		}
		expect(n).toBe(0);
	});

	it("a strip of skewed triangles (uneven diagonal) has no cracks", () => {
		const gpu = makeGpu();
		// terrain-like strip: two rows of vertices with jitter
		const top = [];
		const bot = [];
		for (let i = 0; i <= 8; i++) {
			top.push([100 + i * 35 + ((i * 7) % 5), 400 + ((i * 3) % 7)]);
			bot.push([100 + i * 35 + ((i * 11) % 5), 460 + ((i * 5) % 7)]);
		}
		for (let i = 0; i < 8; i++) {
			gpu.gp0(0x2000ffff | 0);
			gpu.gp0(xy(top[i][0], top[i][1]));
			gpu.gp0(xy(top[i + 1][0], top[i + 1][1]));
			gpu.gp0(xy(bot[i][0], bot[i][1]));
			gpu.gp0(0x2000ffff | 0);
			gpu.gp0(xy(top[i + 1][0], top[i + 1][1]));
			gpu.gp0(xy(bot[i + 1][0], bot[i + 1][1]));
			gpu.gp0(xy(bot[i][0], bot[i][1]));
		}
		// safely-interior band of the strip
		expect(holes(gpu, 120, 410, 360, 455)).toBe(0);
	});
});
