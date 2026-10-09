const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
const sdk = path.resolve(__dirname, '../../tellus-audio-sdk');
config.watchFolders = [sdk];
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];

module.exports = config;
