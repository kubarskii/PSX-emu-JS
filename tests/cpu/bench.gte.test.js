import {GTE} from "../../src/cpu/gte";

it("GTE throughput", () => {
	const gte = new GTE();
	// realistic setup: rotation matrix, translation, projection
	gte.setCtrl(0, (0x0f00 << 16) | 0x0e4c);
	gte.setCtrl(1, (0x0b3c << 16) | 0xfce1);
	gte.setCtrl(2, (0x0d2b << 16) | 0x0f00);
	gte.setCtrl(3, (0xf326 << 16) | 0x0e10);
	gte.setCtrl(4, 0x0d2b);
	gte.setCtrl(5, 100); gte.setCtrl(6, -200); gte.setCtrl(7, 4000);
	gte.setCtrl(24, 320 << 16); gte.setCtrl(25, 120 << 16);
	gte.setCtrl(26, 640); gte.setCtrl(29, 0x155); gte.setCtrl(30, 0x100);
	for (let i = 0; i < 3; i++) {
		gte.setData(i * 2, ((100 + i * 50) << 16) | (200 - i * 30));
		gte.setData(i * 2 + 1, 500 + i * 100);
	}
	gte.setData(6, 0x11808080);
	gte.setData(8, 0x0800);
	// warmup
	for (let n = 0; n < 1000; n++) { gte.execute((1 << 19) | 0x30); gte.execute(0x06); gte.execute(0x2d); }
	const t0 = performance.now();
	for (let n = 0; n < 200000; n++) {
		gte.execute((1 << 19) | 0x30);       // RTPT
		gte.execute(0x06);                   // NCLIP
		gte.execute(0x2d);                   // AVSZ3
		gte.execute((1 << 19) | (1 << 10) | 0x13); // NCDS
	}
	const dt = performance.now() - t0;
	console.log(`gte: ${dt.toFixed(1)} ms for 200k op-groups (${(dt * 5).toFixed(0)} ns/group)`);
}, 120000);
