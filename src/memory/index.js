import {Mapping, Range} from "./range";

export const memory = new Mapping();

export const initMemory = () => {
	/// Main RAM: 2MB mirrored four times over the first 8MB (probably
	/// in case they decided to use a bigger RAM later on?)
	const RAM = new Range(0x00000000, 8 * 1024 * 1024, "RAM");
	memory.add(RAM);

	/// Expansion region 1
	const EXPANSION_1 = new Range(0x1f000000, 512 * 1024, "EXPANSION 1");
	memory.add(EXPANSION_1);

	const BIOS = new Range(0x1fc00000, 512 * 1024, "BIOS");
	memory.add(BIOS);

	/// ScratchPad: data cache used as a fast 1kB RAM
	const SCRATCH_PAD = new Range(0x1f800000, 1024, "SCRATCH PAD");
	memory.add(SCRATCH_PAD);

	/// Memory latency and expansion mapping
	const MEM_CONTROL = new Range(0x1f801000, 36, "MEM CONTROL");
	memory.add(MEM_CONTROL);

	/// Gamepad and memory card controller
	const PAD_MEMCARD = new Range(0x1f801040, 32, "PAD MEMCARD");
	memory.add(PAD_MEMCARD);

	/// Register that has something to do with RAM configuration,
	/// configured by the BIOS
	const RAM_SIZE = new Range(0x1f801060, 16, "RAM SIZE");
	memory.add(RAM_SIZE);

	/// Interrupt Control regs (status and mask)
	const IRQ_CONTROL = new Range(0x1f801070, 16);
	memory.add(IRQ_CONTROL);

	/// Direct Memory Access regs
	const DMA = new Range(0x1f801080, 0x80);
	memory.add(DMA);

	const TIMERS = new Range(0x1f801100, 0x30);
	memory.add(TIMERS);

	/// CDROM controller
	const CDROM = new Range(0x1f801800, 0x4);
	memory.add(CDROM);

	const GPU = new Range(0x1f801810, 8);
	memory.add(GPU);

	const MDEC = new Range(0x1f801820, 8);
	memory.add(MDEC);

	/// SPU (Sound Processing Unit) regs
	const SPU = new Range(0x1f801c00, 640);
	memory.add(SPU);

	/// Expansion region 2
	const EXPANSION_2 = new Range(0x1f802000, 66, "EXPANSION 2");
	memory.add(EXPANSION_2);

	/// Cache control register. Full address since it's in KSEG2
	const CACHE_CONTROL = new Range(0xfffe0130, 4);
	memory.add(CACHE_CONTROL);
};
