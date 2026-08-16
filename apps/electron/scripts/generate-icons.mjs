#!/usr/bin/env node
/**
 * Generate the desktop shell's icon assets (resources/icon.png, tray.png)
 * as a simple raster: a dark rounded square with a white chevron-like mark.
 * This is a placeholder brand asset until a designer ships the real artwork;
 * the generator keeps packaging self-contained (no image toolchain needed).
 * Run: node apps/electron/scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const ROUND = 96
const MARK = 0.62 // mark inset ratio

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/** Inside the rounded-rect mask? (signed distance to the rounded rect is <= 0) */
function inRoundedRect(x, y) {
  const cx = Math.min(Math.max(x, ROUND), SIZE - ROUND)
  const cy = Math.min(Math.max(y, ROUND), SIZE - ROUND)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= ROUND * ROUND
}

/** Inside the chevron mark? A thick downward chevron centered on the canvas. */
function inMark(x, y) {
  const left = SIZE * (1 - MARK) / 2
  const right = SIZE * (1 + MARK) / 2
  const top = SIZE * 0.30
  const bottom = SIZE * 0.70
  const midX = SIZE / 2
  const half = (right - left) / 2
  const t = (y - top) / (bottom - top)
  if (t < 0 || t > 1) return false
  const halfAt = half * (1 - t * 0.55)
  return Math.abs(x - midX) <= halfAt
}

function render() {
  // RGBA rows, top to bottom; PNG filters: 0 (None) per row.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (SIZE * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < SIZE; x++) {
      const px = rowStart + 1 + x * 4
      if (!inRoundedRect(x + 0.5, y + 0.5)) {
        raw[px] = 0
        raw[px + 1] = 0
        raw[px + 2] = 0
        raw[px + 3] = 0
      } else if (inMark(x + 0.5, y + 0.5)) {
        raw[px] = 255
        raw[px + 1] = 255
        raw[px + 2] = 255
        raw[px + 3] = 255
      } else {
        raw[px] = 22
        raw[px + 1] = 26
        raw[px + 2] = 36
        raw[px + 3] = 255
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return png
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')
mkdirSync(outDir, { recursive: true })
const png = render()
writeFileSync(join(outDir, 'icon.png'), png)
writeFileSync(join(outDir, 'tray.png'), png)
console.log(`generated ${join(outDir, 'icon.png')} and tray.png (${png.length} bytes)`)
