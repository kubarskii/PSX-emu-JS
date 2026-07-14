/**
 * GTE - Geometry Transformation Engine (COP2).
 *
 * Fixed-point 3D math coprocessor: perspective transforms, lighting,
 * color interpolation. Implemented per the nocash specification with
 * 44bit accumulator flags, saturation and the hardware UNR division.
 * Intermediate per-step overflow wrapping is approximated by checking
 * the final sum of each accumulation (games virtually never depend on
 * the exact wrap of intermediate steps).
 */

const H43 = 0x80000000000;   // 2^43
const M44 = 0x100000000000;  // 2^44

/** UNR reciprocal table used by the hardware divider */
const UNR = new Uint8Array(0x101);
for (let i = 0; i <= 0x100; i++) {
	UNR[i] = Math.max(0, Math.floor((Math.floor(0x40000 / (i + 0x100)) + 1) / 2) - 0x101);
}

const MAC_POS = [0, 1 << 30, 1 << 29, 1 << 28];
const MAC_NEG = [0, 1 << 27, 1 << 26, 1 << 25];
const IR_SAT = [1 << 12, 1 << 24, 1 << 23, 1 << 22];
const COLOR_SAT = [0, 1 << 21, 1 << 20, 1 << 19];

/** read-only 3x3 zero matrix for MVMVA "garbage matrix" mode */
const ZERO_M = [0, 0, 0, 0, 0, 0, 0, 0, 0];

export class GTE {

	constructor() {
		/** data registers cop2r0-31 (stored canonically, see accessors) */
		this.d = new Int32Array(32);
		/** control registers cop2r32-63 */
		this.c = new Int32Array(32);
		this.flag = 0;
		/** reusable scratch (avoid per-command heap allocations) */
		this._v = [0, 0, 0];
		this._m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
		this._t = [0, 0, 0];
		this._t3 = [0, 0, 0];
		this._mac3 = [0, 0, 0];
	}

	/**
	 * @param {number} r - 0..31
	 * @return {number}
	 */
	getData(r) {
		const d = this.d;
		switch (r) {
		case 1: case 3: case 5: return (d[r] << 16) >> 16;
		case 7: case 16: case 17: case 18: case 19: return d[r] & 0xffff;
		case 15: return d[14]; // SXYP reads SXY2
		case 28:
		case 29: { // IRGB/ORGB: pack IR1-3 back to 5:5:5
			const r5 = sat5(d[9] >> 7), g5 = sat5(d[10] >> 7), b5 = sat5(d[11] >> 7);
			return r5 | (g5 << 5) | (b5 << 10);
		}
		case 31: { // LZCR: leading zeros/ones of LZCS
			const v = d[30] | 0;
			return v >= 0 ? Math.clz32(v) : Math.clz32(~v);
		}
		default: return d[r] | 0;
		}
	}

	/**
	 * @param {number} r - 0..31
	 * @param {number} v
	 */
	setData(r, v) {
		const d = this.d;
		switch (r) {
		case 1: case 3: case 5:
		case 8: case 9: case 10: case 11:
			d[r] = (v << 16) >> 16;
			return;
		case 7: case 16: case 17: case 18: case 19:
			d[r] = v & 0xffff;
			return;
		case 15: // SXYP write pushes the screen fifo
			d[12] = d[13];
			d[13] = d[14];
			d[14] = v | 0;
			return;
		case 28: // IRGB: unpack 5:5:5 into IR1-3
			d[28] = v & 0x7fff;
			d[9] = (v & 0x1f) * 0x80;
			d[10] = ((v >> 5) & 0x1f) * 0x80;
			d[11] = ((v >> 10) & 0x1f) * 0x80;
			return;
		case 29: case 31: return; // read-only
		default:
			d[r] = v | 0;
			return;
		}
	}

	/**
	 * @param {number} r - 0..31 (cop2r32-63)
	 * @return {number}
	 */
	getCtrl(r) {
		const c = this.c;
		switch (r) {
		case 4: case 12: case 20: // RT33/L33/LR33
		case 26:                  // H reads sign-extended (hardware quirk)
		case 27: case 29: case 30:
			return (c[r] << 16) >> 16;
		case 31: {
			let f = this.flag & 0x7ffff000;
			if ((f & 0x7f87e000) !== 0) f |= 0x80000000;
			return f | 0;
		}
		default: return c[r] | 0;
		}
	}

