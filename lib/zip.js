/**
 * Writes a zip file, with no dependency and nothing to install.
 *
 * Entries are stored rather than compressed. Compression would need DEFLATE,
 * which is a library or a `CompressionStream` that not every WebView has, and
 * what goes in a backup is mostly JPEG, PNG and PDF - already compressed, so
 * there is next to nothing to win. What matters is that the result is a real
 * zip: double-click it on any computer and the notes are there as files.
 *
 * ZIP32, so an archive has to stay under 4GB. A note library that big is not a
 * thing that exists.
 */

const encoder = new TextEncoder();

/* The standard CRC-32 table, built once. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is what a zip entry carries. */
function dosStamp(date) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

class Writer {
  constructor(size) {
    this.bytes = new Uint8Array(size);
    this.at = 0;
  }

  u16(v) {
    this.bytes[this.at] = v & 0xff;
    this.bytes[this.at + 1] = (v >>> 8) & 0xff;
    this.at += 2;
  }

  u32(v) {
    this.bytes[this.at] = v & 0xff;
    this.bytes[this.at + 1] = (v >>> 8) & 0xff;
    this.bytes[this.at + 2] = (v >>> 16) & 0xff;
    this.bytes[this.at + 3] = (v >>> 24) & 0xff;
    this.at += 4;
  }

  raw(data) {
    this.bytes.set(data, this.at);
    this.at += data.length;
  }
}

/**
 * Builds the archive. [files] is [{ name, data }], where data is a string, a
 * Uint8Array, an ArrayBuffer or a Blob. Names may contain slashes, which is
 * what makes folders inside the zip.
 */
export async function zip(files, when = new Date()) {
  const entries = [];
  for (const file of files) {
    let data = file.data;
    if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
    else if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    else if (typeof data === 'string') data = encoder.encode(data);
    entries.push({ name: encoder.encode(file.name), data, crc: crc32(data) });
  }

  const { time, day } = dosStamp(when);
  let size = 0;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  size += 22;

  const w = new Writer(size);
  for (const e of entries) {
    e.offset = w.at;
    w.u32(0x04034b50);          // local file header
    w.u16(20);                  // version needed
    w.u16(0x0800);              // names are UTF-8
    w.u16(0);                   // stored, not compressed
    w.u16(time);
    w.u16(day);
    w.u32(e.crc);
    w.u32(e.data.length);
    w.u32(e.data.length);
    w.u16(e.name.length);
    w.u16(0);
    w.raw(e.name);
    w.raw(e.data);
  }

  const dirAt = w.at;
  for (const e of entries) {
    w.u32(0x02014b50);          // central directory entry
    w.u16(20);
    w.u16(20);
    w.u16(0x0800);
    w.u16(0);
    w.u16(time);
    w.u16(day);
    w.u32(e.crc);
    w.u32(e.data.length);
    w.u32(e.data.length);
    w.u16(e.name.length);
    w.u16(0);
    w.u16(0);
    w.u16(0);
    w.u16(0);
    w.u32(0);
    w.u32(e.offset);
    w.raw(e.name);
  }

  w.u32(0x06054b50);            // end of central directory
  w.u16(0);
  w.u16(0);
  w.u16(entries.length);
  w.u16(entries.length);
  w.u32(w.at - dirAt);
  w.u32(dirAt);
  w.u16(0);

  return new Blob([w.bytes.subarray(0, w.at)], { type: 'application/zip' });
}

/**
 * Reads a stored zip back. Returns a Map of name to Uint8Array. Only the stored
 * method is understood, which is all this app writes; a compressed entry from
 * somewhere else is reported rather than quietly skipped.
 */
export async function unzip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();

  // The end-of-directory record is last, after a comment of unknown length.
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('That is not a zip file');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('This zip file is damaged');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (method !== 0) throw new Error(`"${name}" is compressed, which this cannot read`);

    const localNameLen = view.getUint16(offset + 26, true);
    const localExtraLen = view.getUint16(offset + 28, true);
    const start = offset + 30 + localNameLen + localExtraLen;
    out.set(name, bytes.subarray(start, start + size));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
