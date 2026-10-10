import { StyleSheet, Switch, Text, View } from 'react-native';
import type { VadSnapshot } from '../audio/VADTypes';

export function VADToggle({ enabled, disabled, audioSdkEnabled, onChange }: {
  enabled: boolean;
  disabled: boolean;
  audioSdkEnabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const locked = disabled || audioSdkEnabled;
  return (
    <View style={[styles.option, locked && styles.disabled]}>
      <View style={styles.copy}>
        <Text style={styles.label}>Voice Activity Detection</Text>
        <Text style={styles.description}>
          {audioSdkEnabled ? 'Disabled while using audio-sdk' : enabled ? 'Use Silero client VAD' : 'Use server VAD'}
        </Text>
      </View>
      <Switch
        accessibilityLabel="Voice Activity Detection"
        disabled={locked}
        value={enabled && !audioSdkEnabled}
        onValueChange={(value) => { if (!locked) onChange(value); }}
      />
    </View>
  );
}

export function VADStatus({ snapshot, audioSdkEnabled }: { snapshot: VadSnapshot; audioSdkEnabled: boolean }) {
  return (
    <Text style={styles.status}>
      Client VAD: {snapshot.enabled && !audioSdkEnabled ? snapshot.mode : audioSdkEnabled ? 'Disabled (audio-sdk)' : 'Disabled'}
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
