import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../api/conversation_api.dart';
import '../audio/download_recording.dart';
import '../audio/native_microphone.dart';
import '../config/realtime_speech_config.dart';
import '../realtime/realtime_translation_session.dart';
import '../realtime/types.dart';
import 'connection_status.dart';
import 'denoise_control.dart';
import 'styles.dart';
import 'translation_list.dart';

const _languages = {
  'ko-KR': '한국어 (Korean)',
  'en-US': 'English',
  'zh-CN': '中文 (Chinese)',
  'ja-JP': '日本語 (Japanese)',
  'vi-VN': 'Tiếng Việt (Vietnamese)',
  'ru-RU': 'Русский (Russian)',
  'de-DE': 'Deutsch (German)',
  'th-TH': 'ไทย (Thai)',
  'pl-PL': 'Polski (Polish)',
  'es-ES': 'Español (Spanish)',
  'fr-FR': 'Français (French)',
};

// No session is running: Start and Download Audio are possible.
const _stoppedPhases = {SessionPhase.idle, SessionPhase.ended, SessionPhase.error};
// The session is starting or stopping: Stop and the denoise switch have to wait.
const _busyPhases = {SessionPhase.creating, SessionPhase.configuring, SessionPhase.connecting, SessionPhase.stopping};

/// The whole example: language selection, the session controls and the translated text.
class TranslationExample extends StatefulWidget {
  const TranslationExample({super.key, this.session});

  /// Widget tests pass a session that does not use the native SDK. The app creates its own.
  final RealtimeTranslationSession? session;

  @override
  State<TranslationExample> createState() => _TranslationExampleState();
}

class _TranslationExampleState extends State<TranslationExample> {
  // One session for the lifetime of the app. Each Start opens a new Conversation in it.
  late final RealtimeTranslationSession _session =
      widget.session ??
      RealtimeTranslationSession(
        RealtimeEndpoints(
          apiBaseUrl: RealtimeSpeechConfig.apiBaseUrl,
          websocketBaseUrl: RealtimeSpeechConfig.websocketBaseUrl,
          appOrigin: RealtimeSpeechConfig.appOrigin,
        ),
        NativeMicrophone(denoiseEnabled: RealtimeSpeechConfig.denoiseInitiallyEnabled),
      );
  late final void Function() _unsubscribe;
  late final AppLifecycleListener _lifecycleListener;

  String _sourceLanguage = 'ko-KR';
  String _targetLanguage = 'en-US';
  bool _downloading = false;
  String? _downloadMessage;
  String? _downloadError;
  String? _startError;

  @override
  void initState() {
    super.initState();
    _unsubscribe = _session.subscribe(() => setState(() {}));
    // The microphone does not keep capturing in the background, so the session pauses with the app.
    _lifecycleListener = AppLifecycleListener(
      onStateChange: (state) {
        final phase = _session.snapshot.phase;
        if (state != AppLifecycleState.resumed && (phase == SessionPhase.recording || phase == SessionPhase.reconnecting)) {
          unawaited(_session.pause());
        }
      },
    );
  }

  @override
  void dispose() {
    _lifecycleListener.dispose();
    _unsubscribe();
    unawaited(_session.stop());
    super.dispose();
  }

  Future<void> _start() async {
    setState(() {
      _downloadMessage = null;
      _downloadError = null;
      _startError = null;
    });
    try {
      await _session.start(StartConversationInput(sourceLanguage: _sourceLanguage, targetLanguage: _targetLanguage));
    } catch (error) {
      // start() throws only for input it rejects, such as the same language twice.
      // Failures after that are in the snapshot.
      if (mounted) setState(() => _startError = errorText(error));
    }
  }

