"""Realign a Mach-O dylib's LINKEDIT string table so dyld accepts it.

Xcode 27's linker (ld-27037) writes libgpuix_native's string table at an offset
that is not 8-byte aligned; dyld then refuses the library ("mis-aligned
LINKEDIT string pool"). When the string table is the last LINKEDIT blob before
the code signature and the padding in between has room, moving it forward to
the next 8-byte boundary and updating LC_SYMTAB.stroff is enough. The caller
re-signs the file afterwards (the old signature covered the old bytes).

Refuses (exit 1) anything it does not fully understand instead of guessing.

    python3 align_strtab.py <dylib>
"""
import struct
import sys

MH_MAGIC_64 = 0xFEEDFACF
LC_SYMTAB = 0x2
LC_CODE_SIGNATURE = 0x1D
LC_SEGMENT_64 = 0x19


def main(path: str) -> int:
    data = bytearray(open(path, "rb").read())
    magic, _, _, _, ncmds, _, _, _ = struct.unpack_from("<IiiIIIII", data, 0)
    if magic != MH_MAGIC_64:
        print("not a 64-bit Mach-O")
        return 1
    off = 32
    symtab_at = None
    stroff = strsize = 0
    sig_off = None
    linkedit_end = None
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", data, off)
        if cmd == LC_SYMTAB:
            symtab_at = off
            _, _, _, _, stroff, strsize = struct.unpack_from("<IIIIII", data, off)
        elif cmd == LC_CODE_SIGNATURE:
            sig_off = struct.unpack_from("<IIII", data, off)[2]
        elif cmd == LC_SEGMENT_64:
            name = data[off + 8 : off + 24].rstrip(b"\0")
            if name == b"__LINKEDIT":
                fileoff, filesize = struct.unpack_from("<QQ", data, off + 40)
                linkedit_end = fileoff + filesize
        off += cmdsize
    if symtab_at is None or linkedit_end is None:
        print("no LC_SYMTAB or __LINKEDIT")
        return 1
    pad = (-stroff) % 8
    if pad == 0:
        print(f"string table already aligned (stroff={stroff})")
        return 0
    limit = sig_off if sig_off is not None else linkedit_end
    if stroff + strsize > limit or stroff + strsize + pad > limit:
        print(f"no room: strtab ends {stroff + strsize}, +{pad} pad, next blob at {limit}")
        return 1
    table = bytes(data[stroff : stroff + strsize])
    data[stroff : stroff + pad] = b"\0" * pad
    data[stroff + pad : stroff + pad + strsize] = table
    struct.pack_into("<I", data, symtab_at + 16, stroff + pad)
    open(path, "wb").write(data)
    print(f"string table moved {stroff} -> {stroff + pad}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
