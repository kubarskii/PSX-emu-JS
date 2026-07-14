/**
 * Frame presentation: WebGL2 hardware renderer (internal resolution
 * scaling), WebGL texture blit, or Canvas2D — in that order of
 * preference. Uses a single context per canvas.
 */

import {createHwGpu} from "../gpu/hw-backend";

const VS = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
	vUv = aUv;
	gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() {
	gl_FragColor = texture2D(uTex, vUv);
}`;

/**
 * @param {WebGLRenderingContext} gl
 * @param {number} type
 * @param {string} src
 * @return {WebGLShader}
 */
function compileShader(gl, type, src) {
	const sh = gl.createShader(type);
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		gl.deleteShader(sh);
		return null;
	}
	return sh;
}

/**
 * @param {WebGLRenderingContext} gl
 * @return {WebGLProgram | null}
 */
function linkProgram(gl) {
	const vs = compileShader(gl, gl.VERTEX_SHADER, VS);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, FS);
	if (vs === null || fs === null) return null;
	const prog = gl.createProgram();
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	gl.linkProgram(prog);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		gl.deleteProgram(prog);
		return null;
	}
	return prog;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @return {{resize: (w: number, h: number) => void, frameBuffer: () => Uint32Array, present: () => void}}
 */
function createWebGLDisplay(canvas) {
	const gl = canvas.getContext("webgl", {
		alpha: false,
		antialias: false,
		depth: false,
		stencil: false,
		preserveDrawingBuffer: false,
	});
	if (gl === null) return null;

	const prog = linkProgram(gl);
	if (prog === null) return null;

	gl.useProgram(prog);
	const aPos = gl.getAttribLocation(prog, "aPos");
	const aUv = gl.getAttribLocation(prog, "aUv");
	gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);

	// fullscreen quad; V-flip in UV so CPU top row maps to screen top
	const vbo = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		-1, -1, 0, 1,
		1, -1, 1, 1,
		-1, 1, 0, 0,
		1, 1, 1, 0,
	]), gl.STATIC_DRAW);
	gl.enableVertexAttribArray(aPos);
	gl.enableVertexAttribArray(aUv);
	gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
	gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

	const tex = gl.createTexture();
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

	let w = 0;
	let h = 0;
	let framePixels = new Uint32Array(0);
	let frameBytes = new Uint8Array(0);

	return {
		resize(nw, nh) {
			if (nw === w && nh === h) return;
			w = nw;
			h = nh;
			canvas.width = w;
			canvas.height = h;
			gl.viewport(0, 0, w, h);
			framePixels = new Uint32Array(w * h);
			frameBytes = new Uint8Array(framePixels.buffer, framePixels.byteOffset, framePixels.byteLength);
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		},
		frameBuffer() {
			return framePixels;
		},
		present() {
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, frameBytes);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		},
	};
}

/**
 * @param {HTMLCanvasElement} canvas
 */
function createCanvas2DDisplay(canvas) {
	const ctx = canvas.getContext("2d");
	let image = null;
	let framePixels = new Uint32Array(0);

	return {
		resize(w, h) {
			canvas.width = w;
			canvas.height = h;
			image = ctx.createImageData(w, h);
			framePixels = new Uint32Array(image.data.buffer);
		},
		frameBuffer() {
			return framePixels;
		},
		present() {
			ctx.putImageData(image, 0, 0);
		},
	};
}

/**
 * Hardware display: the emulated GPU renders on the host GPU at an
 * integer scale, and frames present straight from its VRAM texture with
 * a sharp-bilinear upscale to the real canvas size. Falls back to the
 * CPU scanout path (24bpp video) through the same context.
 * @param {HTMLCanvasElement} canvas
 * @param {number} scale
 */
function createHwDisplay(canvas, scale) {
	const gl = canvas.getContext("webgl2", {
		alpha: false,
		antialias: false,
		depth: false,
		stencil: false,
		preserveDrawingBuffer: false,
	});
	if (gl === null) return null;
	const hw = createHwGpu(gl, scale);
	if (hw === null) return null;

	// CPU-frame path over the same context (24bpp FMV scanout)
	const prog = linkProgram(gl);
	if (prog === null) return null;
	const aPos = gl.getAttribLocation(prog, "aPos");
	const aUv = gl.getAttribLocation(prog, "aUv");
	const swVbo = gl.createBuffer();
	const swTex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, swTex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	let swW = 0, swH = 0;
	let swPixels = new Uint32Array(0);

	const fitCanvas = () => {
		const dpr = (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
		const w = Math.max(1, Math.min(4096, Math.round(canvas.clientWidth * dpr) || 1024));
		const h = Math.max(1, Math.min(4096, Math.round(canvas.clientHeight * dpr) || 512));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
	};

	return {
		backend: "webgl2-hw",
		hw,
		/** @param {import("../gpu/gpu").GPU} gpu */
		present(gpu) {
			fitCanvas();
			if (hw.present(gpu, canvas.width, canvas.height)) return;
			// 24bpp scanout: render on the CPU from the shadow VRAM
			const w = gpu.hres || 320;
			const h = gpu.vres || 240;
			if (w !== swW || h !== swH) {
				swW = w;
				swH = h;
				swPixels = new Uint32Array(w * h);
				gl.bindTexture(gl.TEXTURE_2D, swTex);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
			}
			gpu.renderDisplay(swPixels, w, h);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, canvas.width, canvas.height);
			gl.disable(gl.SCISSOR_TEST);
			gl.disable(gl.BLEND);
			gl.useProgram(prog);
			gl.bindBuffer(gl.ARRAY_BUFFER, swVbo);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
				-1, -1, 0, 1,
				1, -1, 1, 1,
				-1, 1, 0, 0,
				1, 1, 1, 0,
			]), gl.STREAM_DRAW);
			gl.enableVertexAttribArray(aPos);
			gl.enableVertexAttribArray(aUv);
			gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
			gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, swTex);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE,
				new Uint8Array(swPixels.buffer, 0, w * h * 4));
			gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		},
	};
}

/** @return {number} - internal scale preference (0 = software renderer) */
export function gpuScalePreference() {
	try {
		const m = typeof location !== "undefined" && location.search.match(/[?&]gpuscale=(\d+)/);
		if (m) return parseInt(m[1], 10);
		const stored = localStorage.getItem("psx-gpu-scale");
		if (stored !== null) return parseInt(stored, 10) || 0;
	} catch {
		// storage unavailable: fall through to the default
	}
	// the hardware renderer is opt-in while it matures
	return 0;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @return {{present: () => void, backend: string, hw?: object}}
 */
export function createDisplay(canvas) {
	const scale = gpuScalePreference();
	if (scale > 0) {
		const hwDisp = createHwDisplay(canvas, scale);
		if (hwDisp !== null) return hwDisp;
	}
	const gl = createWebGLDisplay(canvas);
	if (gl !== null) {
		return {...gl, backend: "webgl"};
	}
	return {...createCanvas2DDisplay(canvas), backend: "canvas2d"};
}
