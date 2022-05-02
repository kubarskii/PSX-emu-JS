import {Mapping, Range} from "./range";
import {
	BIOS_LEN,
	BIOS_POINTER,
	E1_LEN,
	E2_LEN,
	E3_LEN,
	EXPANSION_1_POINTER,
	EXPANSION_2_POINTER,
	EXPANSION_3_POINTER,
	IO_LEN,
	IO_POINTER
} from "../utils/constants";

export const memory = new Mapping();

export const initMemory = () => {
	const biosRange = new Range(BIOS_POINTER, BIOS_LEN);
	const ioRange = new Range(IO_POINTER, IO_LEN);
	const ex1 = new Range(EXPANSION_1_POINTER, E1_LEN);
	const ex2 = new Range(EXPANSION_2_POINTER, E2_LEN);
	const ex3 = new Range(EXPANSION_3_POINTER, E3_LEN);

	memory.add(biosRange);
	memory.add(ioRange);
	memory.add(ex1);
	memory.add(ex2);
	memory.add(ex3);
};
