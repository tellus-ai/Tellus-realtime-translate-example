import 'package:material_ui/material_ui.dart';

import 'src/ui/styles.dart';
import 'src/ui/translation_example.dart';

void main() => runApp(const TranslationApp());

class TranslationApp extends StatelessWidget {
  const TranslationApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Tellus Translation',
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: AppColors.primary, primary: AppColors.primary)),
      home: const TranslationExample(),
    );
  }
}
