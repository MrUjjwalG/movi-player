import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const directory = resolve(process.env.MOVI_CAPTURE_MEDIA || fileURLToPath(new URL('../../test-media/chrome-store/', import.meta.url)));
const source = join(directory, 'Sintel-trailer.mp4');
await mkdir(directory, { recursive: true });
try {
  await access(source);
} catch {
  execFileSync('curl', ['-L', '--fail', '--max-time', '120', 'https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4', '-o', source], { stdio: 'inherit' });
}
const timestamp = seconds => `00:00:${String(seconds).padStart(2, '0')},000`;
const subtitle = join(directory, 'Sintel-credits.srt');
await writeFile(subtitle, Array.from({ length: 26 }, (_, index) =>
  `${index + 1}\n${timestamp(index * 2)} --> ${timestamp(index * 2 + 2)}\nSintel\nBlender Foundation\n`
).join('\n'));

function ffmpeg(args, filename) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, join(directory, filename)], { stdio: 'inherit' });
  process.stdout.write(`Prepared ${filename}\n`);
}
ffmpeg([
  '-i', source, '-i', subtitle, '-map', '0:v', '-map', '0:a', '-map', '0:a', '-map', '1:0',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a:0', '192k', '-ac:a:1', '1', '-b:a:1', '96k', '-c:s', 'srt',
  '-metadata', 'title=Sintel — Official Trailer',
  '-metadata:s:a:0', 'title=Stereo', '-metadata:s:a:0', 'language=eng',
  '-metadata:s:a:1', 'title=Mono', '-metadata:s:a:1', 'language=eng',
  '-metadata:s:s:0', 'title=Film credits', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', '0',
], 'Sintel-trailer.mkv');

for (const clip of [
  { start: 20, duration: 12, name: '01 - Sintel - Rooftops.mkv', title: 'Sintel — Rooftops' },
  { start: 5, duration: 12, name: '02 - Sintel - Mountains.mp4', title: 'Sintel — Mountains' },
  { start: 32, duration: 8, name: '03 - Sintel - Desert.webm', title: 'Sintel — Desert', webm: true },
]) {
  const encoding = clip.webm
    ? ['-c:v', 'libvpx-vp9', '-b:v', '1300k', '-deadline', 'realtime', '-cpu-used', '6', '-c:a', 'libopus', '-b:a', '96k']
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-bf', '0', '-c:a', 'aac', '-b:a', '128k'];
  ffmpeg(['-ss', String(clip.start), '-i', source, '-t', String(clip.duration), '-map', '0:v', '-map', '0:a', ...encoding, '-g', '24', '-metadata', `title=${clip.title}`], clip.name);
}
