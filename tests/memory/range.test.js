import {Mapping, Range} from "../../src/memory/range";
import {BIOS_LEN} from "../../src/utils/constants";
import {initMemory, memory} from "../../src/memory";

describe("Range and Mapping tests", () => {

	it("should create Range", () => {
		const range = new Range();
		expect(range).toBeTruthy();
	});

	it("should create Mapping", () => {
		const mapping = new Mapping();
		expect(mapping).toBeTruthy();
	});

	it("should create mapping with range containing BIOS and write values", () => {
		const map = new Mapping();
		const range = new Range(0x1fc00000, BIOS_LEN);
		map.add(range);
		map.memWrite(0x1fc00200, 0xf, true);
		const v = map.memRead(0xbfc00200);
		expect(range.data[128]).toBe(0xf);
		expect(v).toBe(0xf);
	});

	it("should write to right range from mapping", () => {
		const map = new Mapping();
		const r1 = new Range(0x1fc00000, 8);
		const r2 = new Range(0x1fc00200, 8);

		map.add(r1);
		map.add(r2);

		map.memWrite(0xbfc00204, 0xf, true);
		map.memWrite(0xbfc00000, 0xa, true);

		expect(r2.data[1]).toBe(0xf);
		expect(r1.data[0]).toBe(0xa);
	});

	it("should write value to memory", () => {
		initMemory();
		memory.memWrite(0x1f801060 >>> 0, 10);
		expect(memory.memRead(0x1f801060)).toBe(10);
	});

});
