const { getDefaultConfig } = require('expo/metro-config');
const { createRecordingDownloadMiddleware } = require('./scripts/recording-download-middleware.cjs');

const config = getDefaultConfig(__dirname);
const enhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const metro = enhanceMiddleware ? enhanceMiddleware(middleware, server) : middleware;
  const downloads = createRecordingDownloadMiddleware();
  return (request, response, next) => downloads(request, response, () => metro(request, response, next));
};

module.exports = config;
