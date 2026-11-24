import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// The plugin is plain CommonJS that Expo loads during prebuild.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addXcode27PodSettings } = require('../plugins/withXcode27Pods') as {
  addXcode27PodSettings(podfile: string): string;
};

// The parts of the Expo SDK 55 Podfile template that the plugin changes.
const TEMPLATE = `require 'json'
podfile_properties = JSON.parse(File.read(File.join(__dir__, 'Podfile.properties.json'))) rescue {}

target 'Example' do
  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => ccache_enabled?(podfile_properties),
    )
  end
end
`;

const mobile = join(__dirname, '..');

describe('withXcode27Pods', () => {
  it('loads plugins/xcode27-pods.rb and calls it after react_native_post_install', () => {
    const podfile = addXcode27PodSettings(TEMPLATE);
    expect(podfile).toContain("require_relative '../plugins/xcode27-pods'");
    const call = podfile.indexOf('tellus_adjust_pods_for_xcode(installer)');
    expect(call).toBeGreaterThan(podfile.indexOf(':ccache_enabled => ccache_enabled?(podfile_properties),\n    )'));
    expect(call).toBeLessThan(podfile.lastIndexOf('  end\nend'));
  });

  it('changes an already changed Podfile no further', () => {
    const once = addXcode27PodSettings(TEMPLATE);
    expect(addXcode27PodSettings(once)).toBe(once);
  });

  it('stops the prebuild when the template no longer has the expected post_install', () => {
    expect(() => addXcode27PodSettings("require 'json'\n")).toThrow(/withXcode27Pods/);
  });

  it('is already applied to the Podfile in this repository and registered in app.json', () => {
    const podfile = readFileSync(join(mobile, 'ios/Podfile'), 'utf8');
    expect(addXcode27PodSettings(podfile)).toBe(podfile);
    const appJson = JSON.parse(readFileSync(join(mobile, 'app.json'), 'utf8'));
    expect(appJson.expo.plugins).toContain('./plugins/withXcode27Pods');
  });
});

// Runs plugins/xcode27-pods.rb with stand-in CocoaPods objects, for each Xcode version.
function adjustPods(xcodeMajor: number): Record<string, string> {
  const script = `
    require ${JSON.stringify(join(mobile, 'plugins/xcode27-pods.rb'))}
    require 'json'
    Config = Struct.new(:name, :build_settings)
    Target = Struct.new(:name, :build_configurations)
    Platform = Struct.new(:deployment_target)
    Aggregate = Struct.new(:platform)
    Installer = Struct.new(:pods_project, :aggregate_targets)
    Project = Struct.new(:targets)
    def target(name, version, swift_flags = {})
      Target.new(name, %w[Debug Release].map { |c| Config.new(c, { 'IPHONEOS_DEPLOYMENT_TARGET' => version }.merge(swift_flags)) })
    end
    targets = [target('SDWebImage-SDWebImage', '9.0'), target('ExpoRouter', '15.1'), target('React-Core', '15.1'), target('Newer', '17.0'),
               target('Listed', '15.1', { 'OTHER_SWIFT_FLAGS' => ['$(inherited)', '-DLISTED'] })]
    installer = Installer.new(Project.new(targets), [Aggregate.new(Platform.new('15.1'))])
    tellus_adjust_pods_for_xcode(installer, xcode_major: ${xcodeMajor}, unchecked_availability_pods: %w[ExpoRouter Listed])
    # A second pod install must not add the flags again.
    tellus_adjust_pods_for_xcode(installer, xcode_major: ${xcodeMajor}, unchecked_availability_pods: %w[ExpoRouter Listed])
    describe = lambda do |t|
      settings = t.build_configurations.map { |c| [c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'], Array(c.build_settings['OTHER_SWIFT_FLAGS']).join(' ')].reject(&:empty?).join(' | ') }
      [t.name, settings.uniq.join(',')]
    end
    puts JSON.generate(targets.map(&describe).to_h)
  `;
  return JSON.parse(execFileSync('ruby', ['-e', script], { encoding: 'utf8' }).trim().split('\n').at(-1)!);
}

const hasRuby = (() => {
  try { execFileSync('ruby', ['--version']); return true; } catch { return false; }
})();

(hasRuby ? describe : describe.skip)('plugins/xcode27-pods.rb', () => {
  it.each([26, 16])('leaves every Pod as it is with Xcode %i', (xcodeMajor) => {
    expect(adjustPods(xcodeMajor)).toEqual({
      'SDWebImage-SDWebImage': '9.0', ExpoRouter: '15.1', 'React-Core': '15.1', Newer: '17.0',
      Listed: '15.1 | $(inherited) -DLISTED',
    });
  });

  it.each([27, 28])('with Xcode %i changes only the Pods that Xcode 27 cannot build as they are', (xcodeMajor) => {
    expect(adjustPods(xcodeMajor)).toEqual({
      // Below the iOS 15.0 that Xcode 27 still builds for: raised to the app's minimum iOS.
      'SDWebImage-SDWebImage': '15.1',
      // Stays at the app's minimum, so that the app can import it, and skips Swift's availability check.
      ExpoRouter: '15.1 | $(inherited) -Xfrontend -disable-availability-checking',
      'React-Core': '15.1',
      Newer: '17.0',
      // Existing flags are kept.
      Listed: '15.1 | $(inherited) -DLISTED -Xfrontend -disable-availability-checking',
    });
  });

  it('skips the availability check of ExpoRouter only, by default', () => {
    const script = `require ${JSON.stringify(join(mobile, 'plugins/xcode27-pods.rb'))}; puts TELLUS_XCODE27_UNCHECKED_AVAILABILITY_PODS.inspect`;
    expect(execFileSync('ruby', ['-e', script], { encoding: 'utf8' }).trim()).toBe('["ExpoRouter"]');
  });
});
