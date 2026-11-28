import 'dart:convert';
import 'dart:typed_data';

import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';

class AudioRecordingFile {
  const AudioRecordingFile({required this.fileName, required this.data});

  final String fileName;
  final Uint8List data;
}

typedef _Packet = ({Uint8List data, int samples, int validSamples});
typedef _Segment = ({int sampleRate, List<_Packet> packets});

/// Stores copies of SDK Opus packets, without changing the realtime transport or recording twice.
class OggOpusRecording {
  final _segments = <_Segment>[];
  int? _lastSample;

  bool get hasAudio => _segments.isNotEmpty;

  void reset() {
    _segments.clear();
    _lastSample = null;
  }

  void append(AudioChunk chunk) {
    if (chunk.data.isEmpty || chunk.sampleCount <= 0) return;
    final lastSample = _lastSample;
    // A restarted SDK encoder needs a new logical Ogg stream (continuous chaining).
    if (_segments.isEmpty ||
        _segments.last.sampleRate != chunk.sampleRate ||
        chunk.sequence == 0 ||
        (lastSample != null && chunk.sample < lastSample)) {
      _segments.add((sampleRate: chunk.sampleRate, packets: []));
    }
    _segments.last.packets.add((
      data: Uint8List.fromList(chunk.data),
      samples: chunk.sampleCount,
      validSamples: chunk.validSampleCount,
    ));
    _lastSample = chunk.sample;
  }

  AudioRecordingFile getFile() {
    if (!hasAudio) throw StateError('No captured audio is available to download.');
    final file = BytesBuilder(copy: false);
    for (final (index, segment) in _segments.indexed) {
      final serial = index + 1;
      final head = Uint8List(19)..setAll(0, ascii.encode('OpusHead'));
      head[8] = 1;
      head[9] = 1; // Mono. SDK transport packets do not expose encoder lookahead: preserve all samples.
      ByteData.sublistView(head).setUint32(12, segment.sampleRate, Endian.little);
      file.add(_oggPage(head, 2, 0, serial, 0));
      final tags = Uint8List(16)..setAll(0, ascii.encode('OpusTags')); // Empty vendor and comment list.
      file.add(_oggPage(tags, 0, 0, serial, 1));
      var granule = 0;
      for (final (packetIndex, packet) in segment.packets.indexed) {
        final last = packetIndex == segment.packets.length - 1;
        // Opus granules always use 48 kHz, regardless of the SDK processing rate.
        granule += ((last ? packet.validSamples : packet.samples) * 48000 / segment.sampleRate).round();
        file.add(_oggPage(packet.data, last ? 4 : 0, granule, serial, packetIndex + 2));
      }
    }
    final time = DateTime.now().toUtc().toIso8601String().replaceAll(RegExp('[:.]'), '-');
    return AudioRecordingFile(fileName: 'tellus-recording-$time.ogg', data: file.takeBytes());
  }
}

// Ogg uses the non-reflected CRC-32 polynomial, with an initial value of zero.
final Uint32List _crcTable = () {
  final table = Uint32List(256);
  for (var index = 0; index < table.length; index++) {
    var crc = index << 24;
    for (var bit = 0; bit < 8; bit++) {
      crc = ((crc << 1) ^ ((crc & 0x80000000) != 0 ? 0x04c11db7 : 0)) & 0xffffffff;
    }
    table[index] = crc;
  }
  return table;
}();

Uint8List _oggPage(Uint8List packet, int flags, int granule, int serial, int sequence) {
  final segments = packet.length ~/ 255 + 1;
  if (segments > 255) throw StateError('An SDK Opus packet is too large for an Ogg page.');
  final page = Uint8List(27 + segments + packet.length)..setAll(0, ascii.encode('OggS'));
  page[5] = flags;
  final view = ByteData.sublistView(page);
  view.setUint64(6, granule, Endian.little);
  view.setUint32(14, serial, Endian.little);
  view.setUint32(18, sequence, Endian.little);
  page[26] = segments;
  page.fillRange(27, 27 + segments - 1, 255);
  page[27 + segments - 1] = packet.length % 255;
  page.setAll(27 + segments, packet);
  var crc = 0;
  for (final byte in page) {
    crc = ((crc << 8) & 0xffffffff) ^ _crcTable[((crc >> 24) ^ byte) & 0xff];
  }
  view.setUint32(22, crc, Endian.little);
  return page;
}
