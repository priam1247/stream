'use strict';
/**
 * JPEG page screenshots → one clean PDF, plus the blank-page check.
 *
 * Pages are placed at the screenshot's own pixel size at 96 DPI (the same
 * layout the Python panel used), so nothing is stretched or cropped.
 */

const fs = require('fs');
const jpeg = require('jpeg-js');
const { PDFDocument } = require('pdf-lib');

const DPI = 96;

function readJpeg(file) {
  return jpeg.decode(fs.readFileSync(file), { maxMemoryUsageInMB: 512, tolerantDecoding: true });
}

/** Width and height in pixels. */
function dimensions(file) {
  const image = readJpeg(file);
  return { width: image.width, height: image.height };
}

/**
 * A cheap pixel check: mostly-white (or mostly-black) sheets with no detail
 * are blanks, and a blank page never enters the PDF.
 */
function isBlank(file) {
  let image;
  try {
    image = readJpeg(file);
  } catch {
    return false; // undecodable: let the PDF step decide
  }
  const { width, height, data } = image;
  if (!width || !height) return true;

  // Sample down to roughly 256px on the long edge, like the Python version.
  const step = Math.max(1, Math.floor(Math.max(width, height) / 256));
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  let nonWhite = 0;
  let dark = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      const gray = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      count += 1;
      sum += gray;
      sumSquares += gray * gray;
      if (gray < 245) nonWhite += 1;
      if (gray < 32) dark += 1;
    }
  }
  if (!count) return true;

  const mean = sum / count;
  const variance = Math.max(0, sumSquares / count - mean * mean);
  const stddev = Math.sqrt(variance);

  if (stddev < 1.2 && (mean > 248 || mean < 8)) return true;
  if (nonWhite / count < 0.00035 && dark / count < 0.0001) return true;
  return false;
}

/** Compile the screenshots into `output` and verify the page count. */
async function buildPdf(images, output, expected) {
  if (images.length !== expected) {
    throw new Error(`Expected ${expected} screenshots, got ${images.length}.`);
  }
  const pdf = await PDFDocument.create();
  pdf.setProducer('Scribd screenshot panel');
  pdf.setCreator('Scribd screenshot panel');

  for (const file of images) {
    const bytes = fs.readFileSync(file);
    const image = await pdf.embedJpg(bytes);
    const widthPt = (image.width * 72) / DPI;
    const heightPt = (image.height * 72) / DPI;
    if (!(widthPt > 0) || !(heightPt > 0)) {
      throw new Error('A screenshot had an empty page box.');
    }
    const page = pdf.addPage([widthPt, heightPt]);
    page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
  }

  const temporary = output.replace(/\.pdf$/i, '') + '.part.pdf';
  fs.writeFileSync(temporary, await pdf.save());

  // Re-open it: a page that did not survive is worse than no PDF at all.
  const check = await PDFDocument.load(fs.readFileSync(temporary), { ignoreEncryption: false });
  if (check.getPageCount() !== expected) {
    fs.unlinkSync(temporary);
    throw new Error(`The generated PDF had ${check.getPageCount()} pages, expected ${expected}.`);
  }
  fs.renameSync(temporary, output);
  return fs.statSync(output).size;
}

module.exports = { buildPdf, isBlank, dimensions, DPI };
