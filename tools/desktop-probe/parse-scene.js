const fs = require('fs');
const log = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
for (const line of log) {
  if (!line.startsWith('scene_js ')) continue;
  let data;
  try { data = JSON.parse(line.slice('scene_js '.length)); } catch (_) { continue; }
  if (data.kind !== 'scene') {
    console.log(line.slice(0, 160));
    continue;
  }
  const s = data.stats || {};
  console.log(`${data.tag} mounted=${data.mounted} frames=${data.frames} playing=${s.playing} warmed=${s.warmed} geo=${s.geometries} tex=${s.textures} prog=${s.programs} res=${s.resources} bytes=${s.estimatedBytes} draws=${s.drawCalls} sign=${s.sign}`);
}
