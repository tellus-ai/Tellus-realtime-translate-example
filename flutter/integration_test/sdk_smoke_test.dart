import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';

// Proves that the native Tellus engine is linked into the app. Run it on a simulator or an emulator:
//   flutter test integration_test/sdk_smoke_test.dart -d <device>
// It needs no server, no API key and no microphone permission.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the engine creates a capture and does not start it without a permit', (tester) async {
    final engine = await AudioEngine.init();
    final capture = engine.createCapture();
    addTearDown(capture.dispose);

    // The challenge comes from the native capture.
    final request = await capture.createAuthorizationRequest('smoke');
    expect(request.nativeInstanceId, isNotEmpty);
    expect(request.nonce, isNotEmpty);

    await capture.getStatus();

    // No server has approved this capture, so the engine must refuse to open the microphone.
    await expectLater(capture.start((error, chunk) {}), throwsA(isA<TellusAudioException>()));
  });
}
