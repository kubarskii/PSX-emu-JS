import {Memory} from "../../src/memory";
import {DMA} from "../../src/dma/dma";
import {GPU} from "../../src/gpu/gpu";

/** @return {{mem: Memory, dma: DMA, gpu: GPU, irqs: number[]}} */
function makeDma() {
	const mem = new Memory();
	const irqs = [];
	const dma = new DMA(mem, (bit) => irqs.push(bit));
	const gpu = new GPU(() => {});
	gpu.gp0(0xe4000000 | (511 << 10) | 1023); // open the draw area
	dma.gpu = gpu;
	mem.attach({dma, gpu});
	mem.write32(0x1f8010f0, 0x0bbbbbbb); // DPCR: enable every channel
	return {mem, dma, gpu, irqs};
}

describe("DMA", () => {
	it("OTC builds a reverse-linked ordering table", () => {
		const {mem} = makeDma();
		mem.write32(0x1f8010e0, 0x00001000);  // MADR
		mem.write32(0x1f8010e4, 4);           // BCR: 4 entries
		mem.write32(0x1f8010e8, 0x11000002);  // CHCR: start
		expect(mem.read32(0x1000) >>> 0).toBe(0x0ffc);
		expect(mem.read32(0x0ffc) >>> 0).toBe(0x0ff8);
		expect(mem.read32(0x0ff8) >>> 0).toBe(0x0ff4);
		expect(mem.read32(0x0ff4) >>> 0).toBe(0x00ffffff);
		expect(mem.read32(0x1f8010e8) & 0x11000000).toBe(0); // busy cleared
	});

	it("feeds the GPU through linked-list mode", () => {
		const {mem, gpu} = makeDma();
		// packet at 0x400: fill rect red at (32,16) 32x8, then end marker
		mem.write32(0x400, (3 << 24) | 0xffffff);  // 3 words, end of list
		mem.write32(0x404, 0x020000ff);
		mem.write32(0x408, (16 << 16) | 32);
		mem.write32(0x40c, (8 << 16) | 32);
		mem.write32(0x1f8010a0, 0x400);            // MADR
		mem.write32(0x1f8010a8, 0x01000401);       // CHCR: linked list, from RAM, start
		expect(gpu.vram[16 * 1024 + 32]).toBe(0x1f);
		expect(mem.read32(0x1f8010a8) & 0x01000000).toBe(0);
	});

	it("uploads an image block to the GPU (VRAM write)", () => {
		const {mem, gpu} = makeDma();
		// stage GP0 image command manually, then push pixels via DMA block
		gpu.gp0(0xa0000000);
		gpu.gp0((8 << 16) | 4);
		gpu.gp0((1 << 16) | 4);      // 4x1 pixels = 2 words
		mem.write32(0x800, 0x22221111);
		mem.write32(0x804, 0x44443333);
		mem.write32(0x1f8010a0, 0x800);
		mem.write32(0x1f8010a4, (1 << 16) | 2);    // 1 block of 2 words
		mem.write32(0x1f8010a8, 0x01000201);       // block mode, from RAM, start
		expect(gpu.vram[8 * 1024 + 4]).toBe(0x1111);
		expect(gpu.vram[8 * 1024 + 7]).toBe(0x4444);
	});

	it("raises IRQ3 when the channel interrupt is enabled", () => {
		const {mem, irqs} = makeDma();
		mem.write32(0x1f8010f4, (1 << 23) | (1 << 22)); // master + ch6 enable
		mem.write32(0x1f8010e0, 0x100);
		mem.write32(0x1f8010e4, 1);
		mem.write32(0x1f8010e8, 0x11000002);
		expect(irqs).toContain(3);
		expect((mem.read32(0x1f8010f4) >>> (24 + 6)) & 1).toBe(1); // flag set
		expect(mem.read32(0x1f8010f4) < 0).toBe(true);             // master flag
	});
});
