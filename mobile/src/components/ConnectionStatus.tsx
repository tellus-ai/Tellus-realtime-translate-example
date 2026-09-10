import { StyleSheet, Text, View } from 'react-native';
import type { ConnectionStatus as Status } from '../realtime/types';

function StatusChip({ label, status }: { label: string; status: Status }) {
  return <Text style={[styles.chip, status === 'open' && styles.open]}>{label}: {status}</Text>;
}

export function ConnectionStatus({ result, audio }: { result: Status; audio: Status }) {
  return <View style={styles.row}><StatusChip label="Result" status={result} /><StatusChip label="Audio" status={audio} /></View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { backgroundColor: '#e4e9ef', borderRadius: 999, color: '#52657a', fontSize: 12, overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 6 },
  open: { backgroundColor: '#daf4e4', color: '#176a3a' },
});

