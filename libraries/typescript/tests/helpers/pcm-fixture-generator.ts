import * as fs from 'node:fs';
import * as path from 'node:path';
import { SyntheticAudioGenerator } from './audio-generator';

export function generateAllPcmFixtures(outputDir: string): Record<string, string> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const generator = new SyntheticAudioGenerator({ sampleRate: 16000 });
  const fixturePaths: Record<string, string> = {};

  // Scenario 1: Clean turn (500ms tone + 500ms silence)
  const s1Pcm = Buffer.concat([
    generator.generateTone(500, 440, 0.8),
    generator.generateSilence(500),
  ]);
  const s1Path = path.join(outputDir, 'scenario1_clean_turn.pcm');
  fs.writeFileSync(s1Path, s1Pcm);
  fixturePaths['scenario1'] = s1Path;

  // Scenario 2: Thinking pause (400ms tone + 1000ms pause + 400ms tone + 500ms silence)
  const s2Pcm = Buffer.concat([
    generator.generateTone(400, 440, 0.8),
    generator.generateSilence(1000),
    generator.generateTone(400, 440, 0.8),
    generator.generateSilence(500),
  ]);
  const s2Path = path.join(outputDir, 'scenario2_thinking_pause.pcm');
  fs.writeFileSync(s2Path, s2Pcm);
  fixturePaths['scenario2'] = s2Path;

  // Scenario 3: True barge-in (800ms user voice burst)
  const s3Pcm = generator.generateTone(800, 523.25, 0.9);
  const s3Path = path.join(outputDir, 'scenario3_barge_in.pcm');
  fs.writeFileSync(s3Path, s3Pcm);
  fixturePaths['scenario3'] = s3Path;

  // Scenario 4: Backchannel noise (80ms noise cough burst)
  const s4Pcm = generator.generateNoise(80, 0.3);
  const s4Path = path.join(outputDir, 'scenario4_backchannel_noise.pcm');
  fs.writeFileSync(s4Path, s4Pcm);
  fixturePaths['scenario4'] = s4Path;

  // Scenario 5: Fast short answer (250ms tone + 300ms silence)
  const s5Pcm = Buffer.concat([
    generator.generateTone(250, 600, 0.85),
    generator.generateSilence(300),
  ]);
  const s5Path = path.join(outputDir, 'scenario5_fast_answer.pcm');
  fs.writeFileSync(s5Path, s5Pcm);
  fixturePaths['scenario5'] = s5Path;

  return fixturePaths;
}
