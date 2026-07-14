/**
 * WebGL2 hardware renderer backend for the PSX GPU.
 *
 * VRAM lives in an RGBA8 texture at an integer scale factor (5:5:5 color
 * expands losslessly to 8:8:8, alpha carries the mask/STP bit, so raw
 * 16-bit texel values reconstruct exactly in the shader). Primitives are
 * rasterized by the host GPU into a framebuffer over that texture at
 * scale, which is what buys the higher internal resolution; CLUT and
 * 4/8-bit texture decoding happen in the fragment shader with texelFetch
 * at the 1x grid, so paletted textures stay index-exact.
 *
 * Consecutive primitives that share draw state accumulate into one
 * vertex batch and flush as a single draw call; the sample copy used
 * for texture feedback is refreshed only when a batch actually samples
 * a region that pending draws have touched. Both are what keeps real
 * scenes (thousands of primitives per frame) at full speed.
 *
 * Approximations vs the software rasterizer: no dithering, no CLUT-cache
 * staleness semantics, and mask-check combined with semi-transparency on
 * the same primitive prefers the mask behavior. Primitives snap to the PSX
 * pixel grid (+0.5); presentation uses nearest upscale (no sharp-bilinear).
 */

const VRAM_W = 1024;
const VRAM_H = 512;
const MAX_VERTS = 16384;
const FLOATS_PER_VERT = 7; // x, y, r, g, b, u, v

const PRIM_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in vec2 aUv;
out vec3 vColor;
out vec2 vUv;
void main() {
	vColor = aColor;
	vUv = aUv;
	// +0.5 aligns GL fragment centers with PSX integer pixel coordinates
	gl_Position = vec4((aPos.x + 0.5) / 512.0 - 1.0, (aPos.y + 0.5) / 256.0 - 1.0, 0.0, 1.0);
}`;

const PRIM_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uVram;   // sample copy, scaled
uniform int uScale;
uniform int uMode;         // 0 flat, 1 direct 15bpp, 2 clut 4bit, 3 clut 8bit
uniform ivec2 uPage;       // texpage base (vram texels)
uniform ivec2 uClut;       // clut position (vram texels)
uniform ivec4 uWin;        // texture window: uMask, uOr, vMask, vOr
uniform int uRawTex;       // 1 = skip modulation
uniform int uStpPass;      // 0 opaque texels only, 1 stp texels only, 2 all
uniform float uForceAlpha; // 1 when mask-set forces the written mask bit
in vec3 vColor;
in vec2 vUv;
out vec4 fragColor;

int raw16(ivec2 t) {
	vec4 p = texelFetch(uVram, t, 0);
	return int(round(p.r * 31.0)) | (int(round(p.g * 31.0)) << 5) |
		(int(round(p.b * 31.0)) << 10) | (int(round(p.a)) << 15);
}

void main() {
	if (uMode == 0) {
		// quantize to the 5-bit lattice the software rasterizer writes
		vec3 q = floor(vColor * 255.0 / 8.0) / 31.0;
		fragColor = vec4(min(q, 1.0), uForceAlpha);
		return;
	}
	int u = (int(floor(vUv.x)) & uWin.x) | uWin.y;
	int v = (int(floor(vUv.y)) & uWin.z) | uWin.w;
	int texel;
	if (uMode == 1) {
		// direct 15bpp: integer texel grid (matches the software rasterizer)
		int tx = ((uPage.x + u) & 1023) * uScale;
		int ty = ((uPage.y + v) & 511) * uScale;
		texel = raw16(ivec2(tx, ty));
	} else {
		int idx;
		if (uMode == 2) {
			int wordX = (uPage.x + (u >> 2)) & 1023;
			idx = (raw16(ivec2(wordX * uScale, ((uPage.y + v) & 511) * uScale)) >> ((u & 3) << 2)) & 15;
		} else {
			int wordX = (uPage.x + (u >> 1)) & 1023;
			idx = (raw16(ivec2(wordX * uScale, ((uPage.y + v) & 511) * uScale)) >> ((u & 1) << 3)) & 255;
		}
		texel = raw16(ivec2(((uClut.x + idx) & 1023) * uScale, uClut.y * uScale));
	}
	if (texel == 0) discard;
	int stp = (texel >> 15) & 1;
	if (uStpPass == 0 && stp == 1) discard;
	if (uStpPass == 1 && stp == 0) discard;
	ivec3 t5 = ivec3(texel & 31, (texel >> 5) & 31, (texel >> 10) & 31);
	if (uRawTex == 0) {
		// integer modulation, bit-exact with the software rasterizer:
		// (texel5 * color8) >> 7, clamped to 31
		ivec3 c8 = ivec3(vColor * 255.0 + 0.5);
		t5 = min((t5 * c8) >> 7, ivec3(31));
	}
	fragColor = vec4(vec3(t5) / 31.0, max(float(stp), uForceAlpha));
}`;