  Future<void> _downloadAudio() async {
    setState(() {
      _downloading = true;
      _downloadMessage = null;
      _downloadError = null;
    });
    String? message;
    String? error;
    try {
      final path = await downloadRecording(_session.getRecording(), serverUrl: RealtimeSpeechConfig.exampleServerUrl);
      message = '저장 완료: $path';
    } catch (cause) {
      error = errorText(cause);
    }
    if (!mounted) return;
    setState(() {
      _downloading = false;
      _downloadMessage = message;
      _downloadError = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = _session.snapshot;
    final phase = snapshot.phase;
    final active = !_stoppedPhases.contains(phase);
    final busy = _busyPhases.contains(phase);
    final error = _startError ?? snapshot.error;

    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'TELLUS REALTIME SPEECH',
                style: TextStyle(color: AppColors.muted, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1.5),
              ),
              const SizedBox(height: 8),
              const Text(
                'Realtime Translation Example',
                style: TextStyle(color: AppColors.heading, fontSize: 30, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 8),
              const Text(
                'Replace the widgets in this area to apply your own design.',
                style: TextStyle(color: AppColors.muted, height: 1.5),
              ),
              if (!RealtimeSpeechConfig.apiKeyConfigured)
                const ErrorText('Set API_KEY in flutter/.env and restart npm start.'),

              _LanguageChips(
                label: 'Source Language',
                selected: _sourceLanguage,
                enabled: !active,
                onChanged: (code) => setState(() => _sourceLanguage = code),
              ),
              _LanguageChips(
                label: 'Target Language',
                selected: _targetLanguage,
                enabled: !active,
                onChanged: (code) => setState(() => _targetLanguage = code),
              ),
              DenoiseToggle(
                snapshot: snapshot.denoise,
                disabled: busy || phase == SessionPhase.reconnecting,
                onChanged: (enabled) => unawaited(_session.setDenoiseEnabled(enabled)),
              ),

              const SizedBox(height: 24),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton(
                    onPressed: active || _downloading || !RealtimeSpeechConfig.apiKeyConfigured || snapshot.denoise.updating
                        ? null
                        : _start,
                    child: const Text('Start'),
                  ),
                  if (phase == SessionPhase.recording)
                    FilledButton(onPressed: () => unawaited(_session.pause()), child: const Text('Pause'))
                  else
                    FilledButton(
                      onPressed: phase == SessionPhase.paused ? () => unawaited(_session.resume()) : null,
                      child: const Text('Resume'),
                    ),
                  FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
                    onPressed: !active || busy ? null : () => unawaited(_session.stop()),
                    child: const Text('Stop'),
                  ),
                  FilledButton(
                    onPressed: active || !snapshot.recordingAvailable || _downloading ? null : _downloadAudio,
                    child: Text(_downloading ? 'Saving…' : 'Download Audio'),
                  ),
                ],
              ),

              const StatusText('Stop 후 SDK 캡처 음성을 Mac의 ~/download 폴더에 Ogg(Opus) 파일로 저장합니다.'),
              if (_downloadMessage case final message?) StatusText(message),
              if (_downloadError case final message?) ErrorText(message),

              ConnectionStatusChips(result: snapshot.resultConnection, audio: snapshot.audioConnection),
              StatusText('Status: ${phase.name}'),
              DenoiseStatus(snapshot: snapshot.denoise),
              if (error != null) ErrorText(error),
              TranslationList(rows: snapshot.rows, targetLanguage: _targetLanguage),
            ],
          ),
        ),
      ),
    );
  }
}

class _LanguageChips extends StatelessWidget {
  const _LanguageChips({required this.label, required this.selected, required this.enabled, required this.onChanged});

  final String label;
  final String selected;
  final bool enabled;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: AppColors.label, fontSize: 13, fontWeight: FontWeight.w700)),
          const SizedBox(height: 7),
          Wrap(
            spacing: 8,
            children: [
              for (final MapEntry(key: code, value: name) in _languages.entries)
                ChoiceChip(
                  label: Text(name),
                  selected: code == selected,
                  showCheckmark: false,
                  onSelected: enabled ? (_) => onChanged(code) : null,
                ),
            ],
          ),
        ],
      ),
    );
  }
}
