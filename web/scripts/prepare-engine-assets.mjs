import { copyWebAssets } from '@tellus-ai/audio-sdk-web/installer';
import { resolve } from 'node:path';

// 설치된 실제 엔진과 SDK ESM 파일을 복사한다. 누락된 산출물은 빌드를 중단한다.
copyWebAssets(resolve('public/tellus-audio'));
