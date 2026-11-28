import { load } from '@expo/env';
import type { ConfigContext, ExpoConfig } from 'expo/config';

load(__dirname);

export default ({ config }: ConfigContext): ExpoConfig => {
  const settings = {
    audioSdkEnabled: (process.env.TELLUS_AUDIO_SDK_ENABLED ?? process.env.EXPO_PUBLIC_TELLUS_AUDIO_SDK_ENABLED)?.trim() !== 'false',
    // `extra` ships in the app, so the API key is not here. The Expo development server reads it
    // (metro.config.js) and gives the app an access token for each Conversation.
    apiKeyConfigured: Boolean(process.env.API_KEY?.trim()),
    exampleApiUrl: process.env.TELLUS_EXAMPLE_API_URL?.trim() || '',
    websocketBaseUrl: process.env.REALTIME_SPEECH_WS_URL?.trim()
      || process.env.EXPO_PUBLIC_REALTIME_SPEECH_WS_URL?.trim() || '',
    appOrigin: process.env.APP_ORIGIN?.trim()
      || process.env.EXPO_PUBLIC_APP_ORIGIN?.trim() || '',
  };
  // A secret pasted into one of the settings above would ship in the app with it.
  for (const secret of ['API_KEY', 'TELLUS_AUDIO_ENGINE_TOKEN']) {
    const value = process.env[secret]?.trim();
    const found = value && Object.entries(settings).find(([, setting]) => typeof setting === 'string' && setting.includes(value));
    if (found) throw new Error(`The ${found[0]} setting contains the value of ${secret}. Remove it from that setting in mobile/.env.`);
  }
  return { ...config, extra: { ...config.extra, ...settings } };
};
