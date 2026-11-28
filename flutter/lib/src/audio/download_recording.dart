import 'dart:convert';

import 'package:http/http.dart' as http;

import '../api/http_client.dart';
import 'ogg_opus_recording.dart';

/// POSTs the file to `$serverUrl/__tellus/recordings/<fileName>` and returns the path it was saved to on the Mac.
Future<String> downloadRecording(AudioRecordingFile recording, {required String serverUrl, http.Client? client}) async {
  final response = await (client?.post ?? http.post)(
    Uri.parse('$serverUrl/__tellus/recordings/${Uri.encodeComponent(recording.fileName)}'),
    headers: {'Content-Type': 'audio/ogg', 'X-Tellus-Recording-Download': '1'},
    body: recording.data,
  );
  Object? answer;
  try {
    answer = jsonDecode(utf8.decode(response.bodyBytes));
  } on FormatException {
    // Not this example's development server: reported below.
  }
  final message = answer is Map ? answer['message'] : null;
  final path = answer is Map ? answer['path'] : null;
  if (response.statusCode < 200 || response.statusCode >= 300 || path is! String) {
    throw RealtimeApiError(
      message is String && message.isNotEmpty
          ? message
          : '~/download에 저장하지 못했습니다. Mac에서 이 예제의 개발 서버(npm start)를 확인해 주세요.',
      response.statusCode,
    );
  }
  return path;
}
