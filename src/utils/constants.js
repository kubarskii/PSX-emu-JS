export const BINARY_TYPES = {
	BIOS: "BIOS",
	MEMCARD: "MEMCARD",
	ISO: "ISO",
	PATCH: "PATCH"
};

/**
 * Default length of PSX BIOS in bytes
 * @type {number}
 * */
export const BIOS_LEN = 512 * 1024;

/**
 * Default length of PSX I/O Ports in bytes
 * @type {number}
 * */
export const IO_LEN = 8 * 1024;

/**
 * Default length of Expansion 1 in bytes
 * @type {number}
 * */
export const E1_LEN = 8192 * 1024;

/**
 * Default length of Expansion 2 in bytes
 * @type {number}
 * */
export const E2_LEN = 8 * 1024;

/**
 * Default length of Expansion 3 in bytes
 * @type {number}
 * */
export const E3_LEN = 2048 * 1024;

/**
 * Default length on cache control
 * @type {number}
 * */
export const CACHE_LEN = 0.5 * 1024;

export const BIOS_POINTER = 0xbfc00000;
export const IO_POINTER = 0x1F801000;
export const EXPANSION_1_POINTER = 0x1F000000;
export const EXPANSION_2_POINTER = 0x1F802000;
export const EXPANSION_3_POINTER = 0x1FA00000;
export const CACHE_CONTROL_POINTER = 0xfffe0130;
