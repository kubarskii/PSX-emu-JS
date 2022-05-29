import {Mapping, Range} from "../../src/memory/range";
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

	it("should write to right range from mapping", () => {
		const map = new Mapping();
		const r1 = new Range(0x1fc00000, 8);
		const r2 = new Range(0x1fc00200, 8);

		map.add(r1);
		map.add(r2);

		map.memWrite(0xbfc00204, 0xf);
		map.memWrite(0xbfc00000, 0xa);

		expect(r2.data[1]).toBe(0xf);
		expect(r1.data[0]).toBe(0xa);
	});

	it("should write value to memory", () => {
		initMemory();
		memory.memWrite(0x1f801060 >>> 0, 10);
		expect(memory.memRead(0x1f801060)).toBe(10);
	});

});
