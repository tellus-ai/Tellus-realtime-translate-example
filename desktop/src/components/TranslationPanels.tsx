import type { TranslationRow } from '../../electron/shared/realtimeTypes';

export function TranslationPanels({
  rows,
  targetLanguage,
}: {
  rows: TranslationRow[];
  targetLanguage: string;
}) {
  if (rows.length === 0) {
    return <p className="empty-state">Start speaking to see the transcript and translation here.</p>;
  }
  return (
    <div className="translation-list" aria-live="polite">
      {rows.map((row) => {
        const translation = row.translations[targetLanguage] ?? Object.values(row.translations)[0];
        return (
          <article className="translation-row" key={row.orderSeq}>
            <div className="translation-cell" data-final={row.source?.isFinal ?? false}>
              <small>{row.sourceLanguage || 'Source'}</small>
              <p>{row.source?.text || '…'}</p>
            </div>
            <div className="translation-cell" data-final={translation?.isFinal ?? false}>
              <small>{targetLanguage}</small>
              <p>{translation?.text || '…'}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
