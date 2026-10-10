import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { realtimeSpeechConfig } from '../config/realtimeSpeechConfig';
import { useRealtimeTranslation } from '../hooks/useRealtimeTranslation';
import { ConnectionStatus } from './ConnectionStatus';
import { TranslationList } from './TranslationList';
import { VADStatus, VADToggle } from './VADControl';

const LANGUAGES = [
  { code: 'ko-KR', label: '한국어 (Korean)' },
  { code: 'en-US', label: 'English' },
  { code: 'zh-CN', label: '中文 (Chinese)' },
  { code: 'ja-JP', label: '日本語 (Japanese)' },
  { code: 'vi-VN', label: 'Tiếng Việt (Vietnamese)' },
  { code: 'ru-RU', label: 'Русский (Russian)' },
  { code: 'de-DE', label: 'Deutsch (German)' },
  { code: 'th-TH', label: 'ไทย (Thai)' },
  { code: 'pl-PL', label: 'Polski (Polish)' },
  { code: 'es-ES', label: 'Español (Spanish)' },
  { code: 'fr-FR', label: 'Français (French)' },
] as const;

export function TranslationExample() {
  const realtime = useRealtimeTranslation();
  const [sourceLanguage, setSourceLanguage] = useState('ko-KR');
  const [targetLanguage, setTargetLanguage] = useState('en-US');
  const [vadSelected, setVadSelected] = useState(false);
  const audioSdkEnabled = realtimeSpeechConfig.audioSdkEnabled !== false;
  const clientVad = vadSelected && !audioSdkEnabled;
  const tokenConfigured = Boolean(realtimeSpeechConfig.accessToken);
  const active = ['creating', 'configuring', 'connecting', 'recording', 'paused', 'reconnecting', 'stopping'].includes(realtime.phase);
  const busy = ['creating', 'configuring', 'connecting', 'stopping'].includes(realtime.phase);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.container}>
        <Text style={styles.eyebrow}>TELLUS REALTIME SPEECH</Text>
        <Text style={styles.title}>Realtime Translation Example</Text>
        <Text style={styles.description}>Replace the components in this area to apply your own design.</Text>

        {!tokenConfigured ? <Text style={styles.error}>Set API_KEY in mobile/.env.</Text> : null}

        <LanguageButtons label="Source Language" selected={sourceLanguage} disabled={active} onChange={setSourceLanguage} />
        <LanguageButtons label="Target Language" selected={targetLanguage} disabled={active} onChange={setTargetLanguage} />

        <VADToggle enabled={clientVad} disabled={active} audioSdkEnabled={audioSdkEnabled} onChange={setVadSelected} />

        <View style={styles.controls}>
          <ActionButton label="Start" disabled={active || !tokenConfigured} onPress={() => void realtime.start({ sourceLanguage, targetLanguage, clientVad })} />
          {realtime.phase === 'recording'
            ? <ActionButton label="Pause" onPress={() => void realtime.pause()} />
            : <ActionButton label="Resume" disabled={realtime.phase !== 'paused'} onPress={() => void realtime.resume()} />}
          <ActionButton label="Stop" danger disabled={!active || busy} onPress={() => void realtime.stop()} />
        </View>

        <ConnectionStatus result={realtime.resultConnection} audio={realtime.audioConnection} />
        <Text style={styles.phase}>Status: {realtime.phase}</Text>
        <Text style={styles.phase}>Audio SDK: {audioSdkEnabled ? '사용 중' : '사용하지 않음'}</Text>
        <VADStatus snapshot={realtime.vad} audioSdkEnabled={audioSdkEnabled} />
        {realtime.error ? <Text style={styles.error}>{realtime.error}</Text> : null}
        <TranslationList rows={realtime.rows} targetLanguage={targetLanguage} />
      </ScrollView>
    </SafeAreaView>
  );
}

function LanguageButtons({ label, selected, disabled, onChange }: { label: string; selected: string; disabled: boolean; onChange: (code: string) => void }) {
  return (
    <View style={styles.languageSection}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.languages}>
        {LANGUAGES.map((language) => (
          <Pressable key={language.code} disabled={disabled} onPress={() => onChange(language.code)} style={[styles.languageButton, selected === language.code && styles.languageSelected, disabled && styles.disabled]}>
            <Text style={selected === language.code ? styles.languageSelectedText : styles.languageButtonText}>{language.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function ActionButton({ label, disabled = false, danger = false, onPress }: { label: string; disabled?: boolean; danger?: boolean; onPress: () => void }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.action, danger && styles.danger, disabled && styles.disabled]}>
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#f4f6f8', flex: 1 },
  container: { padding: 20 },
  eyebrow: { color: '#52657a', fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: '#172033', fontSize: 30, fontWeight: '800', marginTop: 8 },
  description: { color: '#52657a', lineHeight: 21, marginBottom: 24, marginTop: 8 },
  label: { color: '#27364a', fontSize: 13, fontWeight: '700', marginBottom: 7 },
  languageSection: { marginTop: 18 },
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  languageButton: { backgroundColor: '#e4e9ef', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  languageSelected: { backgroundColor: '#246bfe' },
  languageButtonText: { color: '#27364a' },
  languageSelectedText: { color: '#ffffff', fontWeight: '700' },
  controls: { flexDirection: 'row', gap: 8, marginBottom: 20, marginTop: 24 },
  action: { backgroundColor: '#246bfe', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 11 },
  danger: { backgroundColor: '#d33b45' },
  disabled: { opacity: 0.4 },
  actionText: { color: '#ffffff', fontWeight: '700' },
  phase: { color: '#52657a', fontSize: 13, marginTop: 10 },
  error: { backgroundColor: '#fff0f1', borderColor: '#f0b7bb', borderRadius: 8, borderWidth: 1, color: '#b4232c', marginTop: 12, padding: 12 },
});
