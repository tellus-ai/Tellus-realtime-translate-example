import { load } from '@expo/env';
import type { ConfigContext, ExpoConfig } from 'expo/config';

load(__dirname);

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  extra: {
    ...config.extra,
    audioSdkEnabled: (process.env.TELLUS_AUDIO_SDK_ENABLED ?? process.env.EXPO_PUBLIC_TELLUS_AUDIO_SDK_ENABLED)?.trim() !== 'false',
    // `extra` ships in the app, so the API key is not here. The Expo development server reads it
    // (metro.config.js) and gives the app an access token for each Conversation.
    apiKeyConfigured: Boolean(process.env.API_KEY?.trim()),
    exampleApiUrl: process.env.TELLUS_EXAMPLE_API_URL?.trim() || '',
    websocketBaseUrl: process.env.REALTIME_SPEECH_WS_URL?.trim()
      || process.env.EXPO_PUBLIC_REALTIME_SPEECH_WS_URL?.trim() || '',
    appOrigin: process.env.APP_ORIGIN?.trim()
      || process.env.EXPO_PUBLIC_APP_ORIGIN?.trim() || '',
  },
});
