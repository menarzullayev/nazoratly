/**
 * Minimal QR Code encoder (ISO 18004): byte mode, error correction level M, versions 1..6 (up to 106 bytes). Enough for
 * the student codes (25 bytes). No dependencies, so it runs inside Apps Script. Checked in tests by decoding the result
 * with an independent decoder (jsQR) and by decoding the reference matrices produced by the Python side (reportlab).
 */

/** [blocks, codewords per block, data codewords per block] for level M, index = version - 1. */
const BLOCKS_M: [number, number, number][] = [
  [1, 26, 16],
  [1, 44, 28],
  [1, 70, 44],
  [2, 50, 32],
  [2, 67, 43],
  [4, 43, 27],
];
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];
export const MAX_BYTES = 106;

const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
})();

function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] as number) ^ (poly[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ (poly[j] === 0 ? 0 : (EXP[(LOG[poly[j] as number] as number) + i] as number));
    }
    poly = next;
  }
  return poly; // leading coefficient first, monic
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (rem.shift() as number);
    rem.push(0);
    if (factor !== 0) for (let i = 0; i < degree; i++) rem[i] = (rem[i] as number) ^ (EXP[(LOG[gen[i + 1] as number] as number) + (LOG[factor] as number)] as number);
  }
  return rem;
}

function bch(data: number, poly: number, polyBits: number): number {
  let d = data << (polyBits - 1);
  const top = (v: number): number => 32 - Math.clz32(v);
  while (top(d) >= polyBits) d ^= poly << (top(d) - polyBits);
  return d;
}

function formatBits(mask: number): number {
  const data = (0 << 3) | mask; // level M = 00
  return ((data << 10) | bch(data, 0x537, 11)) ^ 0x5412;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < n; i++) lines.push(m[i] as boolean[], m.map((row) => row[i] as boolean));
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    const s = line.map((b) => (b ? 1 : 0)).join("");
    for (const pat of ["00001011101", "10111010000"]) {
      let at = s.indexOf(pat);
      while (at !== -1) {
        score += 40;
        at = s.indexOf(pat, at + 1);
      }
    }
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r]![c];
    if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
  return score;
}

/** Module matrix (true = dark) for the text, without a quiet zone. Throws when the text is longer than MAX_BYTES. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = utf8(text);
  let version = 0;
  for (let v = 1; v <= BLOCKS_M.length; v++) {
    const [blocks, , data] = BLOCKS_M[v - 1] as [number, number, number];
    if (4 + 8 + bytes.length * 8 <= blocks * data * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error(`QR: text too long (${bytes.length} bytes, max ${MAX_BYTES})`);
  const [blocks, total, dataPer] = BLOCKS_M[version - 1] as [number, number, number];

  // ---- data bits -> codewords
  const bits: number[] = [];
  const put = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  const capacity = blocks * dataPer * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < blocks * dataPer; pad = pad === 0xec ? 0x11 : 0xec) data.push(pad);

  // ---- error correction and interleaving
  const ecLen = total - dataPer;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let b = 0; b < blocks; b++) {
    const chunk = data.slice(b * dataPer, (b + 1) * dataPer);
    dataBlocks.push(chunk);
    ecBlocks.push(rsRemainder(chunk, ecLen));
  }
  const codewords: number[] = [];
  for (let i = 0; i < dataPer; i++) for (const blk of dataBlocks) codewords.push(blk[i] as number);
  for (let i = 0; i < ecLen; i++) for (const blk of ecBlocks) codewords.push(blk[i] as number);

  // ---- function patterns
  const n = version * 4 + 17;
  const mod: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fn: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (r: number, c: number, dark: boolean): void => {
    mod[r]![c] = dark;
    fn[r]![c] = true;
  };
  const finder = (r0: number, c0: number): void => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r < 0 || c < 0 || r >= n || c >= n) continue;
      const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      set(r, c, ring !== 2 && ring !== 4);
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const pos = ALIGN[version - 1] as number[];
  for (const ar of pos) for (const ac of pos) {
    if ((ar === 6 && ac === 6) || (ar === 6 && ac === pos[pos.length - 1]) || (ac === 6 && ar === pos[pos.length - 1])) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // reserve the format areas (filled per mask below) and the dark module
  for (let i = 0; i < 9; i++) {
    fn[8]![i] = true;
    fn[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    fn[8]![n - 1 - i] = true;
    fn[n - 1 - i]![8] = true;
  }
  set(n - 8, 8, true);

  const build = (mask: number): boolean[][] => {
    const m = mod.map((row) => [...row]);
    // data, zig-zag from the bottom right, skipping the vertical timing column
    let bit = 0;
    let up = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < n; k++) {
        const r = up ? n - 1 - k : k;
        for (let c = col; c > col - 2; c--) {
          if (fn[r]![c]) continue;
          const dark = bit < codewords.length * 8 ? ((codewords[bit >> 3] as number) >> (7 - (bit & 7))) & 1 : 0;
          bit++;
          m[r]![c] = dark === 1 !== (MASKS[mask] as (r: number, c: number) => boolean)(r, c);
        }
      }
      up = !up;
    }
    // format information (positions as in the standard)
    const f = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const dark = ((f >> i) & 1) === 1;
      m[i < 6 ? i : i < 8 ? i + 1 : n - 15 + i]![8] = dark;
      m[8]![i < 8 ? n - 1 - i : i < 9 ? 15 - i - 1 + 1 : 15 - i - 1] = dark;
    }
    m[n - 8]![8] = true;
    return m;
  };

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(mask);
    const s = penalty(m);
    if (s < bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return best as boolean[][];
}

/** Inline SVG (black on white, 4-module quiet zone) for printing and for HTML cards. */
export function qrSvg(text: string, pixel = 6): string {
  const m = qrMatrix(text);
  const n = m.length;
  const size = (n + 8) * pixel;
  let d = "";
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!m[r]![c]) {
        c++;
        continue;
      }
      let end = c;
      while (end < n && m[r]![end]) end++;
      d += `M${(c + 4) * pixel} ${(r + 4) * pixel}h${(end - c) * pixel}v${pixel}h-${(end - c) * pixel}z`;
      c = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
