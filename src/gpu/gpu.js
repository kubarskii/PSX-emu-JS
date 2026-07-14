/**
 * PSX GPU: 1MB VRAM (1024x512 16bpp), GP0 rendering command processor,
 * GP1 control, software rasterizer.
 *
 * Rasterization notes: PSX textures are affine (no perspective correction)
 * and colors are 5:5:5 - both are emulated faithfully. Dithering is not
 * implemented (output is slightly cleaner than real hardware).
 */

const VRAM_W = 1024;
const VRAM_H = 512;

/** variable-size rect side lengths by GP0 size field */
const RECT_SIZES = [0, 1, 8, 16];

/** 15bpp → RGBA8888 lookup for renderDisplay (built once at load) */
const RGB555_TO_RGBA = new Uint32Array(65536);
for (let i = 0; i < 65536; i++) {
	const r = (i & 0x1f) << 3;
	const g = ((i >> 5) & 0x1f) << 3;
	const b = ((i >> 10) & 0x1f) << 3;
	RGB555_TO_RGBA[i] = 0xff000000 | (b << 16) | (g << 8) | r;
}

/** GP0 receive states */
const IDLE = 0;
const PARAMS = 1;   // collecting a fixed number of words
const POLYLINE = 2; // collecting until terminator
const IMAGE_IN = 3; // receiving CPU->VRAM pixel data

export class GPU {

	/**
	 * @param {(bit: number) => void} raiseIrq
	 */
	constructor(raiseIrq) {
		this.raiseIrq = raiseIrq || (() => {});
		this.vram = new Uint16Array(VRAM_W * VRAM_H);
		/** polygon unpack scratch (max 4 verts) */
		this._vx = [0, 0, 0, 0];
		this._vy = [0, 0, 0, 0];
		this._vc = [0, 0, 0, 0];
		this._vu = [0, 0, 0, 0];
		this._vv = [0, 0, 0, 0];
		/** reused draw-option bags (mutated per primitive, never reallocated) */
		this._polyOpts = {
			gouraud: false, semi: false, raw: false, tex: false,
			clutX: 0, clutY: 0, pageX: 0, pageY: 0, semiMode: 0, texDepth: 0,
			uMask: 0, uOr: 0, vMask: 0, vOr: 0, baseX: 0, clutRow: 0,
		};
		this._rectOpts = {
			raw: false, tex: false, semi: false,
			clutX: 0, clutY: 0, pageX: 0, pageY: 0, semiMode: 0, texDepth: 0,
			uMask: 0, uOr: 0, vMask: 0, vOr: 0, baseX: 0, clutRow: 0,
		};
		this.clutCache = new Uint16Array(256);
		/**
		 * Optional hardware renderer (WebGL2). When attached, primitives
		 * render on the host GPU at a higher internal resolution; the
		 * software VRAM stays authoritative for uploads/fills/copies so
		 * paletted texture data and 24bpp scanout keep working.
		 * @type {import("./hw-backend").HwGpu | null}
		 */
		this.hw = null;
		this.reset();
	}

	reset() {
		// GP0(0xe1) draw mode
		this.texBaseX = 0;      // in 64-halfword units
		this.texBaseY = 0;      // 0 or 256
		this.semiMode = 0;      // 0..3
		this.texDepth = 0;      // 0=4bit 1=8bit 2=15bit
		this.dither = false;
		this.drawToDisplay = false;
		this.texDisable = false;
		this.rectFlipX = false;
		this.rectFlipY = false;
		// GP0(0xe2) texture window
		this.texWinMaskX = 0;
		this.texWinMaskY = 0;
		this.texWinOffX = 0;
		this.texWinOffY = 0;
		// GP0(0xe3/0xe4) drawing area
		this.drawX0 = 0;
		this.drawY0 = 0;
		this.drawX1 = 0;
		this.drawY1 = 0;
		// GP0(0xe5) drawing offset
		this.offX = 0;
		this.offY = 0;
		// GP0(0xe6) mask bits
		this.maskSet = false;
		this.maskCheck = false;
		// GP1 display state
		this.displayDisabled = true;
		this.irqPending = false;
		this.dmaDirection = 0;
		this.displayVramX = 0;
		this.displayVramY = 0;
		this.displayHStart = 0x200;
		this.displayHEnd = 0xc00;
		this.displayVStart = 0x10;
		this.displayVEnd = 0x100;
		this.hres = 320;
		this.vres = 240;
		this.pal = false;
		this.depth24 = false;
		this.interlaced = false;
		this.oddFrame = 0;
		/** current scanline / vblank state, driven by the machine */
		this.line = 0;
		this.inVblank = false;

		// CLUT cache tag: real hardware refetches the CLUT from VRAM only
		// when a primitive names a different CLUT address/depth than the
		// cached one; VRAM writes do NOT invalidate it (NFS Porsche draws a
		// "disabled" overlay rect relying on the stale all-zero CLUT after
		// its own framebuffer upload has overwritten the CLUT area)
		this.clutCacheKey = -1;

		// GP0 state machine
		this.state = IDLE;
		this.buf = new Int32Array(16);
		this.bufLen = 0;
		this.need = 0;
		this.cmd = 0;
		// image transfer state
		this.trX = 0;
		this.trY = 0;
		this.trW = 0;
		this.trH = 0;
		this.trCur = 0;
		this.trWordsLeft = 0;
		// VRAM->CPU read state
		this.readBuf = null;
		this.readPos = 0;
		this.readLatch = 0;
	}

	/** @return {number} - dotclock divider for the current hres (timer0) */
	get dotDivider() {
		switch (this.hres) {
		case 256: return 10;
		case 320: return 8;
		case 368: return 7;
		case 512: return 5;
		case 640: return 4;
		default: return 8;
		}
	}

	/** called by the machine when vblank ends (a new field is scanned out) */
	onVblankEnd() {
		this.oddFrame ^= 1;
	}

