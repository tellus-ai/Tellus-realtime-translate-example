import { StyleSheet, Switch, Text, View } from 'react-native';
import type { DenoiseSnapshot } from '../realtime/types';

export function DenoiseToggle({ snapshot, disabled, audioSdkEnabled, onChange }: {
  snapshot: DenoiseSnapshot;
  disabled: boolean;
  audioSdkEnabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const locked = disabled || snapshot.updating || !audioSdkEnabled;
  return (
    <View style={[styles.option, locked && styles.disabled]}>
      <View style={styles.copy}>
        <Text style={styles.label}>Noise Reduction (Denoise)</Text>
        <Text style={styles.description}>{snapshot.updating ? 'Applying…'
          : audioSdkEnabled ? 'FastEnhancer · change while recording' : 'Audio SDK unavailable'}</Text>
      </View>
      <Switch accessibilityLabel="Audio SDK denoise" disabled={locked} value={snapshot.enabled && audioSdkEnabled}
        onValueChange={(value) => { if (!locked) onChange(value); }} />
    </View>
  );
}

export function DenoiseStatus({ snapshot, audioSdkEnabled }: { snapshot: DenoiseSnapshot; audioSdkEnabled: boolean }) {
  return <>
    <Text style={styles.status}>Audio SDK denoise: {!audioSdkEnabled ? 'Unavailable' : snapshot.applied === null
      ? `Not started · ${snapshot.enabled ? 'On' : 'Off'} selected` : snapshot.applied ? 'On' : 'Off'}</Text>
    {snapshot.error ? <Text accessibilityRole="alert" style={styles.error}>{snapshot.error}</Text> : null}
  </>;
}

const styles = StyleSheet.create({
  option: { alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 10, flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, padding: 14 },
  copy: { flex: 1, paddingRight: 12 },
  label: { color: '#27364a', fontSize: 13, fontWeight: '700', marginBottom: 7 },
  description: { color: '#52657a', fontSize: 13 },
  status: { color: '#52657a', fontSize: 13, marginTop: 10 },
  disabled: { opacity: 0.4 },
  error: { backgroundColor: '#fff0f1', borderColor: '#f0b7bb', borderRadius: 8, borderWidth: 1, color: '#b4232c', marginTop: 12, padding: 12 },
});
