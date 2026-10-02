/**
 * Audio output. The emulator pushes interleaved stereo PCM chunks over a
 * MessagePort; the sink plays them and reports its fill level back so
 * the SPU can steer the per-frame sample count.
 *
 * Preferred sink: an AudioWorklet on the audio rendering thread — with
 * the emulator in a worker, samples never touch the main thread, so page
 * work (layout, GC, input) can't make audio crackle. Fallback (no
 * AudioWorklet, e.g. plain-http pages): a ScriptProcessorNode.
 */

export const SAMPLE_RATE = 44100;

/**
 * Jitter buffer shared by both sinks. Self-contained on purpose: its
 * source is also injected into the AudioWorklet scope via toString().
 */
class PcmRing {

	constructor() {
		this.cap = 16384; // stereo pairs (~370ms)
		this.buf = new Float32Array(this.cap * 2);
		this.head = 0;
		this.count = 0;
		this.received = 0;
		/** playback waits for a small cushion after every underrun */
		this.primed = false;
		this.prime = 1536;
	}

	/** @param {Float32Array} data - interleaved L/R */
	push(data) {
		const pairs = data.length >> 1;
		this.received += pairs;
		const cap = this.cap;
		const buf = this.buf;
		for (let i = 0; i < pairs; i++) {
			const tail = (this.head + this.count) % cap;
			buf[tail * 2] = data[i * 2];
			buf[tail * 2 + 1] = data[i * 2 + 1];
			if (this.count < cap) this.count++;
			else this.head = (this.head + 1) % cap; // overflow: drop oldest
		}
	}

	/**
	 * @param {Float32Array} left
	 * @param {Float32Array} right
	 */
	pull(left, right) {
		const n = left.length;
		if (!this.primed && this.count >= this.prime) this.primed = true;
		const cap = this.cap;
		const buf = this.buf;
		for (let i = 0; i < n; i++) {
			if (this.primed && this.count > 0) {
				left[i] = buf[this.head * 2];
				right[i] = buf[this.head * 2 + 1];
				this.head = (this.head + 1) % cap;
				this.count--;
			} else {
				left[i] = 0;
				right[i] = 0;
			}
		}
		if (this.count === 0) this.primed = false;
	}
}

const WORKLET_SRC = `
// bound by value: minifiers may rename the class itself
const PcmRing = ${PcmRing.toString()};
class PsxSink extends AudioWorkletProcessor {
	constructor() {
		super();
		this.ring = new PcmRing();
		this.src = null;
		this.quanta = 0;
		this.port.onmessage = (e) => {
			this.src = e.data;
			this.src.onmessage = (ev) => {
				if (ev.data.type === "pcm") this.ring.push(ev.data.data);
			};
		};
	}
	process(inputs, outputs) {
		const out = outputs[0];
		this.ring.pull(out[0], out.length > 1 ? out[1] : out[0]);
		if (this.src !== null && (++this.quanta & 7) === 0) {
			this.src.postMessage({type: "level", pairs: this.ring.count, received: this.ring.received});
		}
		return true;
	}
}
registerProcessor("psx-sink", PsxSink);
`;

/**
 * @param {AudioContext} ctx
 * @return {Promise<MessagePort>} - port for the emulator side
 */
async function workletSink(ctx) {
	const url = URL.createObjectURL(new Blob([WORKLET_SRC], {type: "application/javascript"}));
	try {
		await ctx.audioWorklet.addModule(url);
	} finally {
		URL.revokeObjectURL(url);
	}
	const node = new AudioWorkletNode(ctx, "psx-sink", {
		numberOfInputs: 0,
		numberOfOutputs: 1,
		outputChannelCount: [2],
	});
	node.connect(ctx.destination);
	const channel = new MessageChannel();
	node.port.postMessage(channel.port1, [channel.port1]);
	return channel.port2;
}

/**
 * @param {AudioContext} ctx
 * @return {MessagePort}
 */
function scriptProcessorSink(ctx) {
	const ring = new PcmRing();
	const channel = new MessageChannel();
	const port = channel.port1;
	port.onmessage = (e) => {
		if (e.data.type === "pcm") ring.push(e.data.data);
	};
	const node = ctx.createScriptProcessor(1024, 0, 2);
	node.onaudioprocess = (e) => {
		ring.pull(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1));
		port.postMessage({type: "level", pairs: ring.count, received: ring.received});
	};
	node.connect(ctx.destination);
	return channel.port2;
}

/**
 * Creates the audio context and its sink. Must be called from a user
 * gesture (autoplay policy); resume() the context on later gestures.
 * @return {Promise<{ctx: AudioContext, port: MessagePort, kind: string}>}
 */
export async function startAudio() {
	const Ctx = window.AudioContext || window.webkitAudioContext;
	const ctx = new Ctx({sampleRate: SAMPLE_RATE, latencyHint: "interactive"});
	ctx.resume();
	if (ctx.audioWorklet !== undefined && typeof AudioWorkletNode === "function") {
		try {
			return {ctx, port: await workletSink(ctx), kind: "worklet"};
		} catch {
			// fall through to the main-thread sink
		}
	}
	return {ctx, port: scriptProcessorSink(ctx), kind: "script-processor"};
}

export {PcmRing};