	/** @return {number} - GPUSTAT */
	readStatus() {
		let s = 0;
		s |= this.texBaseX;
		s |= (this.texBaseY >> 8) << 4;
		s |= this.semiMode << 5;
		s |= this.texDepth << 7;
		if (this.dither) s |= 1 << 9;
		if (this.drawToDisplay) s |= 1 << 10;
		if (this.maskSet) s |= 1 << 11;
		if (this.maskCheck) s |= 1 << 12;
		// interlace field (always 1 when interlace is off)
		if (!this.interlaced || (this.oddFrame & 1) === 1) s |= 1 << 13;
		if (this.texDisable) s |= 1 << 15;
		switch (this.hres) {
		case 256: break;
		case 320: s |= 1 << 17; break;
		case 512: s |= 2 << 17; break;
		case 640: s |= 3 << 17; break;
		case 368: s |= 1 << 16; break;
		}
		if (this.vres === 480) s |= 1 << 19;
		if (this.pal) s |= 1 << 20;
		if (this.depth24) s |= 1 << 21;
		if (this.interlaced) s |= 1 << 22;
		if (this.displayDisabled) s |= 1 << 23;
		if (this.irqPending) s |= 1 << 24;
		// ready flags: command ready only when idle — during an image
		// transfer it stays 0 until the full W*H halfwords arrived (NFS
		// Porsche streams uploads in bursts and polls bit26 as "image
		// complete"; reporting ready too early makes it stop feeding and
		// the GPU then eats its draw commands as pixel data). vram-read
		// ready when a read is pending, dma ready always.
		if (this.state === IDLE) s |= 1 << 26;
		if (this.readBuf !== null) s |= 1 << 27;
		s |= 1 << 28;
		s |= this.dmaDirection << 29;
		// dma request bit mirrors the selected direction's ready flag
		// (direction 1 is "FIFO not full", which this model always is)
		const req = this.dmaDirection === 1 || this.dmaDirection === 2
			? 1
			: (this.dmaDirection === 3 ? (this.readBuf !== null ? 1 : 0) : 0);
		if (this.dmaDirection !== 0 && req) s |= 1 << 25;
		// bit31: even/odd - the current field in interlace mode (flips at
		// every vblank), the currently drawn scanline otherwise; always
		// "even" during vblank in both modes
		if (this.vres === 480) {
			if (!this.inVblank && (this.oddFrame & 1) === 1) s |= 1 << 31;
		} else if (!this.inVblank && (this.line & 1) === 1) {
			s |= 1 << 31;
		}
		return s | 0;
	}

	/** @return {number} - GPUREAD */
	readData() {
		if (this.readBuf !== null) {
			const v = this.readBuf[this.readPos++] | 0;
			if (this.readPos >= this.readBuf.length) this.readBuf = null;
			return v;
		}
		return this.readLatch | 0;
	}

	/**
	 * GP1 display control.
	 * @param {number} word
	 */
	gp1(word) {
		const cmd = word >>> 24;
		const p = word & 0xffffff;
		switch (cmd) {
		case 0x00:
			this.reset();
			return;
		case 0x01: // reset command buffer
			this.state = IDLE;
			this.bufLen = 0;
			return;
		case 0x02:
			this.irqPending = false;
			return;
		case 0x03:
			this.displayDisabled = (p & 1) !== 0;
			return;
		case 0x04:
			this.dmaDirection = p & 3;
			return;
		case 0x05:
			this.displayVramX = p & 0x3fe;
			this.displayVramY = (p >>> 10) & 0x1ff;
			return;
		case 0x06:
			this.displayHStart = p & 0xfff;
			this.displayHEnd = (p >>> 12) & 0xfff;
			return;
		case 0x07:
			this.displayVStart = p & 0x3ff;
			this.displayVEnd = (p >>> 10) & 0x3ff;
			return;
		case 0x08: {
			const hr1 = p & 3;
			this.hres = (p & 0x40) !== 0 ? 368 : [256, 320, 512, 640][hr1];
			this.interlaced = (p & 0x20) !== 0;
			this.vres = ((p & 4) !== 0 && this.interlaced) ? 480 : 240;
			this.pal = (p & 8) !== 0;
			this.depth24 = (p & 0x10) !== 0;
			return;
		}
		case 0x10: case 0x11: case 0x12: case 0x13:
		case 0x14: case 0x15: case 0x16: case 0x17:
		case 0x18: case 0x19: case 0x1a: case 0x1b:
		case 0x1c: case 0x1d: case 0x1e: case 0x1f: { // get GPU info (mirrors)
			switch (p & 0xf) {
			case 2:
				this.readLatch = this.texWinMaskX | (this.texWinMaskY << 5) |
					(this.texWinOffX << 10) | (this.texWinOffY << 15);
				break;
			case 3: this.readLatch = (this.drawY0 << 10) | this.drawX0; break;
			case 4: this.readLatch = (this.drawY1 << 10) | this.drawX1; break;
			case 5: this.readLatch = ((this.offY & 0x7ff) << 11) | (this.offX & 0x7ff); break;
			case 7: this.readLatch = 2; break; // GPU version
			default: break;
			}
			return;
		}
		default:
			return;
		}
	}

