import 'package:material_ui/material_ui.dart';

import '../realtime/types.dart';
import 'styles.dart';

/// One card per utterance: the transcript above its translation.
class TranslationList extends StatelessWidget {
  const TranslationList({super.key, required this.rows, required this.targetLanguage});

  final List<TranslationRow> rows;
  final String targetLanguage;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) {
      return Container(
        width: double.infinity,
        margin: const EdgeInsets.only(top: 20),
        padding: const EdgeInsets.all(32),
        decoration: BoxDecoration(
          border: Border.all(color: const Color(0xFFB8C2CE)),
          borderRadius: BorderRadius.circular(12),
        ),
        child: const Text(
          'Start speaking to see the transcript and translation here.',
          textAlign: TextAlign.center,
          style: TextStyle(color: Color(0xFF65758A)),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 20),
      child: Column(spacing: 12, children: [for (final row in rows) _row(row)]),
    );
  }

  Widget _row(TranslationRow row) {
    // The translation into the selected language, or else the one the server sent.
    final translation = row.translations[targetLanguage] ?? row.translations.values.firstOrNull;
    return ClipRRect(
      key: ValueKey(row.orderSeq),
      borderRadius: BorderRadius.circular(12),
      child: ColoredBox(
        color: const Color(0xFFDFE4EA),
        child: Column(
          spacing: 1,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _cell(_orElse(row.sourceLanguage, 'Source'), row.source),
            _cell(targetLanguage, translation),
          ],
        ),
      ),
    );
  }

  Widget _cell(String language, TranslationText? text) {
    return Opacity(
      // Preview text is dimmed until the final text replaces it.
      opacity: text?.isFinal == true ? 1 : 0.6,
      child: Container(
        color: Colors.white,
        constraints: const BoxConstraints(minHeight: 80),
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(language, style: const TextStyle(color: Color(0xFF65758A), fontSize: 12)),
            const SizedBox(height: 6),
            Text(_orElse(text?.text, '…'), style: const TextStyle(color: AppColors.heading, fontSize: 17, height: 1.5)),
          ],
        ),
      ),
    );
  }
}

String _orElse(String? value, String fallback) => value == null || value.isEmpty ? fallback : value;
