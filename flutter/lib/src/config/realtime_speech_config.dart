String _url(String value, String fallback) => (value.trim().isEmpty ? fallback : value.trim()).replaceFirst(RegExp(r'/+$'), '');

/// Settings passed to the app with `--dart-define-from-file=.dart-defines.json`
/// (written from `.env` by scripts/dart-defines.mjs). The API key is never among them.
abstract final class RealtimeSpeechConfig {
  /// Whether this example's development server has an API key. The key itself stays on that server.
  static const bool apiKeyConfigured = bool.fromEnvironment('TELLUS_API_KEY_CONFIGURED');

  /// The development server on the Mac (scripts/dev-server.mjs). It holds the API key and saves recordings.
  static final String exampleServerUrl = _url(const String.fromEnvironment('TELLUS_EXAMPLE_SERVER_URL'), 'http://localhost:8787');

  /// Where the app sends its four Conversation calls: `TELLUS_EXAMPLE_API_URL` when it is set,
  /// otherwise the routes of the development server.
  static final String apiBaseUrl = _url(const String.fromEnvironment('TELLUS_EXAMPLE_API_URL'), '$exampleServerUrl/__tellus/api');

  /// Tellus itself. The app opens the WebSockets directly, with an access token.
  static final String websocketBaseUrl = _url(const String.fromEnvironment('REALTIME_SPEECH_WS_URL'), 'wss://public.speech.tellus.ai.kr');
  static final String appOrigin = _url(const String.fromEnvironment('APP_ORIGIN'), 'https://devapp.tellus.ai.kr');

  /// Whether denoise starts on. The switch on the screen changes it at any time.
  static const bool denoiseInitiallyEnabled = bool.fromEnvironment('TELLUS_DENOISE');
}