	/**
	 * GP0 rendering/data port.
	 * @param {number} word
	 */
	gp0(word) {
		if (this.state === IMAGE_IN) {
			this.#imageWord(word);
			return;
		}
		if (this.state === POLYLINE) {
			if ((word & 0xf000f000) === 0x50005000) {
				this.state = IDLE;
				return;
			}
			this.#polylineWord(word);
			return;
		}
		if (this.state === PARAMS) {
			this.buf[this.bufLen++] = word | 0;
			if (this.bufLen === this.need) {
				this.state = IDLE;
				this.#execute();
			}
			return;
		}

		let cmd = word >>> 24;
		// 0x80-0x9f / 0xa0-0xbf / 0xc0-0xdf all decode as the three copy
		// commands: the GPU only looks at the top 3 bits of these ranges
		if (cmd >= 0x80 && cmd < 0xe0) cmd &= 0xe0;
		this.cmd = cmd;
		this.buf[0] = word | 0;
		this.bufLen = 1;

		if (cmd >= 0x20 && cmd < 0x40) { // polygons
			const quad = (cmd & 8) !== 0;
			const tex = (cmd & 4) !== 0;
			const gouraud = (cmd & 0x10) !== 0;
			const verts = quad ? 4 : 3;
			this.need = 1 + verts + (tex ? verts : 0) + (gouraud ? verts - 1 : 0);
			this.state = PARAMS;
			return;
		}
		if (cmd >= 0x40 && cmd < 0x60) { // lines
			const gouraud = (cmd & 0x10) !== 0;
			if ((cmd & 8) !== 0) { // polyline
				this.state = POLYLINE;
				this.plGouraud = gouraud;
				this.plSemi = (cmd & 2) !== 0;
				this.plColor = word & 0xffffff;
				this.plCount = 0;
				this.plX = 0;
				this.plY = 0;
				this.plC = word & 0xffffff;
				this.plPendingColor = -1;
				return;
			}
			this.need = gouraud ? 4 : 3;
			this.state = PARAMS;
			return;
		}
		if (cmd >= 0x60 && cmd < 0x80) { // rectangles
			const size = (cmd >> 3) & 3;
			const tex = (cmd & 4) !== 0;
			this.need = 2 + (tex ? 1 : 0) + (size === 0 ? 1 : 0);
			this.state = PARAMS;
			return;
		}

		switch (cmd) {
		case 0x00: return; // nop
		case 0x01: // clear texture cache: the CLUT cache refetches too
			this.clutCacheKey = -1;
			return;
		case 0x02: this.need = 3; this.state = PARAMS; return; // fill rect
		case 0x1f:
			this.irqPending = true;
			this.raiseIrq(1);
			return;
		case 0x80: this.need = 4; this.state = PARAMS; return; // vram->vram
		case 0xa0: this.need = 3; this.state = PARAMS; return; // cpu->vram
		case 0xc0: this.need = 3; this.state = PARAMS; return; // vram->cpu
		case 0xe1: {
			this.texBaseX = word & 0xf;
			this.texBaseY = ((word >> 4) & 1) << 8;
			this.semiMode = (word >> 5) & 3;
			this.texDepth = (word >> 7) & 3;
			this.dither = (word & 0x200) !== 0;
			this.drawToDisplay = (word & 0x400) !== 0;
			this.texDisable = (word & 0x800) !== 0;
			this.rectFlipX = (word & 0x1000) !== 0;
			this.rectFlipY = (word & 0x2000) !== 0;
			return;
		}
		case 0xe2:
			this.texWinMaskX = word & 0x1f;
			this.texWinMaskY = (word >> 5) & 0x1f;
			this.texWinOffX = (word >> 10) & 0x1f;
			this.texWinOffY = (word >> 15) & 0x1f;
			return;
		case 0xe3:
			this.drawX0 = word & 0x3ff;
			this.drawY0 = (word >> 10) & 0x3ff;
			return;
		case 0xe4:
			this.drawX1 = word & 0x3ff;
			this.drawY1 = (word >> 10) & 0x3ff;
			return;
		case 0xe5:
			this.offX = (word << 21) >> 21;
			this.offY = (word << 10) >> 21;
			return;
		case 0xe6:
			this.maskSet = (word & 1) !== 0;
			this.maskCheck = (word & 2) !== 0;
			return;
		default:
			return; // unknown command: ignore
		}
	}

	/** executes a fully buffered GP0 command */
	#execute() {
		const cmd = this.cmd;
		const b = this.buf;

		if (cmd >= 0x20 && cmd < 0x40) {
			this.#drawPolygon();
			return;
		}
		if (cmd >= 0x40 && cmd < 0x60) {
			const gouraud = (cmd & 0x10) !== 0;
			const semi = (cmd & 2) !== 0;
			const c0 = b[0] & 0xffffff;
			if (gouraud) {
				this.#drawLine(b[1], c0, b[3], b[2] & 0xffffff, semi, true);
			} else {
				this.#drawLine(b[1], c0, b[2], c0, semi, false);
			}
			return;
		}
		if (cmd >= 0x60 && cmd < 0x80) {
			this.#drawRect();
			return;
		}

