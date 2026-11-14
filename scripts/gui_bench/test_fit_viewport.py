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
    def test_full_size_png_requires_real_fine_detail_not_just_large_dimensions(self):
        def png(detail, zoom=1):
            width,height=1280,720
            rows=[]
            for y in range(height):
                row=bytearray(bytes([255,255,255])*width)
                for x,cy,c in [(20,20,(255,0,0)),(1260,20,(0,255,0)),(20,700,(0,0,255)),(1260,700,(255,255,0))]:
                    if abs(y-cy)<8:row[(x-8)*3:(x+8)*3]=bytes(c)*16
                if 400<=y<420:row[300*3:320*3]=bytes([255,0,255])*20
                if 280<=y<300:
                    for x in range(300,364):row[x*3:x*3+3]=bytes([255*((x-300)%2) if detail else 127])*3
                rows.append(b'\0'+row)
            if zoom!=1:
                source=rows;rows=[]
                for y in range(height):
                    row=bytearray(b'\xff'*(width*3))
                    if y<round(height*zoom):
                        sy=min(height-1,int(y/zoom))
                        for x in range(round(width*zoom)):
                            sx=min(width-1,int(x/zoom));row[x*3:x*3+3]=source[sy][1+sx*3:1+sx*3+3]
                    rows.append(b'\0'+row)
            return SIGNATURE+chunk(b'IHDR',struct.pack('!IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows)))+chunk(b'IEND',b'')
        row=dict(passed=True,platform='windows',responsive_restored=True,cases=[dict(index=i,preview=dict(width=300,height=200),native_pixels=dict(width=300,height=200),pane=[[426,500],[640,400],[360,500]][i],viewport=dict(width=1280,height=720),image=dict(width=1280,height=720),css_1x=True,detail=dict(x=300,y=290,samples=32),density_marker=dict(x=310,y=410),markers=[dict(x=x,y=y) for x,y in [(20,20),(1260,20),(20,700),(1260,700)]],trusted_corners=True,modal_checkbox=True,stale_frame='denied') for i in range(3)])
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for i in range(3):(root/f'fit-{i}.png').write_bytes(png(True))
            line='FIT_VIEWPORT_EVIDENCE '+json.dumps(row)
            self.assertTrue(verify(line,root)['passed'])
            missing=copy.deepcopy(row);missing['cases'][0].pop('native_pixels')
            with self.assertRaisesRegex(ValueError,'actual native pixel allocation'):verify('FIT_VIEWPORT_EVIDENCE '+json.dumps(missing),root)
            wrong=copy.deepcopy(row);wrong['cases'][0]['native_pixels']['width']=1600
            with self.assertRaisesRegex(ValueError,'capture geometry budget'):verify('FIT_VIEWPORT_EVIDENCE '+json.dumps(wrong),root)
            # Decodable and below the old four-megapixel cap, but not the
            # requested target. The stricter geometry check must reject it.
            oversized=copy.deepcopy(row);oversized['cases'][1]['image']=dict(width=1408,height=792)
            invalid_size=SIGNATURE+chunk(b'IHDR',struct.pack('!IIBBBBB',1408,792,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff'*(1408*3))*792))+chunk(b'IEND',b'')
            (root/'fit-1.png').write_bytes(invalid_size)
            with self.assertRaisesRegex(ValueError,'capture geometry budget'):
                verify('FIT_VIEWPORT_EVIDENCE '+json.dumps(oversized),root)
            (root/'fit-1.png').write_bytes(png(True))
            moved=copy.deepcopy(row);moved['cases'][1]['density_marker']['x']=460
            with self.assertRaisesRegex(ValueError,'resolution-dependent layout'):
                verify('FIT_VIEWPORT_EVIDENCE '+json.dumps(moved),root)
            (root/'fit-1.png').write_bytes(png(True,426/1280))
            with self.assertRaisesRegex(ValueError,'resolution-dependent layout'):verify(line,root)
            (root/'fit-1.png').write_bytes(png(False))
            with self.assertRaisesRegex(ValueError,'thin-line detail'):verify(line,root)

    def test_pixels_geometry_and_effects_are_required(self):
        row=dict(passed=True,platform='linux',responsive_restored=True,cases=[dict(index=i,preview=dict(width=300,height=200),native_pixels=dict(width=300,height=200),pane=[[426,500],[640,400],[360,500]][i],viewport=dict(width=1280,height=720),image=dict(width=2,height=2),css_1x=False,markers=[dict(x=x,y=y) for x,y in [(0,0),(640,0),(0,360),(640,360)]],trusted_corners=True,modal_checkbox=True,stale_frame='denied') for i in range(3)])
        line=lambda r:'FIT_VIEWPORT_EVIDENCE '+json.dumps(r)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for i in range(3): (root/f'fit-{i}.png').write_bytes(fixture_png())
            self.assertTrue(verify(line(row),root)['passed'])
            for platform in ('windows', 'macos', None):
                changed=copy.deepcopy(row);changed['platform']=platform
                with self.subTest(platform=platform),self.assertRaises(ValueError):verify(line(changed),root)
            changed=copy.deepcopy(row);changed['cases'][0]['css_1x']=True
            with self.assertRaises(ValueError):verify(line(changed),root)
            for field,value in [('viewport',dict(width=426,height=720)),('image',dict(width=1280,height=720)),('trusted_corners',False),('trusted_corners','false'),('pane',[1280,720]),('preview',dict(width=1280,height=720)),('modal_checkbox',False),('stale_frame','accepted'),('markers',[dict(x=0,y=0)]*4)]:
                changed=copy.deepcopy(row);changed['cases'][0][field]=value
                with self.subTest(field=field),self.assertRaises(ValueError): verify(line(changed),root)
            with self.assertRaises(ValueError): verify('',root)
            with self.assertRaises(ValueError): verify(line(row)+'\n'+line(row),root)
            (root/'fit-1.png').write_bytes(b'not a screenshot')
            with self.assertRaises(ValueError): verify(line(row),root)


if __name__=='__main__': unittest.main()
