import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tellus_flutter_example/src/api/http_client.dart';
import 'package:tellus_flutter_example/src/audio/download_recording.dart';
import 'package:tellus_flutter_example/src/audio/ogg_opus_recording.dart';

const serverUrl = 'http://localhost:8787';

http.Response jsonResponse(int status, Object? body) => http.Response.bytes(utf8.encode(jsonEncode(body)), status);

void main() {
  test('sends exact SDK recording bytes to the Mac instead of the app container', () async {
    late http.Request sent;
    final client = MockClient((request) async {
      sent = request;
      return jsonResponse(201, {'path': '/Users/me/download/tellus-recording-test.ogg'});
    });
    final recording = AudioRecordingFile(fileName: 'tellus-recording-test.ogg', data: Uint8List.fromList([1, 2, 3]));

    expect(await downloadRecording(recording, serverUrl: serverUrl, client: client), '/Users/me/download/tellus-recording-test.ogg');
    expect(sent.method, 'POST');
    expect('${sent.url}', 'http://localhost:8787/__tellus/recordings/tellus-recording-test.ogg');
    // The server accepts exactly this content type, without a charset.
    expect(sent.headers, {'Content-Type': 'audio/ogg', 'X-Tellus-Recording-Download': '1'});
    expect(sent.bodyBytes, [1, 2, 3]);
  });

  test('preserves captured bytes for retry after a host write error', () async {
    final answers = [
      jsonResponse(500, {'message': 'Disk is full.'}),
      jsonResponse(201, {'path': '/Users/me/download/test.ogg'}),
    ];
    final client = MockClient((_) async => answers.removeAt(0));
    final recording = AudioRecordingFile(fileName: 'tellus-recording-test.ogg', data: Uint8List.fromList([1, 2, 3]));

    await expectLater(
      downloadRecording(recording, serverUrl: serverUrl, client: client),
      throwsA(isA<RealtimeApiError>().having((error) => '$error', 'text', 'Disk is full.')),
    );
    expect(await downloadRecording(recording, serverUrl: serverUrl, client: client), contains('/download/'));
    expect(recording.data, [1, 2, 3]);
  });

  test('reports an unavailable download writer without saving to the device instead', () async {
    final client = MockClient((_) async => http.Response('Not found', 404));
    final recording = AudioRecordingFile(fileName: 'tellus-recording-test.ogg', data: Uint8List.fromList([1]));

    await expectLater(
      downloadRecording(recording, serverUrl: serverUrl, client: client),
      throwsA(isA<RealtimeApiError>().having((error) => error.message, 'message', contains('개발 서버(npm start)'))),
    );
  });
}