		switch (cmd) {
		case 0x02: { // fill rectangle (raw framebuffer coords, no clip/offset)
			const color = rgb24to15(b[0]);
			const x0 = b[1] & 0x3f0;
			const y0 = (b[1] >> 16) & 0x1ff;
			const w = ((b[2] & 0x3ff) + 0xf) & ~0xf;
			const h = (b[2] >> 16) & 0x1ff;
			const vram = this.vram;
			for (let y = 0; y < h; y++) {
				const row = ((y0 + y) & 0x1ff) * VRAM_W;
				for (let x = 0; x < w; x++) {
					vram[row + ((x0 + x) & 0x3ff)] = color;
				}
			}
			if (this.hw !== null) this.hw.fill(x0, y0, w, h, b[0] & 0xffffff);
			return;
		}
		case 0x80: { // vram -> vram copy
			const sx = b[1] & 0x3ff, sy = (b[1] >> 16) & 0x1ff;
			const dx = b[2] & 0x3ff, dy = (b[2] >> 16) & 0x1ff;
			let w = b[3] & 0x3ff, h = (b[3] >> 16) & 0x1ff;
			if (w === 0) w = 0x400;
			if (h === 0) h = 0x200;
			const vram = this.vram;
			for (let y = 0; y < h; y++) {
				const srow = ((sy + y) & 0x1ff) * VRAM_W;
				const drow = ((dy + y) & 0x1ff) * VRAM_W;
				for (let x = 0; x < w; x++) {
					const px = vram[srow + ((sx + x) & 0x3ff)];
					const di = drow + ((dx + x) & 0x3ff);
					if (this.maskCheck && (vram[di] & 0x8000) !== 0) continue;
					vram[di] = this.maskSet ? (px | 0x8000) : px;
				}
			}
			if (this.hw !== null) {
				this.hw.setEnv(this);
				this.hw.copy(sx, sy, dx, dy, w, h);
			}
			return;
		}
		case 0xa0: { // cpu -> vram
			this.trX = b[1] & 0x3ff;
			this.trY = (b[1] >> 16) & 0x1ff;
			this.trW = b[2] & 0x3ff;
			this.trH = (b[2] >> 16) & 0x1ff;
			if (this.trW === 0) this.trW = 0x400;
			if (this.trH === 0) this.trH = 0x200;
			this.trCur = 0;
			this.trWordsLeft = Math.ceil(this.trW * this.trH / 2);
			if (this.trWordsLeft > 0) this.state = IMAGE_IN;
			return;
		}
		case 0xc0: { // vram -> cpu
			const x0 = b[1] & 0x3ff;
			const y0 = (b[1] >> 16) & 0x1ff;
			let w = b[2] & 0x3ff, h = (b[2] >> 16) & 0x1ff;
			if (w === 0) w = 0x400;
			if (h === 0) h = 0x200;
			if (this.hw !== null) {
				// rendered pixels only exist on the GPU: read them back
				this.readBuf = this.hw.imageOut(x0, y0, w, h);
				this.readPos = 0;
				return;
			}
			const words = Math.ceil(w * h / 2);
			const out = new Int32Array(words);
			const vram = this.vram;
			for (let i = 0; i < w * h; i++) {
				const x = (x0 + (i % w)) & 0x3ff;
				const y = (y0 + ((i / w) | 0)) & 0x1ff;
				const px = vram[y * VRAM_W + x];
				if ((i & 1) === 0) out[i >> 1] = px;
				else out[i >> 1] |= px << 16;
			}
			this.readBuf = out;
			this.readPos = 0;
			return;
		}
		default:
			return;
		}
	}

	/** consumes one word of a CPU->VRAM image transfer */
	#imageWord(word) {
		const vram = this.vram;
		for (let half = 0; half < 2; half++) {
			const px = half === 0 ? (word & 0xffff) : (word >>> 16);
			if (this.trCur < this.trW * this.trH) {
				const x = (this.trX + (this.trCur % this.trW)) & 0x3ff;
				const y = (this.trY + ((this.trCur / this.trW) | 0)) & 0x1ff;
				const di = y * VRAM_W + x;
				if (!(this.maskCheck && (vram[di] & 0x8000) !== 0)) {
					vram[di] = this.maskSet ? (px | 0x8000) : px;
				}
				this.trCur++;
			}
		}
		if (--this.trWordsLeft <= 0) {
			this.state = IDLE;
			// the whole rect is now in the shadow VRAM: mirror it into the
			// hardware texture in one upload
			if (this.hw !== null) {
				this.hw.setEnv(this);
				this.hw.imageIn(this.trX, this.trY, this.trW, this.trH, vram);
			}
		}
	}

	/** consumes one word of a polyline */
	#polylineWord(word) {
		if (this.plGouraud && this.plPendingColor === -1 && this.plCount > 0) {
			this.plPendingColor = word & 0xffffff;
			return;
		}
		const x = word | 0;
		if (this.plCount > 0) {
			const c1 = this.plGouraud ? this.plPendingColor : this.plColor;
			this.#drawLineXY(this.plX, this.plY, this.plC,
				sx11(x), sy11(x), c1, this.plSemi, this.plGouraud);
			this.plC = c1;
		}
		this.plX = sx11(x);
		this.plY = sy11(x);
		this.plCount++;
		this.plPendingColor = -1;
	}

	#drawPolygon() {
		const cmd = this.cmd;
		const b = this.buf;
		const quad = (cmd & 8) !== 0;
		const tex = (cmd & 4) !== 0;
		const gouraud = (cmd & 0x10) !== 0;
		const semi = (cmd & 2) !== 0;
		const raw = tex && (cmd & 1) !== 0;
		const verts = quad ? 4 : 3;

		// unpack vertices into reusable buffers
		const vx = this._vx;
		const vy = this._vy;
		const vc = this._vc;
		const vu = this._vu;
		const vv = this._vv;
		let i = 1;
		let clut = 0, page = -1;
		for (let v = 0; v < verts; v++) {
			const color = (v === 0 || !gouraud) ? (b[0] & 0xffffff) : (b[i] & 0xffffff);
			if (v > 0 && gouraud) i++;
			const xy = b[i++];
			vx[v] = sx11(xy) + this.offX;
			vy[v] = sy11(xy) + this.offY;
			vc[v] = color;
			if (tex) {
				const t = b[i++];
				vu[v] = t & 0xff;
				vv[v] = (t >> 8) & 0xff;
				if (v === 0) clut = (t >>> 16) & 0xffff;
				if (v === 1) page = (t >>> 16) & 0xffff;
			} else {
				vu[v] = 0;
				vv[v] = 0;
			}
		}
		if (page >= 0) {
			// the texpage attribute updates the global draw mode exactly
			// like GP0(E1): rectangles drawn later sample this page, and
			// GPUSTAT bits 0-8 read it back
			this.texBaseX = page & 0xf;
			this.texBaseY = ((page >> 4) & 1) << 8;
			this.semiMode = (page >> 5) & 3;
			this.texDepth = (page >> 7) & 3;
		}
		const o = this._polyOpts;
		o.gouraud = gouraud;
		o.semi = semi;
		o.raw = raw;
		o.tex = tex;
		o.clutX = (clut & 0x3f) * 16;
		o.clutY = (clut >> 6) & 0x1ff;
		o.pageX = this.texBaseX;
		o.pageY = this.texBaseY;
		o.semiMode = this.semiMode;
		o.texDepth = this.texDepth;
		if (tex) {
			o.uMask = ~(this.texWinMaskX << 3);
			o.uOr = (this.texWinOffX & this.texWinMaskX) << 3;
			o.vMask = ~(this.texWinMaskY << 3);
			o.vOr = (this.texWinOffY & this.texWinMaskY) << 3;
			o.baseX = o.pageX * 64;
			o.clutRow = (o.clutY & 0x1ff) * VRAM_W;
		}
		if (this.hw !== null) {
			this.hw.setEnv(this);
			this.hw.triangle(o, vx, vy, vc, vu, vv, 0, 1, 2);
			if (quad) this.hw.triangle(o, vx, vy, vc, vu, vv, 1, 2, 3);
			return;
		}
		this.#triangle(vx[0], vy[0], vc[0], vu[0], vv[0],
			vx[1], vy[1], vc[1], vu[1], vv[1],
			vx[2], vy[2], vc[2], vu[2], vv[2], o);
		if (quad) {
			this.#triangle(vx[1], vy[1], vc[1], vu[1], vv[1],
				vx[2], vy[2], vc[2], vu[2], vv[2],
				vx[3], vy[3], vc[3], vu[3], vv[3], o);
		}
	}

	/**
	 * Fills one triangle with edge functions and incremental stepping.
	 * Colors/UVs interpolate affinely like real hardware.
	 */
	#triangle(x0, y0, c0, u0, v0, x1, y1, c1, u1, v1, x2, y2, c2, u2, v2, o) {
		// consistent winding
		let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
		if (area === 0) return;
		if (area < 0) {
			let t;
			t = x1; x1 = x2; x2 = t;
			t = y1; y1 = y2; y2 = t;
			t = c1; c1 = c2; c2 = t;
			t = u1; u1 = u2; u2 = t;
			t = v1; v1 = v2; v2 = t;
			area = -area;
		}

		// hardware rejects oversized polygons
		const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2);
		const minY = Math.min(y0, y1, y2), maxY = Math.max(y0, y1, y2);
		if (maxX - minX >= 1024 || maxY - minY >= 512) return;

		const bx0 = Math.max(minX, this.drawX0);
		const by0 = Math.max(minY, this.drawY0);
		const bx1 = Math.min(maxX - 1, this.drawX1);
		const by1 = Math.min(maxY - 1, this.drawY1);
		if (bx0 > bx1 || by0 > by1) return;

		// edge coefficients: w = A*x + B*y + C, positive inside
		const A01 = y0 - y1, B01 = x1 - x0;
		const A12 = y1 - y2, B12 = x2 - x1;
		const A20 = y2 - y0, B20 = x0 - x2;
		// top-left fill rule bias: left edges (A > 0) and top edges
		// (horizontal, interior below: B > 0) own their boundary pixels;
		// right/bottom edges yield them to the adjacent primitive. The
		// sign of B here must stay consistent with the bbox maxY-1 clamp,
		// otherwise meshes tear along shared horizontal edges.
		const bias12 = (A12 > 0 || (A12 === 0 && B12 > 0)) ? 0 : -1;
		const bias20 = (A20 > 0 || (A20 === 0 && B20 > 0)) ? 0 : -1;
		const bias01 = (A01 > 0 || (A01 === 0 && B01 > 0)) ? 0 : -1;

		let w0row = (A12 * bx0 + B12 * by0) + (x1 * y2 - y1 * x2) + bias12;
		let w1row = (A20 * bx0 + B20 * by0) + (x2 * y0 - y2 * x0) + bias20;
		let w2row = (A01 * bx0 + B01 * by0) + (x0 * y1 - y0 * x1) + bias01;

		const g = o.gouraud;
		const r0 = c0 & 0xff, g0 = (c0 >> 8) & 0xff, b0 = (c0 >> 16) & 0xff;
		const r1 = c1 & 0xff, g1 = (c1 >> 8) & 0xff, b1 = (c1 >> 16) & 0xff;
		const r2 = c2 & 0xff, g2 = (c2 >> 8) & 0xff, b2 = (c2 >> 16) & 0xff;
		// float reciprocal: integer fixed-point cannot represent 1/area
		// once area exceeds the fraction size (large triangles collapsed
		// to vertex-0 attributes), and bit-exactness with the reference
		// rasterizer requires these exact float expressions
		const inv = 1 / area;
		const vram = this.vram;
		const maskCheck = this.maskCheck;
		const maskSet = this.maskSet;
		const semiMode = o.semiMode;
		const semi = o.semi;

		if (!o.tex && !g) {
			const flatPx = (r0 >> 3) | ((g0 >> 3) << 5) | ((b0 >> 3) << 10);
			for (let y = by0; y <= by1; y++) {
				const span = rowSpan(w0row, w1row, w2row, A12, A20, A01, bx0, bx1);
				if (span < 0) {
					w0row += B12; w1row += B20; w2row += B01;
					continue;
				}
				const xLo = span & 0x7ff;
				const xHi = span >> 11;
				const dsp = xLo - bx0;
				let w0 = w0row + A12 * dsp, w1 = w1row + A20 * dsp, w2 = w2row + A01 * dsp;
				const row = y * VRAM_W;
				for (let x = xLo; x <= xHi; x++) {
					if ((w0 | w1 | w2) >= 0) {
						const idx = row + x;
						const back = vram[idx];
						if (!maskCheck || (back & 0x8000) === 0) {
							let px = flatPx;
							if (semi) px = blend(back, px, semiMode) | (px & 0x8000);
							vram[idx] = maskSet ? (px | 0x8000) : px;
						}
					}
					w0 += A12; w1 += A20; w2 += A01;
				}
				w0row += B12; w1row += B20; w2row += B01;
			}
			return;
		}

		if (!o.tex && g) {
			for (let y = by0; y <= by1; y++) {
				const span = rowSpan(w0row, w1row, w2row, A12, A20, A01, bx0, bx1);
				if (span < 0) {
					w0row += B12; w1row += B20; w2row += B01;
					continue;
				}
				const xLo = span & 0x7ff;
				const xHi = span >> 11;
				const dsp = xLo - bx0;
				let w0 = w0row + A12 * dsp, w1 = w1row + A20 * dsp, w2 = w2row + A01 * dsp;
				const row = y * VRAM_W;
				for (let x = xLo; x <= xHi; x++) {
					if ((w0 | w1 | w2) >= 0) {
						const l0 = (w0 - bias12) * inv;
						const l1 = (w1 - bias20) * inv;
						const l2 = (w2 - bias01) * inv;
						const r = (r0 * l0 + r1 * l1 + r2 * l2) | 0;
						const gg = (g0 * l0 + g1 * l1 + g2 * l2) | 0;
						const b = (b0 * l0 + b1 * l1 + b2 * l2) | 0;
						const idx = row + x;
						const back = vram[idx];
						if (!maskCheck || (back & 0x8000) === 0) {
							let px = (r >> 3) | ((gg >> 3) << 5) | ((b >> 3) << 10);
							if (semi) px = blend(back, px, semiMode) | (px & 0x8000);
							vram[idx] = maskSet ? (px | 0x8000) : px;
						}
					}
					w0 += A12; w1 += A20; w2 += A01;
				}
				w0row += B12; w1row += B20; w2row += B01;
			}
			return;
		}

		const raw = o.raw;
		const pageY = o.pageY;
		const baseX = o.baseX;
		const uMask = o.uMask;
		const uOr = o.uOr;
		const vMask = o.vMask;
		const vOr = o.vOr;
		const texDepth = o.texDepth;
		if (texDepth !== 2) this.#clutLoad(o);
		const clutCache = this.clutCache;

		if (o.tex && !g) {
			for (let y = by0; y <= by1; y++) {
				const span = rowSpan(w0row, w1row, w2row, A12, A20, A01, bx0, bx1);
				if (span < 0) {
					w0row += B12; w1row += B20; w2row += B01;
					continue;
				}
				const xLo = span & 0x7ff;
				const xHi = span >> 11;
				const dsp = xLo - bx0;
				let w0 = w0row + A12 * dsp, w1 = w1row + A20 * dsp, w2 = w2row + A01 * dsp;
				const row = y * VRAM_W;
				for (let x = xLo; x <= xHi; x++) {
					if ((w0 | w1 | w2) >= 0) {
						const l0 = (w0 - bias12) * inv;
						const l1 = (w1 - bias20) * inv;
						const l2 = (w2 - bias01) * inv;
						let tu = ((u0 * l0 + u1 * l1 + u2 * l2) | 0) & 0xff;
						let tv = ((v0 * l0 + v1 * l1 + v2 * l2) | 0) & 0xff;
						tu = (tu & uMask) | uOr;
						tv = (tv & vMask) | vOr;
						const trow = ((pageY + tv) & 0x1ff) * VRAM_W;
						let texel;
						if (texDepth === 0) {
							const word = vram[trow + ((baseX + (tu >> 2)) & 0x3ff)];
							const ti = (word >> ((tu & 3) << 2)) & 0xf;
							texel = clutCache[ti];
						} else if (texDepth === 1) {
							const word = vram[trow + ((baseX + (tu >> 1)) & 0x3ff)];
							const ti = (word >> ((tu & 1) << 3)) & 0xff;
							texel = clutCache[ti];
						} else {
							texel = vram[trow + ((baseX + tu) & 0x3ff)];
						}
						if (texel !== 0) {
							const stp = (texel & 0x8000) !== 0;
							let px = raw ? texel : modulate(texel, r0, g0, b0);
							const idx = row + x;
							const back = vram[idx];
							if (!maskCheck || (back & 0x8000) === 0) {
								if (semi && stp) px = blend(back, px, semiMode) | (px & 0x8000);
								vram[idx] = maskSet ? (px | 0x8000) : px;
							}
						}
					}
					w0 += A12; w1 += A20; w2 += A01;
				}
				w0row += B12; w1row += B20; w2row += B01;
			}
			return;
		}

		// textured + gouraud
		for (let y = by0; y <= by1; y++) {
			const span = rowSpan(w0row, w1row, w2row, A12, A20, A01, bx0, bx1);
			if (span < 0) {
				w0row += B12; w1row += B20; w2row += B01;
				continue;
			}
			const xLo = span & 0x7ff;
			const xHi = span >> 11;
			const dsp = xLo - bx0;
			let w0 = w0row + A12 * dsp, w1 = w1row + A20 * dsp, w2 = w2row + A01 * dsp;
			const row = y * VRAM_W;
			for (let x = xLo; x <= xHi; x++) {
				if ((w0 | w1 | w2) >= 0) {
					const l0 = (w0 - bias12) * inv;
					const l1 = (w1 - bias20) * inv;
					const l2 = (w2 - bias01) * inv;
					const r = (r0 * l0 + r1 * l1 + r2 * l2) | 0;
					const gg = (g0 * l0 + g1 * l1 + g2 * l2) | 0;
					const b = (b0 * l0 + b1 * l1 + b2 * l2) | 0;
					let tu = ((u0 * l0 + u1 * l1 + u2 * l2) | 0) & 0xff;
					let tv = ((v0 * l0 + v1 * l1 + v2 * l2) | 0) & 0xff;
					tu = (tu & uMask) | uOr;
					tv = (tv & vMask) | vOr;
					const trow = ((pageY + tv) & 0x1ff) * VRAM_W;
					let texel;
					if (texDepth === 0) {
						const word = vram[trow + ((baseX + (tu >> 2)) & 0x3ff)];
						const ti = (word >> ((tu & 3) << 2)) & 0xf;
						texel = clutCache[ti];
					} else if (texDepth === 1) {
						const word = vram[trow + ((baseX + (tu >> 1)) & 0x3ff)];
						const ti = (word >> ((tu & 1) << 3)) & 0xff;
						texel = clutCache[ti];
					} else {
						texel = vram[trow + ((baseX + tu) & 0x3ff)];
					}
					if (texel !== 0) {
						const stp = (texel & 0x8000) !== 0;
						let px = raw ? texel : modulate(texel, r, gg, b);
						const idx = row + x;
						const back = vram[idx];
						if (!maskCheck || (back & 0x8000) === 0) {
							if (semi && stp) px = blend(back, px, semiMode) | (px & 0x8000);
							vram[idx] = maskSet ? (px | 0x8000) : px;
						}
					}
				}
				w0 += A12; w1 += A20; w2 += A01;
			}
			w0row += B12; w1row += B20; w2row += B01;
		}
	}

	#drawRect() {
		const cmd = this.cmd;
		const b = this.buf;
		const size = (cmd >> 3) & 3;
		const tex = (cmd & 4) !== 0;
		const semi = (cmd & 2) !== 0;
		const raw = tex && (cmd & 1) !== 0;

		let i = 1;
		const xy = b[i++];
		const x0 = sx11(xy) + this.offX;
		const y0 = sy11(xy) + this.offY;
		let u0 = 0, v0 = 0, clut = 0;
		if (tex) {
			const t = b[i++];
			u0 = t & 0xff;
			v0 = (t >> 8) & 0xff;
			clut = (t >>> 16) & 0xffff;
		}
		let w, h;
		if (size === 0) {
			w = b[i] & 0x3ff;
			h = (b[i] >> 16) & 0x1ff;
		} else {
			w = h = RECT_SIZES[size];
		}

		const o = this._rectOpts;
		o.raw = raw;
		o.tex = tex;
		o.semi = semi;
		o.clutX = (clut & 0x3f) * 16;
		o.clutY = (clut >> 6) & 0x1ff;
		o.pageX = this.texBaseX;
		o.pageY = this.texBaseY;
		o.semiMode = this.semiMode;
		o.texDepth = this.texDepth;
		if (tex) {
			o.uMask = ~(this.texWinMaskX << 3);
			o.uOr = (this.texWinOffX & this.texWinMaskX) << 3;
			o.vMask = ~(this.texWinMaskY << 3);
			o.vOr = (this.texWinOffY & this.texWinMaskY) << 3;
			o.baseX = o.pageX * 64;
			o.clutRow = (o.clutY & 0x1ff) * VRAM_W;
		}
		if (this.hw !== null) {
			this.hw.setEnv(this);
			this.hw.rect(o, x0, y0, w, h, u0, v0,
				this.rectFlipX ? -1 : 1, this.rectFlipY ? -1 : 1, b[0] & 0xffffff);
			return;
		}
		const cr = b[0] & 0xff, cg = (b[0] >> 8) & 0xff, cb = (b[0] >> 16) & 0xff;
		const flat = ((cr >> 3)) | ((cg >> 3) << 5) | ((cb >> 3) << 10);

		const xa = Math.max(x0, this.drawX0);
		const ya = Math.max(y0, this.drawY0);
		const xb = Math.min(x0 + w - 1, this.drawX1);
		const yb = Math.min(y0 + h - 1, this.drawY1);
		const du = this.rectFlipX ? -1 : 1;
		const dv = this.rectFlipY ? -1 : 1;
		const vram = this.vram;
		const maskCheck = this.maskCheck;
		const maskSet = this.maskSet;
		const semiMode = o.semiMode;
		const pageY = o.pageY;
		const baseX = o.baseX;
		const uMask = o.uMask;
		const uOr = o.uOr;
		const vMask = o.vMask;
		const vOr = o.vOr;
		const texDepth = o.texDepth;

		if (!tex) {
			for (let y = ya; y <= yb; y++) {
				const row = y * VRAM_W;
				for (let x = xa; x <= xb; x++) {
					const idx = row + x;
					const back = vram[idx];
					if (!maskCheck || (back & 0x8000) === 0) {
						let px = flat;
						if (semi) px = blend(back, px, semiMode) | (px & 0x8000);
						vram[idx] = maskSet ? (px | 0x8000) : px;
					}
				}
			}
			return;
		}

		// textured: v/texture-row are per-row invariants, u steps by ±1
		// (integer increments are exactly (u0 + du*(x-x0)) & 0xff)
		if (texDepth !== 2 && xa <= xb && ya <= yb) this.#clutLoad(o);
		const clutCache = this.clutCache;
		const uStart = (u0 + du * (xa - x0)) & 0xff;
		for (let y = ya; y <= yb; y++) {
			const row = y * VRAM_W;
			const tv = ((v0 + dv * (y - y0)) & 0xff & vMask) | vOr;
			const trow = ((pageY + tv) & 0x1ff) * VRAM_W;
			let u = uStart;
			for (let x = xa; x <= xb; x++, u = (u + du) & 0xff) {
				const tu = (u & uMask) | uOr;
				let texel;
				if (texDepth === 0) {
					const word = vram[trow + ((baseX + (tu >> 2)) & 0x3ff)];
					const ti = (word >> ((tu & 3) << 2)) & 0xf;
					texel = clutCache[ti];
				} else if (texDepth === 1) {
					const word = vram[trow + ((baseX + (tu >> 1)) & 0x3ff)];
					const ti = (word >> ((tu & 1) << 3)) & 0xff;
					texel = clutCache[ti];
				} else {
					texel = vram[trow + ((baseX + tu) & 0x3ff)];
				}
				if (texel === 0) continue;
				let px = raw ? texel : modulate(texel, cr, cg, cb);
				const idx = row + x;
				const back = vram[idx];
				if (!maskCheck || (back & 0x8000) === 0) {
					if (semi && (texel & 0x8000) !== 0) px = blend(back, px, semiMode) | (px & 0x8000);
					vram[idx] = maskSet ? (px | 0x8000) : px;
				}
			}
		}
	}

	#drawLine(xy0, c0, xy1, c1, semi, gouraud) {
		this.#drawLineXY(sx11(xy0), sy11(xy0), c0, sx11(xy1), sy11(xy1), c1, semi, gouraud);
	}

	#drawLineXY(x0, y0, c0, x1, y1, c1, semi, gouraud) {
		x0 += this.offX; y0 += this.offY;
		x1 += this.offX; y1 += this.offY;
		const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
		if (dx >= 1024 || dy >= 512) return;
		if (this.hw !== null) {
			this.hw.setEnv(this);
			this.hw.line(x0, y0, c0, x1, y1, gouraud ? c1 : c0, semi, this.semiMode);
			return;
		}
		const steps = Math.max(dx, dy);
		const r0 = c0 & 0xff, g0 = (c0 >> 8) & 0xff, b0 = (c0 >> 16) & 0xff;
		const r1 = c1 & 0xff, g1 = (c1 >> 8) & 0xff, b1 = (c1 >> 16) & 0xff;
		const vram = this.vram;
		const maskCheck = this.maskCheck;
		const maskSet = this.maskSet;
		const semiMode = this.semiMode;
		for (let s = 0; s <= steps; s++) {
			const t = steps === 0 ? 0 : s / steps;
			const x = Math.round(x0 + (x1 - x0) * t);
			const y = Math.round(y0 + (y1 - y0) * t);
			if (x < this.drawX0 || x > this.drawX1 || y < this.drawY0 || y > this.drawY1) continue;
			let r = r0, g = g0, b = b0;
			if (gouraud) {
				r = (r0 + (r1 - r0) * t) | 0;
				g = (g0 + (g1 - g0) * t) | 0;
				b = (b0 + (b1 - b0) * t) | 0;
			}
			const px = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
			const idx = y * VRAM_W + x;
			const back = vram[idx];
			if (!maskCheck || (back & 0x8000) === 0) {
				let out = px;
				if (semi) out = blend(back, out, semiMode) | (out & 0x8000);
				vram[idx] = maskSet ? (out | 0x8000) : out;
			}
		}
	}

	/**
	 * Refills the CLUT cache when the (address, depth) tag changes. Like the
	 * real GPU, the cache is NOT refreshed when VRAM under it is rewritten —
	 * primitives naming the same CLUT keep sampling the stale copy.
	 * @param {{clutX: number, clutRow: number, texDepth: number}} o
	 */
	#clutLoad(o) {
		const key = o.clutRow + o.clutX + (o.texDepth << 24);
		if (key === this.clutCacheKey) return;
		this.clutCacheKey = key;
		const n = o.texDepth === 1 ? 256 : 16;
		const vram = this.vram;
		const cache = this.clutCache;
		for (let i = 0; i < n; i++) cache[i] = vram[o.clutRow + ((o.clutX + i) & 0x3ff)];
	}

	/**
	 * Fetches a texel honoring the texture window, page and depth.
	 * @return {number} - 0 means fully transparent
	 */
	#texel(u, v, o) {
		// texture window
		u = (u & ~(this.texWinMaskX << 3)) | ((this.texWinOffX & this.texWinMaskX) << 3);
		v = (v & ~(this.texWinMaskY << 3)) | ((this.texWinOffY & this.texWinMaskY) << 3);
		const vram = this.vram;
		const baseX = o.pageX * 64;
		const row = ((o.pageY + v) & 0x1ff) * VRAM_W;
		if (o.texDepth === 0) { // 4bit CLUT
			const word = vram[row + ((baseX + (u >> 2)) & 0x3ff)];
			const idx = (word >> ((u & 3) << 2)) & 0xf;
			return vram[((o.clutY & 0x1ff) * VRAM_W) + ((o.clutX + idx) & 0x3ff)];
		}
		if (o.texDepth === 1) { // 8bit CLUT
			const word = vram[row + ((baseX + (u >> 1)) & 0x3ff)];
			const idx = (word >> ((u & 1) << 3)) & 0xff;
			return vram[((o.clutY & 0x1ff) * VRAM_W) + ((o.clutX + idx) & 0x3ff)];
		}
		// 15bit direct
		return vram[row + ((baseX + u) & 0x3ff)];
	}

	/**
	 * Writes one pixel honoring mask bits and semi-transparency.
	 * @param {number} idx - vram index
	 * @param {number} px - 15bit color (+STP)
	 * @param {boolean} semi
	 * @param {number} mode - semi-transparency mode 0..3
	 */
	#plot(idx, px, semi, mode) {
		const vram = this.vram;
		const back = vram[idx];
		if (this.maskCheck && (back & 0x8000) !== 0) return;
		if (semi) {
			px = blend(back, px, mode) | (px & 0x8000);
		}
		vram[idx] = this.maskSet ? (px | 0x8000) : px;
	}

	/**
	 * Renders the visible display area as RGBA into `out`.
	 * @param {Uint32Array} out - width*height RGBA pixels (ABGR packed)
	 * @param {number} width
	 * @param {number} height
	 */
	renderDisplay(out, width, height) {
		const vram = this.vram;
		if (this.displayDisabled) {
			out.fill(0xff000000);
			return;
		}
		for (let y = 0; y < height; y++) {
			const srcY = (this.displayVramY + y) & 0x1ff;
			const row = srcY * VRAM_W;
			if (this.depth24) {
				// 24bpp: 3 bytes per pixel packed into halfwords
				const byteBase = this.displayVramX * 2;
				for (let x = 0; x < width; x++) {
					const off = byteBase + x * 3;
					const w0 = vram[row + (((off >> 1) | 0) & 0x3ff)];
					const w1 = vram[row + ((((off >> 1) | 0) + 1) & 0x3ff)];
					let r, g, b;
					if ((off & 1) === 0) {
						r = w0 & 0xff; g = w0 >> 8; b = w1 & 0xff;
					} else {
						r = w0 >> 8; g = w1 & 0xff; b = w1 >> 8;
					}
					out[y * width + x] = 0xff000000 | (b << 16) | (g << 8) | r;
				}
			} else {
				const lut = RGB555_TO_RGBA;
				const baseX = this.displayVramX;
				const dst = y * width;
				for (let x = 0; x < width; x++) {
					out[dst + x] = lut[vram[row + ((baseX + x) & 0x3ff)]];
				}
			}
		}
	}
}

