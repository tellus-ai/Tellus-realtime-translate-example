import 'package:material_ui/material_ui.dart';

/// The colours of the example screen.
abstract final class AppColors {
  static const background = Color(0xFFF4F6F8);
  static const heading = Color(0xFF172033);
  static const label = Color(0xFF27364A);
  static const muted = Color(0xFF52657A);
  static const chip = Color(0xFFE4E9EF);
  static const primary = Color(0xFF246BFE);
  static const danger = Color(0xFFD33B45);
}

/// One grey line of status text.
class StatusText extends StatelessWidget {
  const StatusText(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Text(text, style: const TextStyle(color: AppColors.muted, fontSize: 13)),
    );
  }
}

/// A red box for an error or a missing setting. Screen readers announce it when it appears.
class ErrorText extends StatelessWidget {
  const ErrorText(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.only(top: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: const Color(0xFFFFF0F1),
          border: Border.all(color: const Color(0xFFF0B7BB)),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(text, style: const TextStyle(color: Color(0xFFB4232C))),
      ),
    );
  }
}
