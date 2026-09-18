"""Generate original SFNT fixtures using only Python's standard library.

Glyphs are simple rectangles; the variable fixture tests coordinate selection,
not outline interpolation. The GSUB fi ligature checks that restricted nominal
mapping preserves substitutions and original glyph identities.
"""
from pathlib import Path
import struct

HERE = Path(__file__).resolve().parent

def u16(*values): return struct.pack('>' + 'H' * len(values), *values)
def i16(*values): return struct.pack('>' + 'h' * len(values), *values)
def u32(*values): return struct.pack('>' + 'I' * len(values), *values)
def fixed(value): return struct.pack('>i', round(value * 65536))
def pad(data): return data + bytes((-len(data)) % 4)
def checksum(data): return sum(struct.unpack('>' + 'I' * (len(pad(data)) // 4), pad(data))) & 0xFFFFFFFF

# Codepoint -> glyph ID. fi is a real GSUB result, not text rewritten by a host.
CMAP = {0x20: 1, 0x41: 2, 0x42: 3, 0x65: 4, 0x66: 5, 0x69: 6,
        0xE9: 7, 0x301: 8, 0x391: 9, 0x3A9: 10, 0xFB01: 11,
        0x1F600: 12}
COUNT = 13

def names(family):
    values = [(1, family), (2, 'Regular'), (4, family + ' Regular'),
              (6, family.replace(' ', '') + '-Regular'),
              (256,'Weight'),(257,'Width'),(258,'Slant'),(259,'Italic')]
    data = b''
    records = b''
    for key, value in values:
        encoded = value.encode('utf-16-be')
        records += u16(3, 1, 0x409, key, len(encoded), len(data))
        data += encoded
    return u16(0, len(values), 6 + 12 * len(values)) + records + data

def make(family, advance, variable=False):
    # Each contour has four on-curve points. Empty space has no outline.
    glyph = i16(1, 0, 0, 400, 700) + u16(3, 0) + bytes([1] * 4)
    glyph += i16(0, 400, 0, -400) + i16(0, 0, 700, 0)
    glyph = pad(glyph)
    glyf = b''
    offsets = []
    for index in range(COUNT):
        offsets.append(len(glyf))
        if index != 1: glyf += glyph
    offsets.append(len(glyf))
    head = u32(0x10000, 0x10000, 0, 0x5F0F3CF5) + u16(0, 1000)
    head += bytes(16) + i16(0, 0, 400, 700) + u16(0, 8) + i16(2, 1, 0)
    hhea = u32(0x10000) + i16(800, -200, 0) + u16(advance)
    hhea += i16(0, 0, 400, 1, 0, 0) + bytes(8) + i16(0) + u16(COUNT)
    maxp = u32(0x10000) + u16(COUNT, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)
    hmtx = b''.join(u16(advance if i != 11 else advance * 2 - 100) + i16(0) for i in range(COUNT))
    groups = b''.join(u32(c, c, gid) for c, gid in sorted(CMAP.items()))
    cmap12 = u16(12, 0) + u32(16 + len(groups), 0, len(CMAP)) + groups
    # Original UVS mapping lets the shaping test distinguish variation callback
    # restrictions from nominal-cmap filtering alone.
    cmap14 = u16(14) + u32(30, 1) + bytes([0, 0xFE, 0x0F]) + u32(0, 21)
    cmap14 += u32(1) + bytes([0, 0, 0x41]) + u16(12)
    cmap = u16(0, 2, 0, 5) + u32(20 + len(cmap12)) + u16(3, 10) + u32(20) + cmap12 + cmap14
    os2 = u16(0) + i16(advance) + u16(400, 5, 0) + bytes(20)
    os2 += i16(0) + bytes(10) + u32(0, 0, 0, 0) + b'3JSN'
    os2 += u16(0x40, 0x20, 0xFFFF) + i16(800, -200, 0) + u16(800, 200)
    # Lookup type 4, ligature f+i -> gid11. DFLT script enables liga.
    coverage = u16(1, 1, 5)
    ligature_set = u16(1, 4, 11, 2, 6)
    subtable = u16(1, 8 + len(ligature_set), 1, 8) + ligature_set + coverage
    lookup = u16(4, 0, 1, 8) + subtable
    lookup_list = u16(1, 4) + lookup
    feature_list = u16(1) + b'liga' + u16(8) + u16(0, 1, 0)
    script_list = u16(1) + b'DFLT' + u16(8) + u16(4, 0) + u16(0, 0xFFFF, 1, 0)
    gsub = u32(0x10000) + u16(10, 10+len(script_list), 10+len(script_list)+len(feature_list))
    gsub += script_list + feature_list + lookup_list
    tables = {'head':head, 'hhea':hhea, 'maxp':maxp, 'hmtx':hmtx,
              'cmap':cmap, 'name':names(family), 'OS/2':os2,
              'post':u32(0x30000)+bytes(28), 'glyf':glyf,
              'loca':u32(*offsets), 'GSUB':gsub}
    if variable:
        axes = [(b'wght',100,400,900), (b'wdth',50,100,200),
                (b'slnt',-90,0,90), (b'ital',0,0,1)]
        tables['fvar'] = u16(1,0,16,2,len(axes),20,0,4+4*len(axes))
        for index,(tag,minimum,default,maximum) in enumerate(axes):
            tables['fvar'] += tag+fixed(minimum)+fixed(default)+fixed(maximum)+u16(0,256+index)
    count = len(tables)
    power = 1 << (count.bit_length()-1)
    header = u32(0x10000)+u16(count,power*16,power.bit_length()-1,count*16-power*16)
    offset = 12+16*count
    directory = b''
    payload = b''
    offsets = {}
    for tag,data in sorted(tables.items()):
        offsets[tag] = offset
        directory += tag.encode('ascii') + u32(checksum(data),offset,len(data))
        payload += pad(data)
        offset += len(pad(data))
    result = bytearray(header+directory+payload)
    struct.pack_into('>I',result,offsets['head']+8,(0xB1B0AFBA-checksum(result)) & 0xFFFFFFFF)
    return bytes(result)

if __name__ == '__main__':
    for name, advance, variable in [('narrow',500,False),('wide',800,False),('variable',600,True)]:
        (HERE/(name+'.ttf')).write_bytes(make('3JSN '+name,advance,variable))
