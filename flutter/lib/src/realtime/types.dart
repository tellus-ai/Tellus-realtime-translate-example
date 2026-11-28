enum ResultEventType { transcriptPreview, transcriptFinal, translationPreview, translationFinal }

/// One row update. A Result message carries one or more of them.
class ResultEvent {
  const ResultEvent({
    required this.conversationId,
    required this.eventType,
    required this.orderSeq,
    required this.text,
    required this.sourceLanguage,
    required this.targetLanguage,
  });

  final String conversationId;
  final ResultEventType eventType;
  final int orderSeq;
  final String text;

  /// Null when the server does not know the language.
  final String? sourceLanguage;
  final String? targetLanguage;
}

class TranslationText {
  const TranslationText({required this.text, required this.isFinal});

  final String text;
  final bool isFinal;
}

class TranslationRow {
  const TranslationRow({required this.orderSeq, required this.sourceLanguage, required this.source, required this.translations});

  final int orderSeq;
  final String? sourceLanguage;
  final TranslationText? source;

  /// Keyed by target language.
  final Map<String, TranslationText> translations;
}

enum SessionPhase { idle, creating, configuring, connecting, recording, paused, reconnecting, stopping, ended, error }

enum ConnectionStatus { closed, connecting, open, error }

class DenoiseSnapshot {
  const DenoiseSnapshot({required this.enabled, this.applied, this.updating = false, this.error});

  /// The setting the user chose.
  final bool enabled;

  /// What the Audio SDK reports. Null until a capture exists.
  final bool? applied;
  final bool updating;
  final String? error;
}

/// Everything the screen shows. The session replaces the whole object on every change.
class SessionSnapshot {
  const SessionSnapshot({
    this.phase = SessionPhase.idle,
    this.conversationId,
    this.resultConnection = ConnectionStatus.closed,
    this.audioConnection = ConnectionStatus.closed,
    this.rows = const [],
    this.audioSdkReady = false,
    this.recordingAvailable = false,
    this.denoise = const DenoiseSnapshot(enabled: false),
    this.error,
  });

  final SessionPhase phase;
  final String? conversationId;
  final ConnectionStatus resultConnection;
  final ConnectionStatus audioConnection;
  final List<TranslationRow> rows;
  final bool audioSdkReady;
  final bool recordingAvailable;
  final DenoiseSnapshot denoise;
  final String? error;
}
