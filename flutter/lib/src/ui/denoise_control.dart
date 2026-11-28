import 'package:material_ui/material_ui.dart';

import '../realtime/types.dart';
import 'styles.dart';

/// The switch that turns Audio SDK denoise on or off, before Start and while recording or paused.
class DenoiseToggle extends StatelessWidget {
  const DenoiseToggle({super.key, required this.snapshot, required this.disabled, required this.onChanged});

  final DenoiseSnapshot snapshot;
  final bool disabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final locked = disabled || snapshot.updating;
    return Card(
      color: Colors.white,
      elevation: 0,
      margin: const EdgeInsets.only(top: 12),
      child: SwitchListTile(
        title: const Text('Noise Reduction (Denoise)'),
        subtitle: Text(snapshot.updating ? 'Applying…' : 'DeepFilterNet3 · change while recording'),
        value: snapshot.enabled,
        onChanged: locked ? null : onChanged,
      ),
    );
  }
}

/// What the Audio SDK reports about denoise, and the error of the last change that failed.
class DenoiseStatus extends StatelessWidget {
  const DenoiseStatus({super.key, required this.snapshot});

  final DenoiseSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final state = switch (snapshot.applied) {
      null => 'Not started · ${snapshot.enabled ? 'On' : 'Off'} selected',
      true => 'On',
      false => 'Off',
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        StatusText('Audio SDK denoise: $state'),
        if (snapshot.error case final error?) ErrorText(error),
      ],
    );
  }
}
