import N from "../../src/utils/typed-number";

describe("Typed number test", () => {
	it ("should create typed number int8", () => {
		const n = 127;
		const n2 = 12;
		const n3 = 128;
		const n4 = 1024;
		const typedNumber = N.int8(n);
		const typedNumber2 = N.int8(n2);
		const typedNumber3 = N.int8(n3);
		const typedNumber4 = N.int8(n4);
		expect(typedNumber).toBe(127);
		expect(typedNumber2).toBe(12);
		expect(typedNumber3).toBe(-128);
		expect(typedNumber4).toBe(0);
	});

	it ("should create typed number uint8", () => {
		const n = 255;
		const n2 = 256;
		const typedNumber = N.uint8(n);
		const typedNumber2 = N.uint8(n2);
		expect(typedNumber).toBe(255);
		expect(typedNumber2).toBe(0);
	});
});
