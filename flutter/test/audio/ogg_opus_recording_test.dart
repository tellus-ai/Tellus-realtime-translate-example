import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';
import 'package:tellus_flutter_example/src/audio/ogg_opus_recording.dart';

typedef Page = ({int flags, int granule, int serial, int sequence, List<int> lacing, Uint8List packet});

const opusPacket = [0xf8, 0xff, 0xfe];

/// A chunk in the middle of one capture: the sequence number and the sample position go on.
AudioChunk chunk(
  List<int> data, {
  int sampleCount = 320,
  int? validSampleCount,
  int sampleRate = 16000,
  int sample = 0,
  int sequence = 1,
}) {
  return AudioChunk(
    data: Uint8List.fromList(data),
    codec: 'opus',
    sampleRate: sampleRate,
    sample: sample,
    sampleCount: sampleCount,
    validSampleCount: validSampleCount ?? sampleCount,
    timestamp: 0,
    rms: 0,
    sequence: sequence,
  );
}

List<Page> readPages(Uint8List data) {
  final pages = <Page>[];
  var offset = 0;
  while (offset < data.length) {
    expect(String.fromCharCodes(data.sublist(offset, offset + 4)), 'OggS');
    final lacing = data.sublist(offset + 27, offset + 27 + data[offset + 26]);
    final headerSize = 27 + lacing.length;
    final size = headerSize + lacing.fold<int>(0, (sum, value) => sum + value);
    final page = data.sublist(offset, offset + size);
    final view = ByteData.sublistView(page);
    final checksum = view.getUint32(22, Endian.little);
    page.fillRange(22, 26, 0);
    // Validate the container checksum independently, bit by bit.
    var crc = 0;
    for (final byte in page) {
      crc ^= byte << 24;
      for (var bit = 0; bit < 8; bit++) {
        crc = ((crc & 0x80000000) != 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1) & 0xffffffff;
      }
    }
    expect(crc, checksum);
    pages.add((
      flags: page[5],
      granule: view.getUint64(6, Endian.little),
      serial: view.getUint32(14, Endian.little),
      sequence: view.getUint32(18, Endian.little),
      lacing: lacing,
      packet: page.sublist(headerSize),
    ));
    offset += size;
  }
  expect(offset, data.length);
  return pages;
}

void main() {
  test('exports mono Ogg headers, immutable packets, 48 kHz granules and an end marker', () {
    final recording = OggOpusRecording();
    final first = chunk(opusPacket);
    recording.append(first);
    first.data.fillRange(0, first.data.length, 0);
    recording.append(chunk(opusPacket, validSampleCount: 160));
    final file = recording.getFile();
    expect(file.fileName, matches(r'^tellus-recording-[A-Za-z0-9-]+\.ogg$'));
    final pages = readPages(file.data);
    expect(pages.map((page) => (page.flags, page.granule, page.sequence)), [(2, 0, 0), (0, 0, 1), (0, 960, 2), (4, 1440, 3)]);
    expect(String.fromCharCodes(pages[0].packet.sublist(0, 8)), 'OpusHead');
    expect(pages[0].packet[9], 1);
    expect(ByteData.sublistView(pages[0].packet).getUint32(12, Endian.little), 16000);
    expect(String.fromCharCodes(pages[1].packet.sublist(0, 8)), 'OpusTags');
    expect(pages[2].packet, opusPacket);
  });

  test('terminates packets whose size is an exact multiple of 255', () {
    final recording = OggOpusRecording()..append(chunk(List.filled(510, 0)));
    final last = readPages(recording.getFile().data).last;
    expect(last.lacing, [255, 255, 0]);
    expect(last.packet, hasLength(510));
  });

  test('chains streams after an SDK encoder restart without losing earlier audio', () {
    final recording = OggOpusRecording();
    for (final sequence in [0, 1, 0, 1]) {
      recording.append(chunk(opusPacket, sequence: sequence));
    }
    final pages = readPages(recording.getFile().data);
    expect(pages.where((page) => page.flags == 2).map((page) => page.serial), [1, 2]);
    expect(pages.where((page) => page.flags == 4).map((page) => page.granule), [1920, 1920]);
  });

  test('detects a restarted sample position even when the sequence number went on', () {
    final recording = OggOpusRecording();
    for (final (index, sample) in [0, 320, 0].indexed) {
      recording.append(chunk(opusPacket, sample: sample, sequence: index + 5));
    }
    expect(readPages(recording.getFile().data).where((page) => page.flags == 2), hasLength(2));
  });

  test('does not offer empty audio and clears all packets on the next Start', () {
    final recording = OggOpusRecording()..append(chunk([]));
    expect(recording.hasAudio, isFalse);
    expect(recording.getFile, throwsStateError);
    recording.append(chunk(opusPacket));
    expect(recording.hasAudio, isTrue);
    recording.reset();
    expect(recording.hasAudio, isFalse);
    expect(
      recording.getFile,
      throwsA(isA<StateError>().having((error) => error.message, 'message', 'No captured audio is available to download.')),
    );
  });
}
