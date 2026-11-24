# Pod settings that only builds with Xcode 27 and later need. The Podfile calls
# tellus_adjust_pods_for_xcode at the end of post_install (plugins/withXcode27Pods.js adds the call
# on every `expo prebuild`). With an earlier Xcode nothing changes. The minimum iOS of the app and of
# every Pod it imports stays as it is either way.
#
# 1. Xcode 27 builds for iOS 15.0 and later only. A Pod target below that, such as the SDWebImage
#    resource bundle that declares iOS 9.0, stops the build, so it is raised to the app's minimum.
# 2. expo-router sets UIAction.subtitle without an availability check
#    (ios/LinkPreview/LinkPreviewNativeActionView.swift). UIKit declares it for iOS 15.0
#    (UIMenuElement.h), which the app's minimum covers, but the Swift compiler of Xcode 27 reports
#    it as iOS 16.0 and stops. Building ExpoRouter for iOS 16.0 is not a way out: the app, built for
#    its own minimum, imports ExpoRouter, and Swift refuses a module with a higher minimum. So
#    ExpoRouter keeps its minimum and is compiled without Swift's availability check.
#
# `pod install` decides with the Xcode that `xcodebuild` selects (xcode-select). Run it again after
# switching Xcode.

TELLUS_XCODE27_MINIMUM_IOS = Gem::Version.new('15.0')
TELLUS_XCODE27_UNCHECKED_AVAILABILITY_PODS = %w[ExpoRouter].freeze
TELLUS_SKIP_AVAILABILITY_CHECK = %w[-Xfrontend -disable-availability-checking].freeze

def tellus_xcode_major_version
  `xcodebuild -version 2>/dev/null`[/^Xcode (\d+)/, 1].to_i
end

def tellus_adjust_pods_for_xcode(installer, xcode_major: tellus_xcode_major_version,
                                 unchecked_availability_pods: TELLUS_XCODE27_UNCHECKED_AVAILABILITY_PODS)
  return [] if xcode_major < 27

  app_minimum = installer.aggregate_targets.map { |target| Gem::Version.new(target.platform.deployment_target.to_s) }.max
  changes = []
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      settings = config.build_settings
      current = settings['IPHONEOS_DEPLOYMENT_TARGET']
      if current && Gem::Version.new(current) < TELLUS_XCODE27_MINIMUM_IOS
        settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_minimum.to_s
        changes << "#{target.name} (#{config.name}) iOS #{current} -> #{app_minimum}"
      end

      next unless unchecked_availability_pods.include?(target.name)

      flags = settings['OTHER_SWIFT_FLAGS'] || '$(inherited)'
      flags = flags.split if flags.is_a?(String)
      next if flags.include?(TELLUS_SKIP_AVAILABILITY_CHECK.last)

      settings['OTHER_SWIFT_FLAGS'] = (flags + TELLUS_SKIP_AVAILABILITY_CHECK).join(' ')
      changes << "#{target.name} (#{config.name}) without Swift availability check"
    end
  end
  if defined?(Pod::UI)
    Pod::UI.puts "[Xcode #{xcode_major}] Pod settings: #{changes.empty? ? 'no change' : changes.join(', ')}"
  end
  changes
end
