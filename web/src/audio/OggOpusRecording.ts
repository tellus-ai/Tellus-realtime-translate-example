export interface RecordingChunk {
  data: { microphone?: Uint8Array };
  sampleCount: number;
  validSampleCount?: number;
  sampleRate?: number;
  sample?: number;
  sequence?: number;
}

export interface AudioRecordingFile {
  fileName: string;
  data: Uint8Array<ArrayBuffer>;
}

interface Packet {
  data: Uint8Array;
  samples: number;
  validSamples: number;
}

interface Segment {
  sampleRate: number;
  packets: Packet[];
}

/** Stores copies of SDK Opus packets, without changing the realtime transport or recording twice. */
export class OggOpusRecording {
  private segments: Segment[] = [];
  private lastSample: number | undefined;

  get hasAudio(): boolean { return this.segments.length > 0; }

  reset(): void {
    this.segments = [];
    this.lastSample = undefined;
  }

  append(chunk: RecordingChunk): void {
    const payload = chunk.data.microphone;
    if (!payload?.length || chunk.sampleCount <= 0) return;
    const sampleRate = chunk.sampleRate ?? 16_000;
    let segment = this.segments[this.segments.length - 1];
    // A restarted SDK encoder needs a new logical Ogg stream (continuous chaining).
    if (!segment || segment.sampleRate !== sampleRate || chunk.sequence === 0 ||
        (chunk.sample !== undefined && this.lastSample !== undefined && chunk.sample < this.lastSample)) {
      segment = { sampleRate, packets: [] };
      this.segments.push(segment);
    }
    segment.packets.push({
      data: new Uint8Array(payload),
      samples: chunk.sampleCount,
      validSamples: chunk.validSampleCount ?? chunk.sampleCount,
    });
    this.lastSample = chunk.sample;
  }

  getFile(): AudioRecordingFile {
    if (!this.hasAudio) throw new Error('No captured audio is available to download.');
    const pages: Uint8Array[] = [];
    this.segments.forEach((segment, index) => {
      const serial = index + 1;
      const head = new Uint8Array(19);
      writeAscii(head, 0, 'OpusHead');
      head[8] = 1;
      head[9] = 1; // Mono. SDK transport packets do not expose encoder lookahead: preserve all samples.
      new DataView(head.buffer).setUint32(12, segment.sampleRate, true);
      pages.push(oggPage(head, 2, 0, serial, 0));
      const tags = new Uint8Array(16);
      writeAscii(tags, 0, 'OpusTags'); // Empty vendor and comment list.
      pages.push(oggPage(tags, 0, 0, serial, 1));
      let granule = 0;
      segment.packets.forEach((packet, packetIndex) => {
        const last = packetIndex === segment.packets.length - 1;
        // Opus granules always use 48 kHz, regardless of the SDK processing rate.
        granule += Math.round((last ? packet.validSamples : packet.samples) * 48_000 / segment.sampleRate);
        pages.push(oggPage(packet.data, last ? 4 : 0, granule, serial, packetIndex + 2));
      });
    });
    const data = new Uint8Array(pages.reduce((size, page) => size + page.length, 0));
    let offset = 0;
    for (const page of pages) { data.set(page, offset); offset += page.length; }
    return { fileName: `tellus-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.ogg`, data };
  }
}

function writeAscii(data: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) data[offset + index] = value.charCodeAt(index);
}

// Ogg uses the non-reflected CRC-32 polynomial, with an initial value of zero.
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index++) {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0);
  CRC_TABLE[index] = crc >>> 0;
}

function oggPage(packet: Uint8Array, flags: number, granule: number, serial: number, sequence: number): Uint8Array {
  const segments = Math.floor(packet.length / 255) + 1;
  if (segments > 255) throw new Error('An SDK Opus packet is too large for an Ogg page.');
  const page = new Uint8Array(27 + segments + packet.length);
  writeAscii(page, 0, 'OggS');
  page[5] = flags;
  const view = new DataView(page.buffer);
  view.setUint32(6, granule >>> 0, true);
  view.setUint32(10, Math.floor(granule / 0x100000000), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = segments;
  page.fill(255, 27, 27 + segments - 1);
  page[27 + segments - 1] = packet.length % 255;
  page.set(packet, 27 + segments);
  let crc = 0;
  for (const byte of page) crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff];
  view.setUint32(22, crc >>> 0, true);
  return page;
}
