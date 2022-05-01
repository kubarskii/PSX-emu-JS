import {Mapping, Range} from "../../src/memory/range";
import {BIOS_LEN} from "../../src/utils/constants";

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
		const range = new Range(0xbfc00000, BIOS_LEN);
		map.add(range);
		map.memWrite(0xbfc00001, 0xf);
		const v = map.memRead(0xbfc00001);
		expect(range.data[1]).toBe(0xf);
		expect(v).toBe(0xf);
	});

});
