// Adds the Xcode 27 Pod settings of plugins/xcode27-pods.rb to the Podfile on every `expo prebuild`.
// The Ruby file decides at `pod install` time; with Xcode 26 or earlier it changes nothing.
// The Podfile in this repository is kept in the same state (tests/withXcode27Pods.test.ts checks it).
const { withPodfile } = require('expo/config-plugins');

const LOAD_ANCHOR = "require 'json'\n";
const LOAD = "require_relative '../plugins/xcode27-pods'\n";
const POST_INSTALL_ANCHOR = `      :ccache_enabled => ccache_enabled?(podfile_properties),
    )
`;
const CALL = `    # Xcode 27 and later only (plugins/xcode27-pods.rb).
    tellus_adjust_pods_for_xcode(installer)
`;

function addXcode27PodSettings(podfile) {
  if (podfile.includes('tellus_adjust_pods_for_xcode(installer)')) return podfile;
  if (!podfile.includes(LOAD_ANCHOR) || !podfile.includes(POST_INSTALL_ANCHOR)) {
    throw new Error('withXcode27Pods: the Podfile does not look like the Expo SDK 55 template. Update plugins/withXcode27Pods.js for the new template.');
  }
  return podfile
    .replace(LOAD_ANCHOR, LOAD_ANCHOR + LOAD)
    .replace(POST_INSTALL_ANCHOR, POST_INSTALL_ANCHOR + CALL);
}

function withXcode27Pods(config) {
  return withPodfile(config, (next) => {
    next.modResults.contents = addXcode27PodSettings(next.modResults.contents);
    return next;
  });
}

module.exports = withXcode27Pods;
module.exports.addXcode27PodSettings = addXcode27PodSettings;
