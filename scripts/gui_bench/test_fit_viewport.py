"""The acceptance checker must reject claimed success with wrong/cropped pixels."""
import copy
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib
from scripts.gui_bench.check_fit_viewport import verify
from scripts.gui_bench.test_native_png import chunk
from scripts.gui_bench.native_png import SIGNATURE


def fixture_png():
    colors=[(255,0,0),(0,255,0),(0,0,255),(255,255,0)]
    return (SIGNATURE+chunk(b'IHDR',struct.pack('!IIBBBBB',2,2,8,2,0,0,0))
            +chunk(b'IDAT',zlib.compress(b'\0'+bytes(colors[0]+colors[1])+b'\0'+bytes(colors[2]+colors[3])))+chunk(b'IEND',b''))


class FitViewportTests(unittest.TestCase):
    def test_pixels_geometry_and_effects_are_required(self):
        row=dict(passed=True,responsive_restored=True,cases=[dict(index=i,preview=dict(width=300,height=200),pane=[[426,500],[640,400],[360,500]][i],viewport=dict(width=1280,height=720),image=dict(width=2,height=2),markers=[dict(x=x,y=y) for x,y in [(0,0),(640,0),(0,360),(640,360)]],trusted_corners=True,modal_checkbox=True,stale_frame='denied') for i in range(3)])
        line=lambda r:'FIT_VIEWPORT_EVIDENCE '+json.dumps(r)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for i in range(3): (root/f'fit-{i}.png').write_bytes(fixture_png())
            self.assertTrue(verify(line(row),root)['passed'])
            for field,value in [('viewport',dict(width=426,height=720)),('image',dict(width=1280,height=720)),('trusted_corners',False),('trusted_corners','false'),('pane',[1280,720]),('preview',dict(width=1280,height=720)),('modal_checkbox',False),('stale_frame','accepted'),('markers',[dict(x=0,y=0)]*4)]:
                changed=copy.deepcopy(row);changed['cases'][0][field]=value
                with self.subTest(field=field),self.assertRaises(ValueError): verify(line(changed),root)
            with self.assertRaises(ValueError): verify('',root)
            with self.assertRaises(ValueError): verify(line(row)+'\n'+line(row),root)
            (root/'fit-1.png').write_bytes(b'not a screenshot')
            with self.assertRaises(ValueError): verify(line(row),root)


if __name__=='__main__': unittest.main()
