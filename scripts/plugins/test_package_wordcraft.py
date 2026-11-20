"""Offline source-binding negatives. Full pinned repack is an explicit acceptance step."""
import importlib.util,pathlib,tempfile,unittest,zipfile
spec=importlib.util.spec_from_file_location('package_wordcraft',pathlib.Path(__file__).with_name('package-wordcraft.py'))
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
class PinnedPackageTests(unittest.TestCase):
 def test_unreviewed_inputs_never_create_or_overwrite_output(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);out=root/'release.zip';out.write_bytes(b'original')
   for data in [b'',b'not a zip',b'PK\x03\x04forged']:
    source=root/'source.zip';source.write_bytes(data)
    with self.assertRaisesRegex(ValueError,'Unreviewed upstream archive'):builder.package(source,out)
    self.assertEqual(out.read_bytes(),b'original')
 def test_zip_layout_cannot_bypass_whole_archive_binding(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);source=root/'source.zip'
   with zipfile.ZipFile(source,'w') as z:z.writestr('wordcraft/dist/BUILD.json','{}');z.writestr('../escape','bad')
   with self.assertRaises(ValueError):builder.package(source,root/'out.zip')
   self.assertFalse((root/'out.zip').exists());self.assertFalse((root.parent/'escape').exists())
if __name__=='__main__':unittest.main()
