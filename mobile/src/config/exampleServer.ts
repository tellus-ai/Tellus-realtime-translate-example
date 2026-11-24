import Constants from 'expo-constants';
import { TurboModuleRegistry } from 'react-native';

/**
 * The origin of the Expo (Metro) development server on the Mac, or undefined in a build whose
 * bundle is embedded. That server saves recordings and holds the API key.
 */
export function devServerOrigin(): string | undefined {
  const host = Constants.expoConfig?.hostUri;
  const scriptUrl = TurboModuleRegistry.get<{ getConstants(): { scriptURL: string } }>('SourceCode')?.getConstants().scriptURL;
  return scriptUrl?.match(/^https?:\/\/[^/]+/)?.[0] || (host ? `http://${host}` : undefined);
}

/**
 * Where the app sends its Conversation calls: `TELLUS_EXAMPLE_API_URL` when it is set, otherwise the
 * routes of the Expo development server (scripts/conversation-api-middleware.cjs). Empty when
 * there is neither.
 */
export function exampleApiBaseUrl(configuredUrl: string): string {
  if (configuredUrl) return configuredUrl;
  const origin = devServerOrigin();
  return origin ? `${origin}/__tellus/api` : '';
}
