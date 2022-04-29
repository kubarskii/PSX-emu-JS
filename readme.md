# PSX JavaScript Emulator

## Installation

### Install Node.js dependencies

```npm i```

### Run dev-server

```npm start```

## Development

If you want to commit to the repository, please run linter first and cover code with tests.

### CPU Registers

PSX uses 32bit wide registers, they are the following

| Name    | Alias  | Common Usage                                                                                   |
|---------|--------|------------------------------------------------------------------------------------------------|
| (R0)    | zero   | Constant (always 0) (this one isn't a real register)                                           |
| R1      | at     | Assembler temporary (destroyed by some pseudo opcodes!)                                        |
| R2-R3   | v0-v1  | Subroutine return values, may be changed by subroutines                                        |
| R4-R7   | a0-a3  | Subroutine arguments, may be changed by subroutines                                            |
| R8-R15  | t0-t7  | Temporaries, may be changed by subroutines                                                     |
| R16-R23 | s0-s7  | Static variables, must be saved by subs                                                        |
| R24-R25 | t8-t9  | Temporaries, may be changed by subroutines                                                     |
| R26-R27 | k0-k1  | Reserved for kernel (destroyed by some IRQ handlers!)                                          |
| R28     | gp     | Global pointer (rarely used)                                                                   |
| R29     | sp     | Stack pointer                                                                                  |
| R30     | fp(s8) | Frame Pointer, or 9th Static variable, must be saved                                           |
| R31     | ra     | Return address (used so by JAL,BLTZAL,BGEZAL opcodes), can be used as general purpose register |
| -       | pc     | Program counter                                                                                |
| -       | hi,lo  | Multiply/divide results, may be changed by subroutines                                         |


### Memory map

Memory map: https://psx-spx.consoledev.net/memorymap/

| KUSEG (Virtual) | KSEG0 (Physical Mirror with Cache) | KSEG1 (Physical) | Memory size | Type                                                |
|-----------------|------------------------------------|------------------|-------------|-----------------------------------------------------|
| 00000000h       | 80000000h                          | A0000000h        | 2048K       | Main RAM (first 64K reserved for BIOS)              |          
| 1F000000h       | 9F000000h                          | BF000000h        | 8192K       | Expansion Region 1 (ROM/RAM)                        |
| 1F800000h       | 9F800000h                          | --               | 1K          | Scratchpad (D-Cache used as Fast RAM)               |
| 1F801000h       | 9F801000h                          | BF801000h        | 8K          | I/O Ports                                           |                                                    
| 1F802000h       | 9F802000h                          | BF802000h        | 8K          | Expansion Region 2 (I/O Ports)                      |       
| 1FA00000h       | 9FA00000h                          | BFA00000h        | 2048K       | Expansion Region 3 (SRAM BIOS region for DTL cards) | 
| 1FC00000h       | 9FC00000h                          | BFC00000h        | 512K        | BIOS ROM (Kernel) (4096K max)                       |


| KSEG2     | Size |                                                |
|-----------|------|------------------------------------------------|
| FFFE0000h | 0.5K | Internal CPU control registers (Cache Control) |

