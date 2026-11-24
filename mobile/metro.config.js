const { load } = require('@expo/env');
const { getDefaultConfig } = require('expo/metro-config');
const { createConversationApiMiddleware } = require('./scripts/conversation-api-middleware.cjs');
const { createRecordingDownloadMiddleware } = require('./scripts/recording-download-middleware.cjs');

const DEFAULT_HTTP_URL = 'https://public.speech.tellus.ai.kr';

// The API key stays in this development server process. The app only gets an access token.
load(__dirname);

const config = getDefaultConfig(__dirname);
const enhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const metro = enhanceMiddleware ? enhanceMiddleware(middleware, server) : middleware;
  const conversationApi = createConversationApiMiddleware({
    apiKey: process.env.API_KEY ?? '',
    httpBaseUrl: process.env.REALTIME_SPEECH_HTTP_URL?.trim()
      || process.env.EXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL?.trim() || DEFAULT_HTTP_URL,
    // Metro listens on the local network for devices. Only this computer (a simulator, an emulator,
    // a device behind `adb reverse`) may spend the key, unless a device's address is listed here.
    allowedClients: process.env.TELLUS_EXAMPLE_API_CLIENTS ?? '',
  });
  const downloads = createRecordingDownloadMiddleware();
  return (request, response, next) => conversationApi(request, response,
    () => downloads(request, response, () => metro(request, response, next)));
};

module.exports = config;
