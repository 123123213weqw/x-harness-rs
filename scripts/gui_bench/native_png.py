"""Bounded stdlib PNG evidence reader for disposable native API probes.

Only 8-bit non-interlaced RGB/RGBA is admitted; other encodings are unverified,
not guessed successes. Does not touch a display or call a provider.
"""
import struct
import zlib

MAX_PIXELS = 4_000_000
MAX_BYTES = 8 * 1024 * 1024
SIGNATURE = b'\x89PNG\r\n\x1a\n'


def _row(data, y):
    if len(data) > MAX_BYTES or data[:8] != SIGNATURE:
        raise ValueError('invalid PNG')
    pos, body, header, ended = 8, bytearray(), None, False
    while pos + 12 <= len(data):
        size, = struct.unpack('!I', data[pos:pos+4])
        kind = data[pos+4:pos+8]
        if size > MAX_BYTES or pos + size + 12 > len(data):
            raise ValueError('truncated PNG')
        value = data[pos+8:pos+8+size]
        crc, = struct.unpack('!I', data[pos+8+size:pos+12+size])
        if zlib.crc32(kind + value) & 0xffffffff != crc:
            raise ValueError('bad PNG CRC')
        if header is None and kind != b'IHDR':
            raise ValueError('missing first PNG header')
        if kind == b'IHDR':
            if header is not None or size != 13:
                raise ValueError('invalid PNG header')
            header = struct.unpack('!IIBBBBB', value)
        elif kind == b'IDAT':
            body.extend(value)
        elif kind == b'IEND':
            if size != 0:
                raise ValueError('invalid PNG end')
            ended = True
        elif not kind[0] & 32 and kind != b'PLTE':
            raise ValueError('unsupported critical PNG chunk')
        pos += size + 12
        if ended:
            break
    if header is None or not ended or pos != len(data) or not body:
        raise ValueError('incomplete PNG')
    width, height, depth, color, compression, filtering, interlace = header
    if (not 0 < width * height <= MAX_PIXELS or depth != 8
            or color not in (2, 6) or (compression, filtering, interlace) != (0, 0, 0)):
        raise ValueError('unsupported PNG encoding or dimensions')
    if type(y) is not int or not 0 <= y < height:
        raise ValueError('probe point outside PNG')
    channels = 3 if color == 2 else 4
    stride = width * channels
    limit = (stride + 1) * height
    inflater = zlib.decompressobj()
    raw = inflater.decompress(bytes(body), limit + 1)
    if len(raw) != limit or not inflater.eof or inflater.unused_data:
        raise ValueError('invalid PNG pixel length')
    if any(raw[row*(stride+1)] not in range(5) for row in range(height)):
        raise ValueError('invalid PNG filter')
    previous = bytearray(stride)
    for row in range(y + 1):
        offset = row * (stride + 1)
        mode = raw[offset]
        current = bytearray(raw[offset+1:offset+1+stride])
        if mode == 0:
            previous = current
            continue
        for i in range(stride):
            left = current[i-channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i-channels] if i >= channels else 0
            if mode == 1:
                value = left
            elif mode == 2:
                value = up
            elif mode == 3:
                value = (left + up) // 2
            elif mode == 4:
                prediction = left + up - corner
                dl, du, dc = abs(prediction-left), abs(prediction-up), abs(prediction-corner)
                value = left if dl <= du and dl <= dc else up if du <= dc else corner
            else:
                value = 0
            current[i] = (current[i] + value) & 255
        previous = current
    return previous, channels, (width, height)


def pixel(data, x, y):
    row, channels, size = _row(data, y)
    if type(x) is not int or not 0 <= x < size[0]:
        raise ValueError('probe point outside PNG')
    return tuple(row[x*channels:x*channels+3]), size


def horizontal_contrast(data, xs, y):
    """Read one bounded row once; no unbounded decompressed-image cache."""
    if not isinstance(xs, list) or not 2 <= len(xs) <= 64:
        raise ValueError('invalid detail sample count')
    row, channels, size = _row(data, y)
    if any(type(x) is not int or not 0 <= x < size[0] for x in xs):
        raise ValueError('detail sample outside PNG')
    values = [sum(row[x*channels:x*channels+3])/3 for x in xs]
    return sum(abs(b-a) for a,b in zip(values,values[1:]))/(len(values)-1)
