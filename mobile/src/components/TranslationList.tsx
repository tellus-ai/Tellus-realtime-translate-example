import { StyleSheet, Text, View } from 'react-native';
import type { TranslationRow } from '../realtime/types';

export function TranslationList({ rows, targetLanguage }: { rows: TranslationRow[]; targetLanguage: string }) {
  if (rows.length === 0) return <Text style={styles.empty}>Start speaking to see the transcript and translation here.</Text>;
  return (
    <View style={styles.list}>
      {rows.map((row) => {
        const translation = row.translations[targetLanguage] ?? Object.values(row.translations)[0];
        return (
          <View key={row.orderSeq} style={styles.row}>
            <View style={[styles.cell, !row.source?.isFinal && styles.preview]}>
              <Text style={styles.language}>{row.sourceLanguage || 'Source'}</Text>
              <Text style={styles.text}>{row.source?.text || '…'}</Text>
            </View>
            <View style={[styles.cell, !translation?.isFinal && styles.preview]}>
              <Text style={styles.language}>{targetLanguage}</Text>
              <Text style={styles.text}>{translation?.text || '…'}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { borderColor: '#b8c2ce', borderRadius: 12, borderStyle: 'dashed', borderWidth: 1, color: '#65758a', marginTop: 20, padding: 32, textAlign: 'center' },
  list: { gap: 12, paddingVertical: 20 },
  row: { backgroundColor: '#dfe4ea', borderRadius: 12, gap: 1, overflow: 'hidden' },
  cell: { backgroundColor: '#ffffff', minHeight: 80, padding: 14 },
  preview: { opacity: 0.6 },
  language: { color: '#65758a', fontSize: 12 },
  text: { color: '#172033', fontSize: 17, lineHeight: 25, marginTop: 6 },
});