	/**
	 * @param {number} r - 0..31 (cop2r32-63)
	 * @param {number} v
	 */
	setCtrl(r, v) {
		if (r === 31) {
			this.flag = v & 0x7ffff000;
			return;
		}
		this.c[r] = v | 0;
	}

	/**
	 * Executes a GTE command word.
	 * @param {number} word
	 */
	execute(word) {
		this.flag = 0;
		const sf = (word & (1 << 19)) !== 0 ? 12 : 0;
		const lm = (word & (1 << 10)) !== 0;

		switch (word & 0x3f) {
		case 0x01: this.#rtps(0, sf, lm, true); return;
		case 0x06: this.#nclip(); return;
		case 0x0c: this.#op(sf, lm); return;
		case 0x10: this.#dpcs(this.d[6], sf, lm); return;
		case 0x11: this.#intpl(sf, lm); return;
		case 0x12: this.#mvmva(word, sf, lm); return;
		case 0x13: this.#ncds(0, sf, lm); return;
		case 0x14: this.#cdp(sf, lm); return;
		case 0x16: // NCDT
			this.#ncds(0, sf, lm);
			this.#ncds(1, sf, lm);
			this.#ncds(2, sf, lm);
			return;
		case 0x1b: this.#nccs(0, sf, lm); return;
		case 0x1c: this.#cc(sf, lm); return;
		case 0x1e: this.#ncs(0, sf, lm); return;
		case 0x20: // NCT
			this.#ncs(0, sf, lm);
			this.#ncs(1, sf, lm);
			this.#ncs(2, sf, lm);
			return;
		case 0x28: this.#sqr(sf, lm); return;
		case 0x29: this.#dcpl(sf, lm); return;
		case 0x2a: // DPCT: three times from the color fifo bottom
			this.#dpcs(this.d[20], sf, lm);
			this.#dpcs(this.d[20], sf, lm);
			this.#dpcs(this.d[20], sf, lm);
			return;
		case 0x2d: this.#avsz3(); return;
		case 0x2e: this.#avsz4(); return;
		case 0x30: // RTPT
			this.#rtps(0, sf, lm, false);
			this.#rtps(1, sf, lm, false);
			this.#rtps(2, sf, lm, true);
			return;
		case 0x3d: this.#gpf(sf, lm); return;
		case 0x3e: this.#gpl(sf, lm); return;
		case 0x3f: // NCCT
			this.#nccs(0, sf, lm);
			this.#nccs(1, sf, lm);
			this.#nccs(2, sf, lm);
			return;
		default:
			return; // unknown GTE opcodes execute as nop
		}
	}

	// ---- register file helpers ----------------------------------------

