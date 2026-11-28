import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:tellus_flutter_example/main.dart';
import 'package:tellus_flutter_example/src/realtime/realtime_translation_session.dart';
import 'package:tellus_flutter_example/src/realtime/types.dart';
import 'package:tellus_flutter_example/src/ui/translation_example.dart';

// These tests do not load the native Audio SDK: the app loads it only after Start, and Start is
// never tapped here.

/// A session that stays in one state and counts the calls to [pause].
class _FixedSession implements RealtimeTranslationSession {
  _FixedSession(this.snapshot);

  @override
  final SessionSnapshot snapshot;
  int pauseCalls = 0;

  @override
  void Function() subscribe(void Function() listener) => () {};

  @override
  Future<void> pause() async {
    pauseCalls += 1;
  }

  @override
  Future<void> stop() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

bool _enabled(WidgetTester tester, String label) {
  return tester.widget<FilledButton>(find.widgetWithText(FilledButton, label)).onPressed != null;
}

void main() {
  testWidgets('shows the controls, with Start disabled until an API key is configured', (tester) async {
    // `flutter test` passes no --dart-define, so the API key counts as not configured.
    await tester.pumpWidget(const TranslationApp());

    expect(find.text('Realtime Translation Example'), findsOneWidget);
    expect(find.text('Set API_KEY in flutter/.env and restart npm start.'), findsOneWidget);
    // Once as a source language and once as a target language.
    expect(find.widgetWithText(ChoiceChip, 'English'), findsNWidgets(2));
    expect(find.text('Noise Reduction (Denoise)'), findsOneWidget);
    expect(find.text('Status: idle'), findsOneWidget);
    for (final label in ['Start', 'Resume', 'Stop', 'Download Audio']) {
      expect(_enabled(tester, label), isFalse, reason: label);
    }
  });

  testWidgets('while recording, shows Pause, Stop and the translation, and pauses with the app', (tester) async {
    final session = _FixedSession(
      const SessionSnapshot(
        phase: SessionPhase.recording,
        resultConnection: ConnectionStatus.open,
        audioConnection: ConnectionStatus.open,
        rows: [
          TranslationRow(
            orderSeq: 1,
            sourceLanguage: 'ko-KR',
            source: TranslationText(text: '안녕하세요', isFinal: true),
            translations: {'en-US': TranslationText(text: 'Hello', isFinal: false)},
          ),
        ],
      ),
    );
    await tester.pumpWidget(MaterialApp(home: TranslationExample(session: session)));

    expect(find.text('Status: recording'), findsOneWidget);
    expect(find.text('Audio: open'), findsOneWidget);
    expect(find.text('Resume'), findsNothing);
    expect(_enabled(tester, 'Pause'), isTrue);
    expect(_enabled(tester, 'Stop'), isTrue);
    expect(_enabled(tester, 'Start'), isFalse);
    expect(find.text('안녕하세요'), findsOneWidget);
    expect(find.text('Hello'), findsOneWidget);

    // The app leaves the foreground.
    addTearDown(() => tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    expect(session.pauseCalls, 1);
  });
}
