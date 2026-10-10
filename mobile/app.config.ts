import { load } from '@expo/env';
import type { ConfigContext, ExpoConfig } from 'expo/config';

load(__dirname);

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  extra: {
    ...config.extra,
    accessToken: process.env.API_KEY?.trim() ?? '',
    httpBaseUrl: process.env.REALTIME_SPEECH_HTTP_URL?.trim()
      || process.env.EXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL?.trim() || '',
    websocketBaseUrl: process.env.REALTIME_SPEECH_WS_URL?.trim()
      || process.env.EXPO_PUBLIC_REALTIME_SPEECH_WS_URL?.trim() || '',
    appOrigin: process.env.APP_ORIGIN?.trim()
      || process.env.EXPO_PUBLIC_APP_ORIGIN?.trim() || '',
  },
});
