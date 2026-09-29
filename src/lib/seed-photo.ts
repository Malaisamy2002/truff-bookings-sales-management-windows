import { sha256Hex } from "./receipts-share";

// Renders a realistic-looking receipt photo (white slip, dark text rows) as
// a 1-bit grayscale PNG. The previous version tiled each short text line
// across the full width, producing a zebra-stripe "broken image" pattern.
const W = 360,
  H = 240;

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const adler32 = (bytes: Uint8Array) => {
  let a = 1,
    b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};
const u32 = (n: number) =>
  new Uint8Array([
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ]);
const chunk = (type: string, data: Uint8Array) => {
  const t = new TextEncoder().encode(type);
  const all = new Uint8Array(t.length + data.length);
  all.set(t);
  all.set(data, t.length);
  return new Uint8Array([
    ...u32(data.length),
    ...t,
    ...data,
    ...u32(crc32(all)),
  ]);
};

// 5x7 bitmap font, MSB = leftmost column. Uppercase only.
const FONT: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  "-": [0, 0, 0, 0x1f, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ":": [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  "/": [0x02, 0x02, 0x04, 0x08, 0x10, 0x10, 0],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "&": [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
};

const makeCanvas = (): Uint8Array => new Uint8Array(H * (W / 8));
const setPx = (img: Uint8Array, x: number, y: number) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = y * (W / 8) + (x >> 3);
  img[i] = img[i]! | (1 << (7 - (x & 7)));
};
const textW = (s: string) => s.length * 6 - 1;
const drawText = (img: Uint8Array, x: number, y: number, s: string) => {
  let cx = x;
  for (const raw of s.toUpperCase()) {
    const g = FONT[raw] ?? FONT[" "]!;
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++)
        if ((g[r]! >> (4 - c)) & 1) setPx(img, cx + c, y + r);
    cx += 6;
  }
};
const drawCentered = (img: Uint8Array, y: number, s: string) =>
  drawText(img, Math.max(0, Math.floor((W - textW(s)) / 2)), y, s);
const drawRule = (img: Uint8Array, y: number) => {
  for (let x = 12; x < W - 12; x += 4) {
    setPx(img, x, y);
    setPx(img, x, y + 1);
  }
};

function pngBytes(img: Uint8Array): Uint8Array {
  const raw = new Uint8Array(H * (1 + W / 8));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W / 8)] = 0;
    raw.set(img.subarray(y * (W / 8), (y + 1) * (W / 8)), y * (1 + W / 8) + 1);
  }
  const blocks: number[] = [];
  let off = 0;
  while (off < raw.length) {
    const len = Math.min(65535, raw.length - off);
    blocks.push(
      off + len === raw.length ? 1 : 0,
      len & 255,
      (len >>> 8) & 255,
      ~len & 255,
      (~len >>> 8) & 255,
    );
    for (let i = 0; i < len; i++) blocks.push(raw[off + i]!);
    off += len;
  }
  const z = new Uint8Array([0x78, 0x01, ...blocks, ...u32(adler32(raw))]);
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, W);
  new DataView(ihdr.buffer).setUint32(4, H);
  ihdr[8] = 1;
  ihdr[9] = 0;
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", z),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

export function renderReceiptPhoto(input: {
  description?: string | null | undefined;
  date?: string | undefined;
  mode?: string | null | undefined;
  amount?: number | undefined;
}): Uint8Array {
  const img = makeCanvas();
  drawCentered(img, 12, "TRUFF SNACKS");
  drawCentered(img, 22, "RECEIPT");
  drawRule(img, 36);
  drawText(img, 16, 50, `DATE ${(input.date ?? "").slice(0, 10)}`);
  drawText(img, 16, 68, `AMOUNT RS ${input.amount ?? 0}`);
  drawText(img, 16, 86, `MODE ${(input.mode ?? "CASH").toUpperCase()}`);
  drawRule(img, 102);
  const desc = (input.description ?? "RECEIPT").toUpperCase();
  let y = 118;
  for (let i = 0; i < desc.length && y < H - 30; i += 30) {
    drawText(img, 16, y, desc.slice(i, i + 30));
    y += 18;
  }
  drawCentered(img, H - 22, "THANK YOU");
  return pngBytes(img);
}

export async function makeReceiptRows(expense: {
  id: string;
  spent_at: string;
  created_at: string;
  description?: string | null;
  amount?: number;
  payment_mode?: string | null;
}) {
  const bytes = renderReceiptPhoto({
    description: expense.description,
    date: expense.spent_at,
    mode: expense.payment_mode,
    amount: expense.amount,
  });
  const path = `Receipts/${expense.spent_at}/lt-${expense.id}.png`;
  return {
    path,
    blob: new Blob([bytes as BlobPart], { type: "image/png" }),
    hash: {
      path,
      sha256: await sha256Hex(bytes),
      created_at: expense.created_at,
    },
    bytes,
  };
}
