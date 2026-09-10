import { StyleSheet, Switch, Text, View } from 'react-native';
import type { VadSnapshot } from '../audio/VADTypes';

export function VADToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <View style={[styles.option, disabled && styles.disabled]}>
      <View style={styles.copy}>
        <Text style={styles.label}>Voice Activity Detection</Text>
        <Text style={styles.description}>
          {enabled ? 'Use Silero client VAD' : 'Use server VAD'}
        </Text>
      </View>
      <Switch
        accessibilityLabel="Voice Activity Detection"
        disabled={disabled}
        onValueChange={onChange}
        value={enabled}
      />
    </View>
  );
}

export function VADStatus({ snapshot }: { snapshot: VadSnapshot }) {
  return (
    <Text style={styles.status}>
      VAD: {snapshot.mode} · {snapshot.ready ? 'ready' : 'not ready'} · gate {snapshot.gate} · {snapshot.level}
    </Text>
  );
}

const styles = StyleSheet.create({
  option: { alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 10, flexDirection: 'row', justifyContent: 'space-between', marginTop: 20, padding: 14 },
  copy: { flex: 1, paddingRight: 12 },
  label: { color: '#27364a', fontSize: 13, fontWeight: '700', marginBottom: 7 },
  description: { color: '#52657a', fontSize: 13 },
  status: { color: '#52657a', fontSize: 13, marginTop: 10 },
  disabled: { opacity: 0.4 },
});
