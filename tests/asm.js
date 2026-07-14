/**
 * Tiny MIPS I assembler used by the tests: each helper returns the raw
 * 32bit instruction word.
 */

const I = (op, rs, rt, imm) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) | 0;
const R = (funct, rs, rt, rd, shamt = 0) => ((rs << 21) | (rt << 16) | (rd << 11) | (shamt << 6) | funct) | 0;
const J_ = (op, target) => ((op << 26) | ((target >>> 2) & 0x3ffffff)) | 0;

export const NOP = 0;

export const SLL = (rd, rt, sa) => R(0x00, 0, rt, rd, sa);
export const SRL = (rd, rt, sa) => R(0x02, 0, rt, rd, sa);
export const SRA = (rd, rt, sa) => R(0x03, 0, rt, rd, sa);
export const SLLV = (rd, rt, rs) => R(0x04, rs, rt, rd);
export const SRLV = (rd, rt, rs) => R(0x06, rs, rt, rd);
export const SRAV = (rd, rt, rs) => R(0x07, rs, rt, rd);
export const JR = (rs) => R(0x08, rs, 0, 0);
export const JALR = (rd, rs) => R(0x09, rs, 0, rd);
export const SYSCALL = () => R(0x0c, 0, 0, 0);
export const BREAK = () => R(0x0d, 0, 0, 0);
export const MFHI = (rd) => R(0x10, 0, 0, rd);
export const MTHI = (rs) => R(0x11, rs, 0, 0);
export const MFLO = (rd) => R(0x12, 0, 0, rd);
export const MTLO = (rs) => R(0x13, rs, 0, 0);
export const MULT = (rs, rt) => R(0x18, rs, rt, 0);
export const MULTU = (rs, rt) => R(0x19, rs, rt, 0);
export const DIV = (rs, rt) => R(0x1a, rs, rt, 0);
export const DIVU = (rs, rt) => R(0x1b, rs, rt, 0);
export const ADD = (rd, rs, rt) => R(0x20, rs, rt, rd);
export const ADDU = (rd, rs, rt) => R(0x21, rs, rt, rd);
export const SUB = (rd, rs, rt) => R(0x22, rs, rt, rd);
export const SUBU = (rd, rs, rt) => R(0x23, rs, rt, rd);
export const AND = (rd, rs, rt) => R(0x24, rs, rt, rd);
export const OR = (rd, rs, rt) => R(0x25, rs, rt, rd);
export const XOR = (rd, rs, rt) => R(0x26, rs, rt, rd);
export const NOR = (rd, rs, rt) => R(0x27, rs, rt, rd);
export const SLT = (rd, rs, rt) => R(0x2a, rs, rt, rd);
export const SLTU = (rd, rs, rt) => R(0x2b, rs, rt, rd);

export const BLTZ = (rs, off) => I(0x01, rs, 0x00, off);
export const BGEZ = (rs, off) => I(0x01, rs, 0x01, off);
export const BLTZAL = (rs, off) => I(0x01, rs, 0x10, off);
export const BGEZAL = (rs, off) => I(0x01, rs, 0x11, off);
export const J = (target) => J_(0x02, target);
export const JAL = (target) => J_(0x03, target);
export const BEQ = (rs, rt, off) => I(0x04, rs, rt, off);
export const BNE = (rs, rt, off) => I(0x05, rs, rt, off);
export const BLEZ = (rs, off) => I(0x06, rs, 0, off);
export const BGTZ = (rs, off) => I(0x07, rs, 0, off);
export const ADDI = (rt, rs, imm) => I(0x08, rs, rt, imm);
export const ADDIU = (rt, rs, imm) => I(0x09, rs, rt, imm);
export const SLTI = (rt, rs, imm) => I(0x0a, rs, rt, imm);
export const SLTIU = (rt, rs, imm) => I(0x0b, rs, rt, imm);
export const ANDI = (rt, rs, imm) => I(0x0c, rs, rt, imm);
export const ORI = (rt, rs, imm) => I(0x0d, rs, rt, imm);
export const XORI = (rt, rs, imm) => I(0x0e, rs, rt, imm);
export const LUI = (rt, imm) => I(0x0f, 0, rt, imm);

export const MFC0 = (rt, rd) => ((0x10 << 26) | (0x00 << 21) | (rt << 16) | (rd << 11)) | 0;
export const MTC0 = (rt, rd) => ((0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11)) | 0;
export const RFE = () => ((0x10 << 26) | (0x10 << 21) | 0x10) | 0;

export const LB = (rt, off, rs) => I(0x20, rs, rt, off);
export const LH = (rt, off, rs) => I(0x21, rs, rt, off);
export const LWL = (rt, off, rs) => I(0x22, rs, rt, off);
export const LW = (rt, off, rs) => I(0x23, rs, rt, off);
export const LBU = (rt, off, rs) => I(0x24, rs, rt, off);
export const LHU = (rt, off, rs) => I(0x25, rs, rt, off);
export const LWR = (rt, off, rs) => I(0x26, rs, rt, off);
export const SB = (rt, off, rs) => I(0x28, rs, rt, off);
export const SH = (rt, off, rs) => I(0x29, rs, rt, off);
export const SWL = (rt, off, rs) => I(0x2a, rs, rt, off);
export const SW = (rt, off, rs) => I(0x2b, rs, rt, off);
export const SWR = (rt, off, rs) => I(0x2e, rs, rt, off);
