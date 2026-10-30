"""Decodes the QR codes produced by test/qr-matrix.mjs with zxing-cpp."""
import json
import subprocess
import sys

import numpy as np
import zxingcpp

samples = json.loads(subprocess.check_output(["node", "test/qr-matrix.mjs"]))
for s in samples:
    m = np.array(s["matrix"], dtype=np.uint8)
    m = np.pad(m, 4)
    img = np.kron(1 - m, np.ones((8, 8), dtype=np.uint8)) * 255
    results = zxingcpp.read_barcodes(img)
    texts = [r.text for r in results]
    if s["text"] not in texts:
        sys.exit(f"QR for {s['text']!r} decoded as {texts}")
    print("ok -", s["text"], f"(version {(len(s['matrix']) - 17) // 4})")
