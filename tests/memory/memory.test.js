import {Memory, PAGE_SHIFT} from "../../src/memory";

describe("Memory map", () => {
	let mem;
	beforeEach(() => {
		mem = new Memory();
	});

	it("mirrors RAM across KUSEG/KSEG0/KSEG1", () => {
		mem.write32(0x00000000, 0x12345678);
		expect(mem.read32(0x80000000) >>> 0).toBe(0x12345678);
		expect(mem.read32(0xa0000000) >>> 0).toBe(0x12345678);
	});

	it("mirrors the 2MB of RAM inside the 8MB window", () => {
		mem.write32(0x00000010, 0xdeadbeef | 0);
		expect(mem.read32(0x00200010) >>> 0).toBe(0xdeadbeef);
		expect(mem.read32(0x00600010) >>> 0).toBe(0xdeadbeef);
	});

	it("is little-endian across access sizes", () => {
		mem.write32(0x0, 0x44332211);
		expect(mem.read8(0x0)).toBe(0x11);
		expect(mem.read8(0x3)).toBe(0x44);
		expect(mem.read16(0x0)).toBe(0x2211);
		expect(mem.read16(0x2)).toBe(0x4433);
		mem.write8(0x1, 0xaa);
		expect(mem.read32(0x0) >>> 0).toBe(0x4433aa11);
	});

	it("reads all-ones from Expansion 1 (no device)", () => {
		expect(mem.read8(0x1f000000)).toBe(0xff);
		expect(mem.read16(0x1f000084)).toBe(0xffff);
		expect(mem.read32(0xbf000100) | 0).toBe(-1);
	});

	it("ignores writes to BIOS ROM", () => {
		mem.write32(0xbfc00000, 0x1234);
		expect(mem.read32(0xbfc00000)).toBe(0);
	});

	it("loads and reads back the BIOS image", () => {
		const img = new ArrayBuffer(512 * 1024);
		new Uint32Array(img)[0] = 0x3c080013;
		mem.loadBios(img);
		expect(mem.read32(0xbfc00000) >>> 0).toBe(0x3c080013);
		expect(mem.read32(0x9fc00000) >>> 0).toBe(0x3c080013);
	});

	it("scratchpad is reachable in KUSEG/KSEG0", () => {
		mem.write32(0x1f800010, 77);
		expect(mem.read32(0x9f800010)).toBe(77);
	});

	it("stores and acknowledges interrupt bits", () => {
		mem.write32(0x1f801074, 0x1); // I_MASK: enable VBlank
		expect(mem.irqLine).toBe(false);
		mem.raiseIrq(0);
		expect(mem.irqLine).toBe(true);
		expect(mem.read32(0x1f801070)).toBe(1);
		mem.write32(0x1f801070, 0x0); // acknowledge
		expect(mem.read32(0x1f801070)).toBe(0);
		expect(mem.irqLine).toBe(false);
	});

	it("reports GPU ready bits in GPUSTAT", () => {
		const stat = mem.read32(0x1f801814) >>> 0;
		expect((stat >>> 26) & 1).toBe(1);
		expect((stat >>> 28) & 1).toBe(1);
	});

	it("keeps plain I/O registers store-backed", () => {
		mem.write32(0x1f801060, 0x00000b88); // RAM_SIZE
		expect(mem.read32(0x1f801060)).toBe(0x00000b88);
		mem.write32(0xfffe0130, 0x0001e988); // cache control
		expect(mem.read32(0xfffe0130)).toBe(0x0001e988);
	});

	it("notifies about writes into pages with compiled code", () => {
		const hits = [];
		const pageSize = 1 << PAGE_SHIFT;
		mem.onCodeWrite = (page) => hits.push(page);
		mem.codePages[1] = 1;
		mem.write32(pageSize + 0x10, 5);  // page 1, value changes
		mem.write32(pageSize + 0x10, 5);  // identical rewrite: no invalidation
		mem.write8(0x00000010, 5);        // page 0: not marked, no hit
		expect(hits).toEqual([1]);
	});
});
