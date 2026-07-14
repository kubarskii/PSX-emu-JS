import {GTE} from "../../src/cpu/gte";

/** identity rotation matrix in 3.12 fixed point */
function identity(gte) {
	gte.setCtrl(0, 0x1000);          // RT11=1.0, RT12=0
	gte.setCtrl(1, 0);               // RT13, RT21
	gte.setCtrl(2, 0x1000);          // RT22, RT23
	gte.setCtrl(3, 0);               // RT31, RT32
	gte.setCtrl(4, 0x1000);          // RT33
	gte.setCtrl(5, 0);               // TRX
	gte.setCtrl(6, 0);
	gte.setCtrl(7, 0);
}

describe("GTE", () => {
	it("RTPS projects a vertex through the identity matrix", () => {
		const gte = new GTE();
		identity(gte);
		gte.setCtrl(24, 0);           // OFX
		gte.setCtrl(25, 0);           // OFY
		gte.setCtrl(26, 150);         // H
		gte.setCtrl(27, 0);           // DQA
		gte.setCtrl(28, 0);           // DQB
		gte.setData(0, (0xffec << 16) | 10); // V0 = (10, -20)
		gte.setData(1, 100);                 // VZ0 = 100

		gte.execute((1 << 19) | 0x01); // RTPS sf=1

		expect(gte.getData(19)).toBe(100);   // SZ3
		const sxy = gte.getData(14);
		expect((sxy << 16) >> 16).toBe(15);  // SX2 = 150/100 * 10 / ... (UNR)
		expect(sxy >> 16).toBe(-30);         // SY2
		expect(gte.getData(9)).toBe(10);     // IR1
		expect(gte.getData(10)).toBe(-20);   // IR2
		expect(gte.getData(11)).toBe(100);   // IR3
	});

	it("RTPS flags divide overflow when the vertex is too close", () => {
		const gte = new GTE();
		identity(gte);
		gte.setCtrl(26, 1000);        // H
		gte.setData(0, 0);
		gte.setData(1, 100);          // SZ3=100, H >= SZ3*2 -> overflow
		gte.execute((1 << 19) | 0x01);
		expect((gte.getCtrl(31) >>> 17) & 1).toBe(1);
		expect(gte.getCtrl(31) < 0).toBe(true); // master error bit
	});

	it("NCLIP computes the winding of the screen triangle", () => {
		const gte = new GTE();
		gte.setData(15, 0);                    // SXY0 (0,0) via fifo pushes
		gte.setData(15, 10);                   // SXY1 (10,0)
		gte.setData(15, 10 << 16);             // SXY2 (0,10)
		gte.execute(0x06);
		expect(gte.getData(24)).toBe(100);     // MAC0 = cross product
	});

	it("AVSZ3 averages the SZ fifo with ZSF3", () => {
		const gte = new GTE();
		gte.setCtrl(29, 0x155);       // ZSF3 ~ 1/3 in .12
		gte.setData(17, 300);
		gte.setData(18, 300);
		gte.setData(19, 300);
		gte.execute(0x2d);
		// 0x155 * 900 >> 12 = 76 (truncated)
		expect(gte.getData(7)).toBe((0x155 * 900) >> 12);
	});

	it("MVMVA multiplies vector by the identity matrix", () => {
		const gte = new GTE();
		identity(gte);
		gte.setData(0, (50 << 16) | 30);
		gte.setData(1, 70);
		// MVMVA sf=1, mx=RT, v=V0, cv=none, lm=0
		gte.execute((1 << 19) | (3 << 13) | 0x12);
		expect(gte.getData(25)).toBe(30);  // MAC1
		expect(gte.getData(26)).toBe(50);  // MAC2
		expect(gte.getData(27)).toBe(70);  // MAC3
	});

	it("saturates IR and sets flags", () => {
		const gte = new GTE();
		identity(gte);
		gte.setCtrl(0, 0x7fff0000 | 0x1000); // RT12 huge
		gte.setData(0, 0x7fff0000 | 0);      // V0 = (0, 32767)
		gte.setData(1, 0);
		gte.execute((1 << 19) | (3 << 13) | 0x12); // MVMVA
		// MAC1 = 32767*32767 >> 12 far above 0x7fff -> IR1 saturates
		expect(gte.getData(9)).toBe(0x7fff);
		expect((gte.getCtrl(31) >>> 24) & 1).toBe(1);
	});

	it("LZCR counts leading zeros and ones", () => {
		const gte = new GTE();
		gte.setData(30, 1);
		expect(gte.getData(31)).toBe(31);
		gte.setData(30, -1);
		expect(gte.getData(31)).toBe(32);
		gte.setData(30, 0x0000ffff);
		expect(gte.getData(31)).toBe(16);
		gte.setData(30, 0xff000000 | 0);
		expect(gte.getData(31)).toBe(8);
	});

	it("SQR squares IR1-3", () => {
		const gte = new GTE();
		gte.setData(9, 100);
		gte.setData(10, -50);
		gte.setData(11, 3);
		gte.execute(0x28); // sf=0
		expect(gte.getData(25)).toBe(10000);
		expect(gte.getData(26)).toBe(2500);
		expect(gte.getData(27)).toBe(9);
	});

	it("GPF interpolates colors and pushes the fifo", () => {
		const gte = new GTE();
		gte.setData(6, 0x11223344 | 0); // RGBC (code 0x11)
		gte.setData(8, 0x1000);         // IR0 = 1.0
		gte.setData(9, 0x100);
		gte.setData(10, 0x200);
		gte.setData(11, 0x300);
		gte.execute((1 << 19) | 0x3d);  // GPF sf=1
		// MAC = IR * IR0 >> 12 = IR; color = MAC >> 4
		const rgb2 = gte.getData(22);
		expect(rgb2 & 0xff).toBe(0x10);
		expect((rgb2 >> 8) & 0xff).toBe(0x20);
		expect((rgb2 >> 16) & 0xff).toBe(0x30);
		expect((rgb2 >>> 24) & 0xff).toBe(0x11); // CODE carried over
	});
});
