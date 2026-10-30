// Prints QR matrices as JSON for test/qr_decode.py (run in CI, which can
// install a real QR decoder).
import { qrMatrix } from '../public/js/qr.mjs';

const samples = [
  'http://192.168.1.23:8642/',
  'http://10.0.0.5:8642/',
  'http://172.20.10.1:8642/',
  'https://example.com/a/fairly/long/path/that/needs/a/bigger/qr/version?x=1234567890',
];
console.log(JSON.stringify(samples.map((text) => ({ text, matrix: qrMatrix(text).map((r) => r.map(Number)) }))));