	/**
	 * @param {number} i - 0..2
	 * @return {number[]} - vector Vi as [x, y, z]
	 */
	#vec(i) {
		const d = this.d;
		const xy = d[i * 2];
		const v = this._v;
		v[0] = (xy << 16) >> 16;
		v[1] = xy >> 16;
		v[2] = (d[i * 2 + 1] << 16) >> 16;
		return v;
	}

	/**
	 * @param {number} base - ctrl reg base (0=rotation, 8=light, 16=color)
	 * @return {number[]} - 9 matrix cells row-major (reused buffer)
	 */
	#matrix(base) {
		const c = this.c;
		const m = this._m;
		m[0] = (c[base] << 16) >> 16;
		m[1] = c[base] >> 16;
		m[2] = (c[base + 1] << 16) >> 16;
		m[3] = c[base + 1] >> 16;
		m[4] = (c[base + 2] << 16) >> 16;
		m[5] = c[base + 2] >> 16;
		m[6] = (c[base + 3] << 16) >> 16;
		m[7] = c[base + 3] >> 16;
		m[8] = (c[base + 4] << 16) >> 16;
		return m;
	}

	/**
	 * 44bit accumulator: sets overflow flags, wraps, applies the shift and
	 * stores the (32bit-truncated) result into MACi.
	 * @param {number} i - 1..3
	 * @param {number} value - full precision sum
	 * @param {number} sf - 0 or 12
	 * @return {number} - shifted value before 32bit truncation
	 */
	#mac(i, value, sf) {
		// fast path: in-range values need no 44bit wrap (the wrap is an
		// identity there), which skips two modulo ops per accumulation
		if (value >= H43) {
			this.flag |= MAC_POS[i];
			value = ((value + H43) % M44 + M44) % M44 - H43;
		} else if (value < -H43) {
			this.flag |= MAC_NEG[i];
			value = ((value + H43) % M44 + M44) % M44 - H43;
		}
		const shifted = sf !== 0 ? Math.floor(value / 4096) : value;
		this.d[24 + i] = shifted | 0;
		return shifted;
	}

	/**
	 * @param {number} value
	 * @return {number} - value stored in MAC0 with overflow flags
	 */
	#mac0(value) {
		if (value >= 0x80000000) this.flag |= 1 << 16;
		else if (value < -0x80000000) this.flag |= 1 << 15;
		this.d[24] = value | 0;
		return value;
	}

	/**
	 * @param {number} i - 1..3
	 * @param {number} value - shifted MAC value
	 * @param {boolean} lm - clamp negative to 0
	 * @return {number}
	 */
	#ir(i, value, lm) {
		const lo = lm ? 0 : -0x8000;
		let v = value;
		if (v < lo) { v = lo; this.flag |= IR_SAT[i]; }
		else if (v > 0x7fff) { v = 0x7fff; this.flag |= IR_SAT[i]; }
		this.d[8 + i] = v;
		return v;
	}

	/**
	 * @param {number} value
	 * @return {number} - IR0 saturated 0..0x1000
	 */
	#ir0(value) {
		let v = value;
		if (v < 0) { v = 0; this.flag |= IR_SAT[0]; }
		else if (v > 0x1000) { v = 0x1000; this.flag |= IR_SAT[0]; }
		this.d[8] = v;
		return v;
	}

	/**
	 * Pushes MAC1-3 >> 4 into the color fifo with saturation.
	 */
	#pushColor() {
		const d = this.d;
		let r = d[25] >> 4, g = d[26] >> 4, b = d[27] >> 4;
		if (r < 0) { r = 0; this.flag |= COLOR_SAT[1]; } else if (r > 0xff) { r = 0xff; this.flag |= COLOR_SAT[1]; }
		if (g < 0) { g = 0; this.flag |= COLOR_SAT[2]; } else if (g > 0xff) { g = 0xff; this.flag |= COLOR_SAT[2]; }
		if (b < 0) { b = 0; this.flag |= COLOR_SAT[3]; } else if (b > 0xff) { b = 0xff; this.flag |= COLOR_SAT[3]; }
		d[20] = d[21];
		d[21] = d[22];
		d[22] = r | (g << 8) | (b << 16) | (this.d[6] & 0xff000000);
	}

	/**
	 * Matrix * vector (translation zero), storing MAC1-3/IR1-3.
	 * Reads matrix cells directly from c[base..base+4].
	 */
	#mxvNoTrans(base, vi, sf, lm) {
		const c = this.c;
		const v = this.#vec(vi);
		const vx = v[0], vy = v[1], vz = v[2];
		let sum = ((c[base] << 16) >> 16) * vx + (c[base] >> 16) * vy + ((c[base + 1] << 16) >> 16) * vz;
		this.#ir(1, this.#mac(1, sum, sf), lm);
		sum = (c[base + 1] >> 16) * vx + ((c[base + 2] << 16) >> 16) * vy + (c[base + 2] >> 16) * vz;
		this.#ir(2, this.#mac(2, sum, sf), lm);
		sum = ((c[base + 3] << 16) >> 16) * vx + (c[base + 3] >> 16) * vy + ((c[base + 4] << 16) >> 16) * vz;
		this.#ir(3, this.#mac(3, sum, sf), lm);
	}

	/**
	 * Matrix * vector + translation, storing MAC1-3/IR1-3.
	 * Reads color matrix from c[16..20], translation from c[13..15].
	 */
	#mxvColor(vx, vy, vz, sf, lm) {
		const c = this.c;
		const t0 = c[13] | 0, t1 = c[14] | 0, t2 = c[15] | 0;
		let sum = t0 * 4096 + ((c[16] << 16) >> 16) * vx + (c[16] >> 16) * vy + ((c[17] << 16) >> 16) * vz;
		this.#ir(1, this.#mac(1, sum, sf), lm);
		sum = t1 * 4096 + (c[17] >> 16) * vx + ((c[18] << 16) >> 16) * vy + (c[18] >> 16) * vz;
		this.#ir(2, this.#mac(2, sum, sf), lm);
		sum = t2 * 4096 + ((c[19] << 16) >> 16) * vx + (c[19] >> 16) * vy + ((c[20] << 16) >> 16) * vz;
		this.#ir(3, this.#mac(3, sum, sf), lm);
	}

	// ---- commands ------------------------------------------------------

	/**
	 * @param {number} vi - vector index
	 * @param {number} sf
	 * @param {boolean} lm
	 * @param {boolean} last - compute depth cue on the last vertex
	 */
	#rtps(vi, sf, lm, last) {
		const c = this.c;
		const d = this.d;
		const v = this.#vec(vi);
		const vx = v[0], vy = v[1], vz = v[2];
		const tr0 = c[5] | 0, tr1 = c[6] | 0, tr2 = c[7] | 0;

		let sum = tr0 * 4096 + ((c[0] << 16) >> 16) * vx + (c[0] >> 16) * vy + ((c[1] << 16) >> 16) * vz;
		let shifted = this.#mac(1, sum, sf);
		this.#ir(1, shifted, false);

		sum = tr1 * 4096 + (c[1] >> 16) * vx + ((c[2] << 16) >> 16) * vy + (c[2] >> 16) * vz;
		shifted = this.#mac(2, sum, sf);
		this.#ir(2, shifted, false);

		sum = tr2 * 4096 + ((c[3] << 16) >> 16) * vx + (c[3] >> 16) * vy + ((c[4] << 16) >> 16) * vz;
		shifted = this.#mac(3, sum, sf);
		this.#ir(3, shifted, false);
		let mac3 = shifted;

		// SZ3 = MAC3 in 20.12 when sf=0
		let sz3 = sf !== 0 ? mac3 : Math.floor(mac3 / 4096);
		if (sz3 < 0) { sz3 = 0; this.flag |= 1 << 18; }
		else if (sz3 > 0xffff) { sz3 = 0xffff; this.flag |= 1 << 18; }
		d[16] = d[17]; d[17] = d[18]; d[18] = d[19];
		d[19] = sz3;

		const h = this.c[26] & 0xffff;
		const div = this.#divide(h, sz3);

		const ofx = c[24] | 0, ofy = c[25] | 0;
		const mx = this.#mac0(div * d[9] + ofx);
		const my = this.#mac0(div * d[10] + ofy);
		let sx = Math.floor(mx / 65536);
		let sy = Math.floor(my / 65536);
		if (sx < -0x400) { sx = -0x400; this.flag |= 1 << 14; }
		else if (sx > 0x3ff) { sx = 0x3ff; this.flag |= 1 << 14; }
		if (sy < -0x400) { sy = -0x400; this.flag |= 1 << 13; }
		else if (sy > 0x3ff) { sy = 0x3ff; this.flag |= 1 << 13; }
		d[12] = d[13];
		d[13] = d[14];
		d[14] = (sx & 0xffff) | (sy << 16);

		if (last) {
			const dqa = (c[27] << 16) >> 16, dqb = c[28] | 0;
			const m0 = this.#mac0(div * dqa + dqb);
			this.#ir0(Math.floor(m0 / 4096));
		}
	}

	#nclip() {
		const d = this.d;
		const x0 = (d[12] << 16) >> 16, y0 = d[12] >> 16;
		const x1 = (d[13] << 16) >> 16, y1 = d[13] >> 16;
		const x2 = (d[14] << 16) >> 16, y2 = d[14] >> 16;
		this.#mac0(x0 * y1 + x1 * y2 + x2 * y0 - x0 * y2 - x1 * y0 - x2 * y1);
	}

	#avsz3() {
		const d = this.d;
		const zsf3 = (this.c[29] << 16) >> 16;
		const sum = this.#mac0(zsf3 * ((d[17] & 0xffff) + (d[18] & 0xffff) + (d[19] & 0xffff)));
		let otz = Math.floor(sum / 4096);
		if (otz < 0) { otz = 0; this.flag |= 1 << 18; }
		else if (otz > 0xffff) { otz = 0xffff; this.flag |= 1 << 18; }
		d[7] = otz;
	}

	#avsz4() {
		const d = this.d;
		const zsf4 = (this.c[30] << 16) >> 16;
		const sum = this.#mac0(zsf4 * ((d[16] & 0xffff) + (d[17] & 0xffff) + (d[18] & 0xffff) + (d[19] & 0xffff)));
		let otz = Math.floor(sum / 4096);
		if (otz < 0) { otz = 0; this.flag |= 1 << 18; }
		else if (otz > 0xffff) { otz = 0xffff; this.flag |= 1 << 18; }
		d[7] = otz;
	}

	/**
	 * @param {number} word - command with matrix/vector/translation selectors
	 */
	#mvmva(word, sf, lm) {
		const mx = (word >> 17) & 3;
		const vx = (word >> 15) & 3;
		const cv = (word >> 13) & 3;
		const m = mx === 3 ? ZERO_M : this.#matrix(mx * 8);
		let v;
		if (vx === 3) {
			const vv = this._v;
			const dd = this.d;
			vv[0] = dd[9];
			vv[1] = dd[10];
			vv[2] = dd[11];
			v = vv;
		} else {
			v = this.#vec(vx);
		}
		const t = this._t3;
		if (cv === 0) {
			t[0] = this.c[5] | 0;
			t[1] = this.c[6] | 0;
			t[2] = this.c[7] | 0;
		} else if (cv === 1) {
			t[0] = this.c[13] | 0;
			t[1] = this.c[14] | 0;
			t[2] = this.c[15] | 0;
		} else if (cv === 2) {
			t[0] = this.c[21] | 0;
			t[1] = this.c[22] | 0;
			t[2] = this.c[23] | 0;
		} else {
			t[0] = 0;
			t[1] = 0;
			t[2] = 0;
		}
		this.#mxv(m, v, t, sf, lm);
	}

	/**
	 * Matrix * vector + translation, storing MAC1-3/IR1-3.
	 * @param {number[]} m - 9 cells
	 * @param {number[]} v - [x,y,z]
	 * @param {number[]} t - translation (raw, shifted <<12 here)
	 * @param {number} sf
	 * @param {boolean} lm
	 */
	#mxv(m, v, t, sf, lm) {
		for (let i = 0; i < 3; i++) {
			const sum = t[i] * 4096 + m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2];
			this.#ir(i + 1, this.#mac(i + 1, sum, sf), lm);
		}
	}

	#sqr(sf, lm) {
		const d = this.d;
		for (let i = 1; i <= 3; i++) {
			const ir = d[8 + i];
			this.#ir(i, this.#mac(i, ir * ir, sf), lm);
		}
	}

	#op(sf, lm) {
		const c = this.c;
		const d = this.d;
		const d1 = (c[0] << 16) >> 16;         // RT11
		const d2 = (c[2] << 16) >> 16;         // RT22
		const d3 = (c[4] << 16) >> 16;         // RT33
		const ir1 = d[9], ir2 = d[10], ir3 = d[11];
		const m1 = this.#mac(1, ir3 * d2 - ir2 * d3, sf);
		const m2 = this.#mac(2, ir1 * d3 - ir3 * d1, sf);
		const m3 = this.#mac(3, ir2 * d1 - ir1 * d2, sf);
		this.#ir(1, m1, lm);
		this.#ir(2, m2, lm);
		this.#ir(3, m3, lm);
	}

	/**
	 * Interpolates MAC1-3 toward the far color by IR0.
	 * Reads/writes this._mac3.
	 */
	#farColorLerp(sf, lm) {
		const mac = this._mac3;
		const fc0 = this.c[21] | 0;
		const fc1 = this.c[22] | 0;
		const fc2 = this.c[23] | 0;
		const ir0 = this.d[8];
		const t = this._t;
		for (let i = 0; i < 3; i++) {
			const fc = i === 0 ? fc0 : i === 1 ? fc1 : fc2;
			const diff = this.#mac(i + 1, fc * 4096 - mac[i], sf);
			t[i] = this.#ir(i + 1, diff, false);
		}
		for (let i = 0; i < 3; i++) {
			this.#ir(i + 1, this.#mac(i + 1, t[i] * ir0 + mac[i], sf), lm);
		}
	}

	/**
	 * @param {number} rgbc - source color word
	 */
	#dpcs(rgbc, sf, lm) {
		const mac = this._mac3;
		mac[0] = (rgbc & 0xff) * 65536;
		mac[1] = ((rgbc >> 8) & 0xff) * 65536;
		mac[2] = ((rgbc >> 16) & 0xff) * 65536;
		this.#farColorLerp(sf, lm);
		this.#pushColor();
	}

	#intpl(sf, lm) {
		const d = this.d;
		const mac = this._mac3;
		mac[0] = d[9] * 4096;
		mac[1] = d[10] * 4096;
		mac[2] = d[11] * 4096;
		this.#farColorLerp(sf, lm);
		this.#pushColor();
	}

	#dcpl(sf, lm) {
		const d = this.d;
		const rgbc = d[6];
		const mac = this._mac3;
		mac[0] = ((rgbc & 0xff) * d[9]) * 16;
		mac[1] = (((rgbc >> 8) & 0xff) * d[10]) * 16;
		mac[2] = (((rgbc >> 16) & 0xff) * d[11]) * 16;
		this.#farColorLerp(sf, lm);
		this.#pushColor();
	}

	/** light step 1: IR = (light matrix * V) */
	#lightVec(vi, sf, lm) {
		this.#mxvNoTrans(8, vi, sf, lm);
	}

	/** light step 2: IR = (BK<<12 + color matrix * IR) */
	#lightColor(sf, lm) {
		const d = this.d;
		this.#mxvColor(d[9], d[10], d[11], sf, lm);
	}

	#ncs(vi, sf, lm) {
		this.#lightVec(vi, sf, lm);
		this.#lightColor(sf, lm);
		this.#pushColor();
	}

	#nccs(vi, sf, lm) {
		this.#lightVec(vi, sf, lm);
		this.#lightColor(sf, lm);
		this.#colorMultiply(sf, lm);
		this.#pushColor();
	}

	#ncds(vi, sf, lm) {
		this.#lightVec(vi, sf, lm);
		this.#lightColor(sf, lm);
		this.#colorDepthCue(sf, lm);
		this.#pushColor();
	}

	#cc(sf, lm) {
		this.#lightColor(sf, lm);
		this.#colorMultiply(sf, lm);
		this.#pushColor();
	}

	#cdp(sf, lm) {
		this.#lightColor(sf, lm);
		this.#colorDepthCue(sf, lm);
		this.#pushColor();
	}

	/** MAC = (RGBC * IR) << 4, then shift */
	#colorMultiply(sf, lm) {
		const d = this.d;
		const rgbc = d[6];
		for (let i = 0; i < 3; i++) {
			const col = (rgbc >> (i * 8)) & 0xff;
			this.#ir(i + 1, this.#mac(i + 1, col * d[9 + i] * 16, sf), lm);
		}
	}

	/** MAC = (RGBC * IR) << 4, then far-color interpolation */
	#colorDepthCue(sf, lm) {
		const d = this.d;
		const rgbc = d[6];
		const mac = this._mac3;
		mac[0] = (rgbc & 0xff) * d[9] * 16;
		mac[1] = ((rgbc >> 8) & 0xff) * d[10] * 16;
		mac[2] = ((rgbc >> 16) & 0xff) * d[11] * 16;
		this.#farColorLerp(sf, lm);
	}

	#gpf(sf, lm) {
		const d = this.d;
		const ir0 = d[8];
		for (let i = 1; i <= 3; i++) {
			this.#ir(i, this.#mac(i, d[8 + i] * ir0, sf), lm);
		}
		this.#pushColor();
	}

	#gpl(sf, lm) {
		const d = this.d;
		const ir0 = d[8];
		const scale = sf !== 0 ? 4096 : 1;
		for (let i = 1; i <= 3; i++) {
			const acc = (d[24 + i] | 0) * scale;
			this.#ir(i, this.#mac(i, acc + d[8 + i] * ir0, sf), lm);
		}
		this.#pushColor();
	}

	/**
	 * Hardware Newton-Raphson division: (h * 0x20000 / sz3) / 2, 1.16.
	 * @param {number} h
	 * @param {number} sz3
	 * @return {number}
	 */
	#divide(h, sz3) {
		if (h >= sz3 * 2) {
			this.flag |= 1 << 17;
			return 0x1ffff;
		}
		const z = Math.clz32(sz3) - 16;
		const n = h << z;
		let dd = sz3 << z;
		const u = UNR[(dd - 0x7fc0) >> 7] + 0x101;
		dd = (0x2000080 - dd * u) >> 8;
		dd = (0x80 + dd * u) >> 8;
		return Math.min(0x1ffff, Math.floor((n * dd + 0x8000) / 65536));
	}
}

/**
 * @param {number} v
 * @return {number} - saturated to 0..31
 */
function sat5(v) {
	return v < 0 ? 0 : (v > 0x1f ? 0x1f : v);
}
