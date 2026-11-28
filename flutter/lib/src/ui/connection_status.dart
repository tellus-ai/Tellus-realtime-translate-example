import 'package:material_ui/material_ui.dart';

import '../realtime/types.dart';
import 'styles.dart';

/// The state of the Result and `/v1/audio` WebSockets.
class ConnectionStatusChips extends StatelessWidget {
  const ConnectionStatusChips({super.key, required this.result, required this.audio});

  final ConnectionStatus result;
  final ConnectionStatus audio;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Wrap(spacing: 8, runSpacing: 8, children: [_chip('Result', result), _chip('Audio', audio)]),
    );
  }

  Widget _chip(String label, ConnectionStatus status) {
    final open = status == ConnectionStatus.open;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: ShapeDecoration(shape: const StadiumBorder(), color: open ? const Color(0xFFDAF4E4) : AppColors.chip),
      child: Text(
        '$label: ${status.name}',
        style: TextStyle(color: open ? const Color(0xFF176A3A) : AppColors.muted, fontSize: 12),
      ),
    );
  }
}