/** @return {number} - 11bit sign-extended x from an XY parameter word */
function sx11(word) {
	return (word << 21) >> 21;
}

/** @return {number} - 11bit sign-extended y from an XY parameter word */
function sy11(word) {
	return (word << 5) >> 21;
}

/** @return {number} - 24bit color to 15bit */
function rgb24to15(c) {
	return ((c >> 3) & 0x1f) | (((c >> 11) & 0x1f) << 5) | (((c >> 19) & 0x1f) << 10);
}

/**
 * Intersects the three positive half-planes of a triangle's edge
 * functions with a row's x range. Exact integer math: the pruned pixels
 * are exactly the ones that fail the (w0|w1|w2) >= 0 test, so pixel
 * coverage is untouched — this only skips guaranteed-outside spans.
 * @param {number} w0 - edge values at (x0, y)
 * @param {number} w1
 * @param {number} w2
 * @param {number} a0 - per-pixel edge steps
 * @param {number} a1
 * @param {number} a2
 * @param {number} x0 - inclusive row bounds
 * @param {number} x1
 * @return {number} - packed xLo | (xHi << 11), or -1 for an empty row
 */
function rowSpan(w0, w1, w2, a0, a1, a2, x0, x1) {
	let lo = x0;
	let hi = x1;
	if (a0 > 0) {
		if (w0 < 0) { const k = x0 + (((a0 - 1 - w0) / a0) | 0); if (k > lo) lo = k; }
	} else if (a0 < 0) {
		if (w0 < 0) return -1;
		const k = x0 + ((w0 / -a0) | 0);
		if (k < hi) hi = k;
	} else if (w0 < 0) return -1;
	if (a1 > 0) {
		if (w1 < 0) { const k = x0 + (((a1 - 1 - w1) / a1) | 0); if (k > lo) lo = k; }
	} else if (a1 < 0) {
		if (w1 < 0) return -1;
		const k = x0 + ((w1 / -a1) | 0);
		if (k < hi) hi = k;
	} else if (w1 < 0) return -1;
	if (a2 > 0) {
		if (w2 < 0) { const k = x0 + (((a2 - 1 - w2) / a2) | 0); if (k > lo) lo = k; }
	} else if (a2 < 0) {
		if (w2 < 0) return -1;
		const k = x0 + ((w2 / -a2) | 0);
		if (k < hi) hi = k;
	} else if (w2 < 0) return -1;
	return lo > hi ? -1 : lo | (hi << 11);
}

