#!/usr/bin/env python3
"""Offline guards: no SSH, VM effects, credentials or model calls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import hashlib
spec=importlib.util.spec_from_file_location("native_acceptance",Path(__file__).with_name("cloud-native-acceptance.py"))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Guards(unittest.TestCase):
    def test_wire_counter_is_canonical_bounded_decimal_string(self):
        for value in ["0","1",str(2**64-1)]:self.assertEqual(module.counter(value),int(value))
    def test_lossy_or_noncanonical_counters_are_rejected(self):
        for value in [0,1,1.0,None,True,"","01","-1","1.1","１",str(2**64),"1\n"]:
            with self.subTest(value=value),self.assertRaises(RuntimeError):module.counter(value)
    def test_artifact_digest_is_streamed_and_matches_sha256(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/"fixture";path.write_bytes(b"bounded native fixture")
            self.assertEqual(module.digest(path),hashlib.sha256(path.read_bytes()).hexdigest())
if __name__=="__main__":unittest.main()
