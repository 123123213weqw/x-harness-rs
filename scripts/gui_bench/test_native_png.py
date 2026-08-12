import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

from scripts.gui_bench.native_png import pixel, SIGNATURE, MAX_PIXELS
from scripts.gui_bench.run_native_probe import native_api_evidence


def chunk(kind, value):
    return struct.pack('!I', len(value)) + kind + value + struct.pack('!I', zlib.crc32(kind+value))


def png(color=(255, 0, 0), mode=0, rgba=False, size=(2, 2)):
    w, h = size
    channels = 4 if rgba else 3
    original = bytes(color) + (b'\xff' if rgba else b'')
    previous = bytes(w*channels)
    rows = []
    for _ in range(h):
        row = original*w
        filtered = []
        for i, value in enumerate(row):
            left = row[i-channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i-channels] if i >= channels else 0
            p = left+up-corner
            dl, du, dc = abs(p-left), abs(p-up), abs(p-corner)
            predictor = [0, left, up, (left+up)//2, left if dl<=du and dl<=dc else up if du<=dc else corner][mode]
            filtered.append((value-predictor)&255)
        rows.append(bytes([mode])+bytes(filtered))
        previous = row
    return (SIGNATURE + chunk(b'IHDR', struct.pack('!IIBBBBB', w,h,8,6 if rgba else 2,0,0,0))
            + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))


class PngTests(unittest.TestCase):
    def test_rgb_rgba_and_all_filters(self):
        for rgba in [False, True]:
            for mode in range(5):
                with self.subTest(rgba=rgba, mode=mode):
                    self.assertEqual(pixel(png((5,130,255),mode,rgba),1,1),((5,130,255),(2,2)))

    def test_crc_truncation_missing_end_duplicate_header_and_trailing_data(self):
        good = png()
        cases = [good[:-1], good[:-12], good+b'junk', good[:30]+b'\xff'+good[31:],
                 SIGNATURE+chunk(b'IHDR',struct.pack('!IIBBBBB',2,2,8,2,0,0,0))+good[8:],
                 SIGNATURE+chunk(b'IDAT',b'x')+good[8:]]
        for data in cases:
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                pixel(data,0,0)

    def test_dimensions_bounds_and_decompression_are_bounded(self):
        header = chunk(b'IHDR',struct.pack('!IIBBBBB',MAX_PIXELS+1,1,8,2,0,0,0))
        for data,x,y in [(png(),2,0),(png(),0,-1),(png(),True,0),
                         (SIGNATURE+header+chunk(b'IDAT',b'0')+chunk(b'IEND',b''),0,0)]:
            with self.assertRaises(ValueError): pixel(data,x,y)
        for raw in [b'\0'*100,b'\x05'+b'\0'*6,b'\0'*6]:
            data = (SIGNATURE+chunk(b'IHDR',struct.pack('!IIBBBBB',2,1,8,2,0,0,0))
                    +chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))
            with self.assertRaises(ValueError): pixel(data,0,0)

    def test_native_evidence_verifies_pixels_not_merely_callback_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'native-api').mkdir()
            # Native marker point (60,160); avoid megabyte fake assets.
            shots=[]
            for i, color in enumerate([(255,0,0),(0,255,0),(0,0,255)]):
                (root/'native-api'/f'snapshot-{i}.png').write_bytes(png(color,size=(61,161)))
                shots.append(dict(index=i,status='captured',width=61,height=161))
            result=dict(test_only=True,production_enabled=False,screenshots=shots,observed=dict(dpr=1))
            line='NATIVE_API_EVIDENCE '+json.dumps(result)
            self.assertTrue(native_api_evidence(line,root)['snapshot_sequence_verified'])
            (root/'native-api'/'snapshot-1.png').write_bytes(png((255,0,0),size=(61,161)))
            self.assertFalse(native_api_evidence(line,root)['snapshot_sequence_verified'])
            self.assertEqual(native_api_evidence(line+'\n'+line,root)['status'],'unverified')
            result['production_enabled']=True
            self.assertEqual(native_api_evidence('NATIVE_API_EVIDENCE '+json.dumps(result),root)['status'],'unverified')


if __name__ == '__main__': unittest.main()
