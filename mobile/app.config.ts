import { load } from '@expo/env';
import type { ConfigContext, ExpoConfig } from 'expo/config';

load(__dirname);

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  extra: {
    ...config.extra,
    accessToken: process.env.API_KEY?.trim() ?? '',
  },
});
