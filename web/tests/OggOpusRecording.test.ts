import { describe, expect, it } from 'vitest';
import { OggOpusRecording } from '../src/audio/OggOpusRecording';

function readPages(data: Uint8Array) {
  const pages = [];
  let offset = 0;
  while (offset < data.length) {
    const view = new DataView(data.buffer, data.byteOffset + offset);
    expect(String.fromCharCode(...data.subarray(offset, offset + 4))).toBe('OggS');
    const lacing = data.subarray(offset + 27, offset + 27 + data[offset + 26]);
    const headerSize = 27 + lacing.length;
    const size = headerSize + lacing.reduce((sum, value) => sum + value, 0);
    const page = data.slice(offset, offset + size);
    const checksum = view.getUint32(22, true);
    page.fill(0, 22, 26);
    // Validate the container checksum independently, bit by bit.
    let crc = 0;
    for (const byte of page) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
    expect(crc >>> 0).toBe(checksum);
    pages.push({ flags: view.getUint8(5), granule: Number(view.getBigUint64(6, true)), serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true), lacing: [...lacing], packet: data.slice(offset + headerSize, offset + size) });
    offset += size;
  }
  expect(offset).toBe(data.length);
  return pages;
}

describe('SDK Opus recording export', () => {
  it('exports mono Ogg headers, immutable packets, 48 kHz granules and an end marker', () => {
    const recording = new OggOpusRecording();
    const payload = new Uint8Array([0xf8, 0xff, 0xfe]);
    recording.append({ data: { microphone: payload }, sampleCount: 320, sampleRate: 16_000 });
    payload.fill(0);
    recording.append({ data: { microphone: new Uint8Array([0xf8, 0xff, 0xfe]) }, sampleCount: 320, sampleRate: 16_000, validSampleCount: 160 });
    const file = recording.getFile();
    expect(file.fileName).toMatch(/^tellus-recording-[A-Za-z0-9-]+\.ogg$/);
    const pages = readPages(file.data);
    expect(pages.map((page) => [page.flags, page.granule, page.sequence])).toEqual([[2, 0, 0], [0, 0, 1], [0, 960, 2], [4, 1440, 3]]);
    expect(String.fromCharCode(...pages[0].packet.subarray(0, 8))).toBe('OpusHead');
    expect(pages[0].packet[9]).toBe(1);
    expect(new DataView(pages[0].packet.buffer).getUint32(12, true)).toBe(16_000);
    expect(String.fromCharCode(...pages[1].packet.subarray(0, 8))).toBe('OpusTags');
    expect([...pages[2].packet]).toEqual([0xf8, 0xff, 0xfe]);
  });

  it('terminates packets whose size is an exact multiple of 255', () => {
    const recording = new OggOpusRecording();
    recording.append({ data: { microphone: new Uint8Array(510) }, sampleCount: 320 });
    const last = readPages(recording.getFile().data).at(-1)!;
    expect(last.lacing).toEqual([255, 255, 0]);
    expect(last.packet.length).toBe(510);
  });

  it('chains streams after an SDK encoder restart without losing earlier audio', () => {
    const recording = new OggOpusRecording();
    for (const sequence of [0, 1, 0, 1]) {
      recording.append({ data: { microphone: new Uint8Array([0xf8, 0xff, 0xfe]) }, sampleCount: 320, sequence });
    }
    const pages = readPages(recording.getFile().data);
    expect(pages.filter((page) => page.flags === 2).map((page) => page.serial)).toEqual([1, 2]);
    expect(pages.filter((page) => page.flags === 4).map((page) => page.granule)).toEqual([1920, 1920]);
  });

  it('detects a restarted sample cursor even without a sequence number', () => {
    const recording = new OggOpusRecording();
    for (const sample of [0, 320, 0]) recording.append({ data: { microphone: new Uint8Array([0xf8, 0xff, 0xfe]) }, sampleCount: 320, sample });
    expect(readPages(recording.getFile().data).filter((page) => page.flags === 2)).toHaveLength(2);
  });

  it('does not offer empty audio and clears all packets on the next Start', () => {
    const recording = new OggOpusRecording();
    recording.append({ data: {}, sampleCount: 320 });
    expect(recording.hasAudio).toBe(false);
    expect(() => recording.getFile()).toThrow('No captured audio');
    recording.append({ data: { microphone: new Uint8Array([0xf8, 0xff, 0xfe]) }, sampleCount: 320 });
    recording.reset();
    expect(recording.hasAudio).toBe(false);
    expect(() => recording.getFile()).toThrow('No captured audio');
  });
});
