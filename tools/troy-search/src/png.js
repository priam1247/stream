// a page of writing costs hundreds of bytes per row of png; a sheet with nothing
// drawn on it costs a handful. Same rule the download panel uses.
export const BLANK_BYTES_PER_ROW = 12;

/** The size a png claims, read out of its header — no decoding, no library. */
export function pngSize(buffer) {
  const png = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 };
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Did the browser hand back an empty white sheet? */
export function blankShot(buffer) {
  const size = pngSize(buffer);
  const bytes = Buffer.isBuffer(buffer) ? buffer.length : (buffer || []).length;
  if (!(size.width > 0) || !(size.height > 0)) return false;  // cannot judge: keep it
  return bytes / size.height < BLANK_BYTES_PER_ROW;
}