const BLIT_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
out vec2 vUv;
void main() {
	vUv = aUv;
	gl_Position = vec4((aPos.x + 0.5) / 512.0 - 1.0, (aPos.y + 0.5) / 256.0 - 1.0, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;
uniform int uSrcScale;     // 1 for the staging texture, S for the sample copy
uniform float uForceAlpha;
in vec2 vUv;
out vec4 fragColor;
void main() {
	ivec2 t = ivec2(int(floor(vUv.x)) & 1023, int(floor(vUv.y)) & 511) * uSrcScale;
	vec4 p = texelFetch(uTex, t, 0);
	fragColor = vec4(p.rgb, max(p.a, uForceAlpha));
}`;

const PRESENT_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
	vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); // flip: vram row 0 is the top scanline
	gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const PRESENT_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;    // sample copy (NEAREST)
uniform vec4 uSrcRect;     // display area in scaled texels: x, y, w, h
in vec2 vUv;
out vec4 fragColor;
void main() {
	// nearest upscale: stable edges when the canvas is not an integer multiple
	vec2 src = uSrcRect.xy + vUv * uSrcRect.zw;
	ivec2 t = ivec2(int(floor(src.x)), int(floor(src.y)));
	fragColor = vec4(texelFetch(uTex, t, 0).rgb, 1.0);
}`;

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vsSrc
 * @param {string} fsSrc
 * @return {WebGLProgram | null}
 */
function link(gl, vsSrc, fsSrc) {
	const compile = (type, src) => {
		const sh = gl.createShader(type);
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
			console.error("psx-hw shader:", gl.getShaderInfoLog(sh));
			return null;
		}
		return sh;
	};
	const vs = compile(gl.VERTEX_SHADER, vsSrc);
	const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
	if (vs === null || fs === null) return null;
	const prog = gl.createProgram();
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		console.error("psx-hw link:", gl.getProgramInfoLog(prog));
		return null;
	}
	return prog;
}

/**
 * Creates the hardware GPU backend, or null when unsupported.
 * @param {WebGL2RenderingContext} gl
 * @param {number} scale - integer internal resolution multiplier
 * @return {object | null}
 */