/**
 * Texture modulation: texel * color / 128, saturated per 5bit channel.
 * @return {number}
 */
function modulate(texel, r, g, b) {
	let tr = ((texel & 0x1f) * r) >> 7;
	let tg = (((texel >> 5) & 0x1f) * g) >> 7;
	let tb = (((texel >> 10) & 0x1f) * b) >> 7;
	if (tr > 31) tr = 31;
	if (tg > 31) tg = 31;
	if (tb > 31) tb = 31;
	return tr | (tg << 5) | (tb << 10) | (texel & 0x8000);
}

/**
 * Semi-transparency blend of back and front 15bit pixels.
 * @param {number} mode - 0: B/2+F/2, 1: B+F, 2: B-F, 3: B+F/4
 * @return {number}
 */
function blend(back, front, mode) {
	let out = 0;
	for (let shift = 0; shift <= 10; shift += 5) {
		const bc = (back >> shift) & 0x1f;
		const fc = (front >> shift) & 0x1f;
		let c;
		switch (mode) {
		case 0: c = (bc >> 1) + (fc >> 1); break;
		case 1: c = bc + fc; break;
		case 2: c = bc - fc; break;
		default: c = bc + (fc >> 2); break;
		}
		if (c < 0) c = 0;
		if (c > 31) c = 31;
		out |= c << shift;
	}
	return out;
}
