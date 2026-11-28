import 'package:flutter_test/flutter_test.dart';
import 'package:tellus_flutter_example/src/realtime/transcript_reducer.dart';
import 'package:tellus_flutter_example/src/realtime/types.dart';

const transcriptPreview = ResultEventType.transcriptPreview;
const transcriptFinal = ResultEventType.transcriptFinal;
const translationPreview = ResultEventType.translationPreview;
const translationFinal = ResultEventType.translationFinal;

ResultEvent event({
  ResultEventType type = transcriptPreview,
  int orderSeq = 1,
  String text = '안녕',
  String? sourceLanguage = 'ko-KR',
  String? targetLanguage,
}) {
  return ResultEvent(
    conversationId: 'c1',
    eventType: type,
    orderSeq: orderSeq,
    text: text,
    sourceLanguage: sourceLanguage,
    targetLanguage: targetLanguage,
  );
}

(String, bool)? describeText(TranslationText? text) => text == null ? null : (text.text, text.isFinal);

/// The rows as lists that `expect` can compare.
List<List<Object?>> describe(List<TranslationRow> rows) {
  return [
    for (final row in rows)
      [
        row.orderSeq,
        row.sourceLanguage,
        describeText(row.source),
        {for (final MapEntry(key: language, value: text) in row.translations.entries) language: describeText(text)},
      ],
  ];
}

void main() {
  group('applyResultEvent', () {
    test('pairs transcript and translation by order sequence', () {
      var rows = applyResultEvent([], event(type: transcriptFinal, text: '안녕하세요'));
      rows = applyResultEvent(rows, event(type: translationFinal, text: 'Hello', targetLanguage: 'en-US'));
      expect(describe(rows), [
        [1, 'ko-KR', ('안녕하세요', true), {'en-US': ('Hello', true)}],
      ]);
    });

    test('updates preview and replaces it with final', () {
      var rows = applyResultEvent([], event(text: '안녕'));
      rows = applyResultEvent(rows, event(text: '안녕하세요'));
      expect(describeText(rows[0].source), ('안녕하세요', false));
      rows = applyResultEvent(rows, event(type: transcriptFinal, text: '안녕하세요.'));
      expect(describeText(rows[0].source), ('안녕하세요.', true));
    });

    test('pairs translation by order sequence and sorts late results', () {
      var rows = applyResultEvent([], event(orderSeq: 2, type: transcriptFinal));
      rows = applyResultEvent(rows, event(orderSeq: 1, type: transcriptFinal, text: '먼저'));
      rows = applyResultEvent(rows, event(orderSeq: 1, type: translationFinal, text: 'First', targetLanguage: 'en-US'));
      expect(rows.map((row) => row.orderSeq), [1, 2]);
      expect(describeText(rows[0].translations['en-US']), ('First', true));
    });

    test('accepts a final that is shorter than its preview: the rest moved to the next order_seq', () {
      var rows = applyResultEvent([], event(orderSeq: 7, text: "다음 안건으로 넘어가겠습니다 Let's check"));
      rows = applyResultEvent(rows, event(orderSeq: 7, type: transcriptFinal, text: '다음 안건으로 넘어가겠습니다'));
      rows = applyResultEvent(rows, event(orderSeq: 8, text: "Let's check", sourceLanguage: 'en-US'));
      expect(rows.map((row) => (row.orderSeq, describeText(row.source))), [
        (7, ('다음 안건으로 넘어가겠습니다', true)),
        (8, ("Let's check", false)),
      ]);
    });

    test('keeps a final when a preview of the same order_seq arrives after it', () {
      var rows = applyResultEvent([], event(type: transcriptFinal, text: '안녕하세요.'));
      rows = applyResultEvent(rows, event(type: translationFinal, text: 'Hello.', targetLanguage: 'en-US'));
      rows = applyResultEvent(rows, event(text: '안녕'));
      rows = applyResultEvent(rows, event(type: translationPreview, text: 'Hel', targetLanguage: 'en-US'));
      expect(describe(rows), [
        [1, 'ko-KR', ('안녕하세요.', true), {'en-US': ('Hello.', true)}],
      ]);
    });

    test('leaves the rows as they are when the server sends the same final again after a reconnect', () {
      final same = event(type: transcriptFinal, text: '안녕하세요.');
      final rows = applyResultEvent([], same);
      expect(describe(applyResultEvent(rows, same)), describe(rows));
    });

    test('ignores a translation without a target language and does not change the rows it was given', () {
      final rows = applyResultEvent([], event(type: transcriptFinal));
      expect(describe(applyResultEvent(rows, event(type: translationFinal, text: 'Hello'))), describe(rows));
      applyResultEvent(rows, event(type: translationFinal, text: 'Hello', targetLanguage: 'en-US'));
      expect(rows.single.translations, isEmpty);
    });
  });

  group('lastCompleteOrderSeq', () {
    List<TranslationRow> complete(List<TranslationRow> rows, int orderSeq) {
      return applyResultEvent(
        applyResultEvent(rows, event(orderSeq: orderSeq, type: transcriptFinal)),
        event(orderSeq: orderSeq, type: translationFinal, text: 'Hi', targetLanguage: 'en-US'),
      );
    }

    test('is null until a row has its final transcript and translation', () {
      expect(lastCompleteOrderSeq([]), isNull);
      expect(lastCompleteOrderSeq(applyResultEvent([], event(orderSeq: 0, type: transcriptFinal))), isNull);
    });

    test('stops before the first row that still waits, even when later rows are complete', () {
      var rows = complete(complete([], 0), 1);
      expect(lastCompleteOrderSeq(rows), 1);
      rows = applyResultEvent(rows, event(orderSeq: 2, type: transcriptFinal));
      rows = complete(rows, 3);
      expect(lastCompleteOrderSeq(rows), 1);
    });

    test('follows the order_seq values as they are when the server skipped a number', () {
      expect(lastCompleteOrderSeq(complete(complete([], 0), 2)), 2);
    });
  });

  group('awaitsFinal', () {
    test('is true until the transcript and every translation are final', () {
      var rows = applyResultEvent([], event(text: '안녕'));
      expect(awaitsFinal(rows[0]), isTrue);

      rows = applyResultEvent(rows, event(type: transcriptFinal, text: '안녕하세요.'));
      expect(awaitsFinal(rows[0]), isTrue);

      rows = applyResultEvent(rows, event(type: translationPreview, text: 'Hello.', targetLanguage: 'en-US'));
      expect(awaitsFinal(rows[0]), isTrue);

      rows = applyResultEvent(rows, event(type: translationFinal, text: 'Hello.', targetLanguage: 'en-US'));
      expect(awaitsFinal(rows[0]), isFalse);
    });
  });
}
