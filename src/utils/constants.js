export const BINARY_TYPES = {
	BIOS: "BIOS",
	MEMCARD: "MEMCARD",
	ISO: "ISO",
	PATCH: "PATCH"
};

/**
 * Max size of the MUST be 512K in length
 * hex:0x80000 === dec:512 * 1024
 * @var {number} biosLength - the default length of PSX BIOS in bytes
 * */
export const BIOS_LEN = 0x80000;

export const DEFAULT_BIOS_PC = 0xbfc00000;

export const DEFAULT_MASK = 0x01ffffff;