export function createHwGpu(gl, scale) {
	if (gl === null || typeof gl.texStorage2D !== "function") return null;
	const S = Math.max(1, Math.min(8, scale | 0));
	const W = VRAM_W * S;
	const H = VRAM_H * S;

	const prim = link(gl, PRIM_VS, PRIM_FS);
	const blit = link(gl, BLIT_VS, BLIT_FS);
	const present = link(gl, PRESENT_VS, PRESENT_FS);
	if (prim === null || blit === null || present === null) return null;

	const makeTex = (w, h, filter) => {
		const t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return t;
	};
	const drawTex = makeTex(W, H, gl.NEAREST);
	const sampleTex = makeTex(W, H, gl.NEAREST);
	const stagingTex = makeTex(VRAM_W, VRAM_H, gl.NEAREST);

	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, drawTex, 0);
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);

	// batched vertex stream: one persistent buffer + VAO
	const vao = gl.createVertexArray();
	const vbo = gl.createBuffer();
	gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
	gl.bufferData(gl.ARRAY_BUFFER, MAX_VERTS * FLOATS_PER_VERT * 4, gl.DYNAMIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.enableVertexAttribArray(1);
	gl.enableVertexAttribArray(2);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
	gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 8);
	gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
	gl.bindVertexArray(null);

	const blitVao = gl.createVertexArray();
	const blitVbo = gl.createBuffer();
	gl.bindVertexArray(blitVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, blitVbo);
	gl.bufferData(gl.ARRAY_BUFFER, 64 * 4, gl.DYNAMIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.enableVertexAttribArray(1);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
	gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
	gl.bindVertexArray(null);

	const uni = (p, n) => gl.getUniformLocation(p, n);
	const U = {
		vram: uni(prim, "uVram"), scale: uni(prim, "uScale"), mode: uni(prim, "uMode"),
		page: uni(prim, "uPage"), clut: uni(prim, "uClut"), win: uni(prim, "uWin"),
		rawTex: uni(prim, "uRawTex"), stpPass: uni(prim, "uStpPass"), forceAlpha: uni(prim, "uForceAlpha"),
		bTex: uni(blit, "uTex"), bSrcScale: uni(blit, "uSrcScale"), bForceAlpha: uni(blit, "uForceAlpha"),
		pTex: uni(present, "uTex"), pSrcRect: uni(present, "uSrcRect"),
	};

	// dirty region of drawTex not yet copied into sampleTex
	let dx0 = 0, dy0 = 0, dx1 = 0, dy1 = 0, dirty = false;
	const markDirty = (x0, y0, x1, y1) => {
		x0 = Math.max(0, x0); y0 = Math.max(0, y0);
		x1 = Math.min(VRAM_W, x1); y1 = Math.min(VRAM_H, y1);
		if (x1 <= x0 || y1 <= y0) return;
		if (!dirty) { dx0 = x0; dy0 = y0; dx1 = x1; dy1 = y1; dirty = true; return; }
		dx0 = Math.min(dx0, x0); dy0 = Math.min(dy0, y0);
		dx1 = Math.max(dx1, x1); dy1 = Math.max(dy1, y1);
	};
	const syncSample = () => {
		if (!dirty) return;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.bindTexture(gl.TEXTURE_2D, sampleTex);
		gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, dx0 * S, dy0 * S, dx0 * S, dy0 * S,
			(dx1 - dx0) * S, (dy1 - dy0) * S);
		dirty = false;
	};

	// current batch state (also the draw environment from the GPU)
	const st = {
		mode: 0, pageX: 0, pageY: 0, clutX: 0, clutY: 0,
		uMask: -1, uOr: 0, vMask: -1, vOr: 0,
		raw: false, semi: false, semiMode: 0,
		maskSet: false, maskCheck: false,
		clipX0: 0, clipY0: 0, clipX1: 1023, clipY1: 511,
	};
	const verts = new Float32Array(MAX_VERTS * FLOATS_PER_VERT);
	let vCount = 0;
	let bMinX = 0, bMinY = 0, bMaxX = 0, bMaxY = 0;

	/** true when the pending dirty region overlaps what this state samples */
	const dirtyTouchesTexture = () => {
		if (!dirty || st.mode === 0) return false;
		const px = st.pageX * 64;
		const pw = st.mode === 1 ? 256 : (st.mode === 3 ? 128 : 64);
		if (dx1 > px && dx0 < px + pw && dy1 > st.pageY && dy0 < st.pageY + 256) return true;
		if (st.mode !== 1) {
			const cw = st.mode === 3 ? 256 : 16;
			if (dx1 > st.clutX && dx0 < st.clutX + cw && dy1 > st.clutY && dy0 < st.clutY + 1) return true;
		}
		return false;
	};

	/**
	 * @param {number} semiMode - 0..3, or -1 for opaque
	 * @param {boolean} maskCheck
	 */
	const setBlend = (semiMode, maskCheck) => {
		if (semiMode < 0) {
			if (maskCheck) {
				// keep the destination wherever its mask bit (alpha) is set
				gl.enable(gl.BLEND);
				gl.blendEquation(gl.FUNC_ADD);
				gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.DST_ALPHA,
					gl.ONE_MINUS_DST_ALPHA, gl.DST_ALPHA);
			} else {
				gl.disable(gl.BLEND);
			}
			return;
		}
		gl.enable(gl.BLEND);
		switch (semiMode) {
		case 0:
			gl.blendColor(0, 0, 0, 0.5);
			gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
			gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.CONSTANT_ALPHA, gl.ONE, gl.ZERO);
			return;
		case 1:
			gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
			gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO);
			return;
		case 2:
			gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD);
			gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO);
			return;
		default:
			gl.blendColor(0, 0, 0, 0.25);
			gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
			gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.ONE, gl.ONE, gl.ZERO);
			return;
		}
	};

	/** draws the accumulated batch (the heart of the renderer) */
	const flush = () => {
		if (vCount === 0) return;
		const tex = st.mode !== 0;
		if (tex && dirtyTouchesTexture()) syncSample();
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.viewport(0, 0, W, H);
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(st.clipX0 * S, st.clipY0 * S,
			Math.max(0, st.clipX1 - st.clipX0 + 1) * S, Math.max(0, st.clipY1 - st.clipY0 + 1) * S);
		gl.useProgram(prim);
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts.subarray(0, vCount * FLOATS_PER_VERT));
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, sampleTex);
		gl.uniform1i(U.vram, 0);
		gl.uniform1i(U.scale, S);
		gl.uniform1i(U.mode, st.mode);
		gl.uniform2i(U.page, st.pageX * 64, st.pageY);
		gl.uniform2i(U.clut, st.clutX, st.clutY);
		gl.uniform4i(U.win, st.uMask, st.uOr, st.vMask, st.vOr);
		gl.uniform1i(U.rawTex, st.raw ? 1 : 0);
		gl.uniform1f(U.forceAlpha, st.maskSet ? 1 : 0);

		if (!st.semi) {
			gl.uniform1i(U.stpPass, 2);
			setBlend(-1, st.maskCheck);
			gl.drawArrays(gl.TRIANGLES, 0, vCount);
		} else if (!tex) {
			gl.uniform1i(U.stpPass, 2);
			setBlend(st.semiMode, st.maskCheck);
			gl.drawArrays(gl.TRIANGLES, 0, vCount);
		} else {
			// textured semi-transparent: opaque texels first, then blended
			gl.uniform1i(U.stpPass, 0);
			setBlend(-1, st.maskCheck);
			gl.drawArrays(gl.TRIANGLES, 0, vCount);
			gl.uniform1i(U.stpPass, 1);
			setBlend(st.semiMode, st.maskCheck);
			gl.drawArrays(gl.TRIANGLES, 0, vCount);
		}
		gl.bindVertexArray(null);
		markDirty(Math.max(bMinX, st.clipX0), Math.max(bMinY, st.clipY0),
			Math.min(bMaxX, st.clipX1) + 1, Math.min(bMaxY, st.clipY1) + 1);
		vCount = 0;
	};

	/**
	 * Starts (or continues) a batch with the given state; flushes when the
	 * state differs from what is accumulated.
	 * @param {number} mode @param {object | null} o - prim opts (textured)
	 * @param {boolean} semi @param {number} semiMode
	 */
	const ensureState = (mode, o, semi, semiMode) => {
		const tex = mode !== 0;
		const same = vCount !== 0 &&
			st.mode === mode && st.semi === semi &&
			(!semi || st.semiMode === semiMode) &&
			(!tex || (st.pageX === o.pageX && st.pageY === o.pageY &&
				st.clutX === o.clutX && st.clutY === o.clutY &&
				st.uMask === o.uMask && st.uOr === o.uOr &&
				st.vMask === o.vMask && st.vOr === o.vOr && st.raw === (o.raw === true)));
		if (!same) flush();
		st.mode = mode;
		st.semi = semi;
		st.semiMode = semiMode;
		if (tex) {
			st.pageX = o.pageX | 0;
			st.pageY = o.pageY | 0;
			st.clutX = o.clutX | 0;
			st.clutY = o.clutY | 0;
			st.uMask = o.uMask !== undefined ? o.uMask : -1;
			st.uOr = o.uOr | 0;
			st.vMask = o.vMask !== undefined ? o.vMask : -1;
			st.vOr = o.vOr | 0;
			st.raw = o.raw === true;
		}
	};

	/** appends one vertex to the batch */
	const vertex = (x, y, r, g, b, u, v) => {
		let p = vCount * FLOATS_PER_VERT;
		verts[p++] = x;
		verts[p++] = y;
		verts[p++] = r;
		verts[p++] = g;
		verts[p++] = b;
		verts[p++] = u;
		verts[p] = v;
		vCount++;
		if (x < bMinX) bMinX = x;
		if (x > bMaxX) bMaxX = x;
		if (y < bMinY) bMinY = y;
		if (y > bMaxY) bMaxY = y;
	};
	const beginPrim = (needed) => {
		if (vCount + needed > MAX_VERTS) flush();
		if (vCount === 0) { bMinX = 4096; bMinY = 4096; bMaxX = -4096; bMaxY = -4096; }
	};

	const scratch = new Uint8Array(VRAM_W * VRAM_H * 4);
	const readScratch = {buf: null, cap: 0};

	/** blits w x h texels of srcTex at (sx,sy) to (dstX,dstY) into the fbo */
	const blitRect = (srcTex, srcScale, sx, sy, dstX, dstY, w, h, useMask, maskSet) => {
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.viewport(0, 0, W, H);
		gl.disable(gl.SCISSOR_TEST);
		gl.useProgram(blit);
		gl.bindVertexArray(blitVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, blitVbo);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([
			dstX, dstY, sx, sy,
			dstX + w, dstY, sx + w, sy,
			dstX, dstY + h, sx, sy + h,
			dstX + w, dstY + h, sx + w, sy + h,
		]));
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, srcTex);
		gl.uniform1i(U.bTex, 0);
		gl.uniform1i(U.bSrcScale, srcScale);
		gl.uniform1f(U.bForceAlpha, maskSet ? 1 : 0);
		if (useMask) {
			gl.enable(gl.BLEND);
			gl.blendEquation(gl.FUNC_ADD);
			gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.DST_ALPHA,
				gl.ONE_MINUS_DST_ALPHA, gl.DST_ALPHA);
		} else {
			gl.disable(gl.BLEND);
		}
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.bindVertexArray(null);
		markDirty(dstX, dstY, dstX + w, dstY + h);
	};

	return {
		scale: S,

		/** @param {import("./gpu").GPU} gpu */
		setEnv(gpu) {
			if (st.clipX0 !== gpu.drawX0 || st.clipY0 !== gpu.drawY0 ||
				st.clipX1 !== gpu.drawX1 || st.clipY1 !== gpu.drawY1 ||
				st.maskSet !== gpu.maskSet || st.maskCheck !== gpu.maskCheck) {
				flush();
				st.clipX0 = gpu.drawX0;
				st.clipY0 = gpu.drawY0;
				st.clipX1 = gpu.drawX1;
				st.clipY1 = gpu.drawY1;
				st.maskSet = gpu.maskSet;
				st.maskCheck = gpu.maskCheck;
			}
		},

		/**
		 * @param {object} o - polygon opts (semi/tex/raw/page/clut/window)
		 * @param {Int32Array} vx @param {Int32Array} vy @param {Int32Array} vc
		 * @param {Int32Array} vu @param {Int32Array} vv
		 * @param {number} i0 @param {number} i1 @param {number} i2
		 */
		triangle(o, vx, vy, vc, vu, vv, i0, i1, i2) {
			const minX = Math.min(vx[i0], vx[i1], vx[i2]);
			const maxX = Math.max(vx[i0], vx[i1], vx[i2]);
			const minY = Math.min(vy[i0], vy[i1], vy[i2]);
			const maxY = Math.max(vy[i0], vy[i1], vy[i2]);
			if (maxX - minX > 1023 || maxY - minY > 511) return; // hw size cull
			const tex = o.tex === true;
			const mode = !tex ? 0 : (o.texDepth === 0 ? 2 : (o.texDepth === 1 ? 3 : 1));
			ensureState(mode, tex ? o : null, o.semi === true, o.semiMode | 0);
			beginPrim(3);
			const idx = [i0, i1, i2];
			for (let k = 0; k < 3; k++) {
				const i = idx[k];
				const c = vc[i];
				vertex(vx[i], vy[i], (c & 0xff) / 255, ((c >> 8) & 0xff) / 255,
					((c >> 16) & 0xff) / 255, vu[i], vv[i]);
			}
		},

		/**
		 * @param {object} o - rect opts
		 * @param {number} x0 @param {number} y0 @param {number} w @param {number} h
		 * @param {number} u0 @param {number} v0 @param {number} du @param {number} dv
		 * @param {number} colorWord - GP0 word 0 (24bit color)
		 */
		rect(o, x0, y0, w, h, u0, v0, du, dv, colorWord) {
			if (w > 1023 || h > 511 || w <= 0 || h <= 0) return;
			const tex = o.tex === true;
			const mode = !tex ? 0 : (o.texDepth === 0 ? 2 : (o.texDepth === 1 ? 3 : 1));
			ensureState(mode, tex ? o : null, o.semi === true, o.semiMode | 0);
			beginPrim(6);
			const r = (colorWord & 0xff) / 255;
			const g = ((colorWord >> 8) & 0xff) / 255;
			const b = ((colorWord >> 16) & 0xff) / 255;
			// pixel k samples u0 + k*du: a flipped axis biases by +1 so the
			// pixel-center interpolant floors to the same texel sequence
			const ua = du > 0 ? u0 : u0 + 1;
			const ub = du > 0 ? u0 + w : u0 + 1 - w;
			const va = dv > 0 ? v0 : v0 + 1;
			const vb = dv > 0 ? v0 + h : v0 + 1 - h;
			vertex(x0, y0, r, g, b, ua, va);
			vertex(x0 + w, y0, r, g, b, ub, va);
			vertex(x0, y0 + h, r, g, b, ua, vb);
			vertex(x0 + w, y0, r, g, b, ub, va);
			vertex(x0, y0 + h, r, g, b, ua, vb);
			vertex(x0 + w, y0 + h, r, g, b, ub, vb);
		},

		/**
		 * @param {number} x0 @param {number} y0 @param {number} c0
		 * @param {number} x1 @param {number} y1 @param {number} c1
		 * @param {boolean} semi @param {number} semiMode
		 */
		line(x0, y0, c0, x1, y1, c1, semi, semiMode) {
			const ddx = x1 - x0, ddy = y1 - y0;
			if (Math.abs(ddx) > 1023 || Math.abs(ddy) > 511) return;
			ensureState(0, null, semi, semiMode | 0);
			beginPrim(6);
			const len = Math.max(1e-3, Math.hypot(ddx, ddy));
			// expand to a one-pixel-wide quad, endpoints padded half a pixel
			const nx = (-ddy / len) * 0.5, ny = (ddx / len) * 0.5;
			const ex = (ddx / len) * 0.5, ey = (ddy / len) * 0.5;
			const ax = x0 + 0.5 - ex, ay = y0 + 0.5 - ey;
			const bx = x1 + 0.5 + ex, by = y1 + 0.5 + ey;
			const r0 = (c0 & 0xff) / 255, g0 = ((c0 >> 8) & 0xff) / 255, b0 = ((c0 >> 16) & 0xff) / 255;
			const r1 = (c1 & 0xff) / 255, g1 = ((c1 >> 8) & 0xff) / 255, b1 = ((c1 >> 16) & 0xff) / 255;
			vertex(ax + nx, ay + ny, r0, g0, b0, 0, 0);
			vertex(ax - nx, ay - ny, r0, g0, b0, 0, 0);
			vertex(bx + nx, by + ny, r1, g1, b1, 0, 0);
			vertex(ax - nx, ay - ny, r0, g0, b0, 0, 0);
			vertex(bx + nx, by + ny, r1, g1, b1, 0, 0);
			vertex(bx - nx, by - ny, r1, g1, b1, 0, 0);
		},

		/**
		 * FILL: raw framebuffer coordinates, no clip, mask ignored.
		 * @param {number} x @param {number} y @param {number} w @param {number} h
		 * @param {number} colorWord - 24bit color
		 */
		fill(x, y, w, h, colorWord) {
			if (w <= 0 || h <= 0) return;
			flush();
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
			gl.viewport(0, 0, W, H);
			gl.enable(gl.SCISSOR_TEST);
			gl.scissor(x * S, y * S, w * S, h * S);
			const r5 = (colorWord & 0xff) >> 3;
			const g5 = ((colorWord >> 8) & 0xff) >> 3;
			const b5 = ((colorWord >> 16) & 0xff) >> 3;
			gl.clearColor(((r5 << 3) | (r5 >> 2)) / 255,
				((g5 << 3) | (g5 >> 2)) / 255,
				((b5 << 3) | (b5 >> 2)) / 255, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.clearColor(0, 0, 0, 0);
			markDirty(x, y, x + w, y + h);
		},

		/**
		 * VRAM->VRAM copy (mask-aware via blending).
		 * @param {number} sx @param {number} sy @param {number} dx @param {number} dy
		 * @param {number} w @param {number} h
		 */
		copy(sx, sy, dx, dy, w, h) {
			flush();
			syncSample();
			blitRect(sampleTex, S, sx, sy, dx, dy, w, h, st.maskCheck, st.maskSet);
		},

		/**
		 * CPU->VRAM upload: pulls the freshly written region from the
		 * shadow VRAM (wrap handled by splitting) into the scaled texture.
		 * @param {number} x @param {number} y @param {number} w @param {number} h
		 * @param {Uint16Array} shadow - the GPU's software VRAM
		 */
		imageIn(x, y, w, h, shadow) {
			flush();
			x &= 1023; y &= 511;
			const w0 = Math.min(w, VRAM_W - x);
			const h0 = Math.min(h, VRAM_H - y);
			const parts = [[x, y, w0, h0]];
			if (w > w0) parts.push([0, y, w - w0, h0]);
			if (h > h0) parts.push([x, 0, w0, h - h0]);
			if (w > w0 && h > h0) parts.push([0, 0, w - w0, h - h0]);
			for (const [rx, ry, rw, rh] of parts) {
				if (rw <= 0 || rh <= 0) continue;
				let p = 0;
				for (let yy = 0; yy < rh; yy++) {
					const row = (ry + yy) * VRAM_W;
					for (let xx = 0; xx < rw; xx++) {
						const t = shadow[row + rx + xx];
						// 5->8 with bit replication: round(v8*31/255) recovers
						// the exact 5-bit value, which the shader relies on to
						// reconstruct raw 16-bit words (CLUT indices!)
						const r = t & 31, g = (t >> 5) & 31, b = (t >> 10) & 31;
						scratch[p++] = (r << 3) | (r >> 2);
						scratch[p++] = (g << 3) | (g >> 2);
						scratch[p++] = (b << 3) | (b >> 2);
						scratch[p++] = (t >> 15) !== 0 ? 255 : 0;
					}
				}
				gl.bindTexture(gl.TEXTURE_2D, stagingTex);
				gl.texSubImage2D(gl.TEXTURE_2D, 0, rx, ry, rw, rh,
					gl.RGBA, gl.UNSIGNED_BYTE, scratch.subarray(0, rw * rh * 4));
				blitRect(stagingTex, 1, rx, ry, rx, ry, rw, rh, false, st.maskSet);
			}
		},

		/**
		 * VRAM->CPU read for GP0(C0): decimates the scaled framebuffer back
		 * to 1x and packs 16-bit texels into words.
		 * @param {number} x @param {number} y @param {number} w @param {number} h
		 * @return {Int32Array}
		 */
		imageOut(x, y, w, h) {
			flush();
			syncSample();
			const words = new Int32Array(Math.ceil(w * h / 2));
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
			const rx = Math.min(x & 1023, VRAM_W - 1);
			const ry = Math.min(y & 511, VRAM_H - 1);
			const rw = Math.min(w, VRAM_W - rx);
			const rh = Math.min(h, VRAM_H - ry);
			const need = rw * S * rh * S * 4;
			if (readScratch.cap < need) {
				readScratch.buf = new Uint8Array(need);
				readScratch.cap = need;
			}
			const buf = readScratch.buf;
			gl.readPixels(rx * S, ry * S, rw * S, rh * S, gl.RGBA, gl.UNSIGNED_BYTE, buf);
			for (let i = 0; i < w * h; i++) {
				const px = i % w;
				const py = (i / w) | 0;
				let t = 0;
				if (px < rw && py < rh) {
					const o = (py * S * rw * S + px * S) * 4;
					t = (buf[o] >> 3) | ((buf[o + 1] >> 3) << 5) |
						((buf[o + 2] >> 3) << 10) | (buf[o + 3] >= 128 ? 0x8000 : 0);
				}
				if ((i & 1) === 0) words[i >> 1] = t;
				else words[i >> 1] |= t << 16;
			}
			return words;
		},

		/**
		 * Draws the display area to the canvas (nearest upscale).
		 * @param {import("./gpu").GPU} gpu
		 * @param {number} cw - canvas width @param {number} ch - canvas height
		 * @return {boolean} - false when this mode needs the software path
		 */
		present(gpu, cw, ch) {
			if (gpu.depth24) return false; // 24bpp scanout stays on the CPU path
			flush();
			syncSample();
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, cw, ch);
			gl.disable(gl.SCISSOR_TEST);
			gl.disable(gl.BLEND);
			gl.clearColor(0, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			if (gpu.displayDisabled) return true;
			gl.useProgram(present);
			gl.bindVertexArray(blitVao);
			gl.bindBuffer(gl.ARRAY_BUFFER, blitVbo);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([
				-1, -1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 0, 1, 1, 0, 0,
			]));
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, sampleTex);
			gl.uniform1i(U.pTex, 0);
			gl.uniform4f(U.pSrcRect, gpu.displayVramX * S, gpu.displayVramY * S,
				(gpu.hres || 320) * S, (gpu.vres || 240) * S);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			gl.bindVertexArray(null);
			return true;
		},
	};
}
