// SPDX-License-Identifier: MIT
import { commonParams, number, select, createParticles, createTowers, createRings, createTerrain, createHanddrawn, motionFrame } from './factories.js';
import { createSpatialLyrics } from './text.js';
import { createCoverWall } from './cover-wall.js';
import { createCoverSphere } from './cover-sphere.js';
import { createCoverParticles } from './cover-particles.js';
import { createReactor } from './reactor.js';
import { createParticleSilk } from './particle-silk.js';
import { createGravitySphere } from './gravity-sphere.js';
import { createWarpTunnel } from './warp-tunnel.js';
import { createPrismGalaxy } from './prism-galaxy.js';
import { createEffects, postSpecs } from '../effects/index.js';

const definitions = [
  ['reactor', '粒子反应堆', 'particles', createReactor],
  ['particle-silk', '粒子绸带', 'particles', createParticleSilk],
  ['gravity-sphere', '引力星球', 'particles', createGravitySphere, ['immersive/orb', 'orb']],
  ['warp-tunnel', '折跃隧道', 'particles', createWarpTunnel, ['immersive/tunnel']],
  ['prism-galaxy', '棱镜星系', 'particles', createPrismGalaxy, ['immersive/prism', 'prism']],
  ['cover-sphere', '封面星球', 'artwork', createCoverSphere, ['immersive/silk', 'silk']],
  ['cover-particles', '粒子封面', 'artwork', createCoverParticles],
  ['spectrum-towers', '频谱塔林', 'spectrum', ctx => createTowers(ctx), ['creative/towers', 'towers']],
  ['spectrum-sphere', '频谱球', 'spectrum', ctx => createParticles(ctx, 'spectrum-sphere', [0xffaa7a, 0x84ddff]), ['creative/orb']],
  ['light-tunnel', '光隧道', 'spectrum', ctx => createRings(ctx, true), ['creative/tunnel', 'tunnel']],
  ['spectrum-nebula', '星云', 'spectrum', ctx => createParticles(ctx, 'nebula', [0x71d9f2, 0xf182b9]), ['creative/nebula', 'nebula']],
  ['spectrum-terrain', '频谱地形', 'spectrum', ctx => createTerrain(ctx), ['creative/terrain', 'terrain']],
  ['lyric-classic', '流光', 'lyrics', ctx => createSpatialLyrics(ctx, 'classic'), ['classic']],
  ['lyric-cadenza', '心象', 'lyrics', ctx => createSpatialLyrics(ctx, 'cadenza'), ['cadenza']],
  ['lyric-sonnet', '商籁', 'lyrics', ctx => createSpatialLyrics(ctx, 'sonnet'), ['sonnet']],
  ['lyric-tempera', '凝彩', 'lyrics', ctx => createSpatialLyrics(ctx, 'tempera'), ['tempera']],
  ['handdrawn-manga', '漫画材质', 'material', ctx => createHanddrawn(ctx, 'manga'), ['handdrawn/manga']],
  ['handdrawn-anime', '赛璐璐材质', 'material', ctx => createHanddrawn(ctx, 'anime'), ['handdrawn/anime']],
  ['handdrawn-pencil', '铅笔材质', 'material', ctx => createHanddrawn(ctx, 'pencil'), ['handdrawn/pencil']],
  ['handdrawn-color', '双色材质', 'material', ctx => createHanddrawn(ctx, 'color'), ['handdrawn/color']],
  ['background-mesh', '空间渐变网格', 'background', ctx => createTerrain(ctx, 'mesh'), ['backgrounds/mesh', 'stanza/geometric']],
  ['background-flow', '空间流场', 'background', ctx => createParticles(ctx, 'flow'), ['backgrounds/flow', 'stanza/fluid']],
  ['background-spectrogram', '空间频谱色谱', 'background', ctx => createTerrain(ctx, 'spectrogram'), ['backgrounds/spectrogram']],
  ['background-cover', '封面氛围', 'background', ctx => createParticles(ctx, 'cover'), ['backgrounds/cover', 'stanza/atmosphere']],
  ['cover-wall', '曲面封面墙', 'artwork', createCoverWall, ['space-layers/bgwall', 'bgwall']]
];

function definition([id, label, category, factory, aliases = []]) {
  const lyrics = category === 'lyrics', tunnel = id.includes('tunnel'), galaxy = id.includes('galaxy'), terrain = id.includes('terrain') || id === 'background-mesh' || id === 'background-spectrogram';
  const stanzaRenderer = ['classic', 'cadenza', 'sonnet', 'tempera'].find(kind => id === 'lyric-' + kind);
  const toggle = (label, value = true) => ({ type: 'boolean', label, default: value });
  const sphere = id.includes('sphere') || id === 'background-cover', towers = id === 'spectrum-towers';
  const silkScene = id === 'particle-silk', orbScene = id === 'gravity-sphere', warpScene = id === 'warp-tunnel', prismScene = id === 'prism-galaxy';
  return {
    apiVersion: 1, id, stateVersion: 1, label, category: { particles: '星空', artwork: '封面艺术', spectrum: '频谱', lyrics: '歌词', material: '材质', background: '空间背景' }[category], aliases, preview: '/space-scene-preview/' + id + '.jpg',
    params: { ...commonParams, ...postSpecs,
      reduced: { type: 'boolean', label: '减少动态', default: false },
      ...(category === 'particles' || id === 'cover-particles' ? {
        pointSize: number('粒子大小', 1, .6, 1.8), pointerStrength: number('悬停凹陷', 1, 0, 2)
      } : {}),
      ...(id === 'cover-particles' ? { relief: number('封面起伏', 1, 0, 2.5) } : {}),
      ...(id === 'reactor' ? { trackRecipes: toggle('按曲换场'), queuePreview: toggle('悬停预览') } : {}),
      ...(lyrics ? { textWidth: number('文字宽度', 12, 6, 18, .5), spacing: number('行距', 2.1, 1.4, 4, .1), arc: number('歌词弧度', .7, 0, 3, .1), karaoke: { type: 'boolean', label: '逐字高亮', default: true },
        layout: select('舞台主题', 'venue', ['venue', 'diorama', 'tempo', 'still']) } : {}),
      ...(stanzaRenderer ? { scale: number('歌词字号', 1, .5, 2), reactivity: number('律动强度', 1.35, 0, 2), speed: number('镜头动态', .65, 0, 2) } : {}),
      ...(id === 'lyric-classic' ? { rotation: toggle('词语旋转'), breathing: number('呼吸幅度', 1, 0, 2), wordSpacing: number('词语间距', .7, 0, 2) } : {}),
      ...(id === 'lyric-cadenza' ? { width: number('排版宽度', .72, .5, .9, .01), motion: number('运动幅度', 1, 0, 2), glow: number('辉光强度', 1, 0, 1.6), beam: number('光束强度', 0, 0, 1.2) } : {}),
      ...(id === 'lyric-tempera' ? {
        colorMode: select('套色风格', 'duo', ['duo', 'mono', 'vivid']),
        composition: select('色块构图', 'auto', ['auto', 'split-duo', 'quad-grid', 'diagonal-cut', 'triptych', 'banded', 'poster-frame', 'fan-burst', 'shutters', 'offset-collage']),
        screens: toggle('网屏纹理'), inversion: toggle('扫光反色'), seams: toggle('印刷接缝'), halation: number('光晕强度', .5, 0, 1)
      } : {}),
      ...(id === 'lyric-sonnet' ? {
        shotFlow: select('镜头编排', 'auto', ['auto', 'editorial-column', 'type-impact', 'fragment-collage', 'tracking-ribbon', 'mask-reveal', 'poster-blocks', 'quiet-tableau']),
        sceneKind: select('空间谱面', 'orbital', ['orbital', 'constellation', 'perspective', 'wave-score', 'orrery', 'editorial-lattice']),
        lyricLayout: select('歌词排版', 'phrases', [{ value: 'phrases', label: '短句' }, { value: 'lines', label: '整行' }, { value: 'staircase', label: '阶梯' }, { value: 'editorial-track', label: '文字轨道' }]),
        phraseLength: number('短句长度', 12, 4, 24, 1), decor: toggle('画面装饰'), accents: toggle('强调特效'), atmosphere: toggle('氛围光'), halation: number('光晕强度', .5, 0, 1)
      } : {}),
      ...(id === 'cover-wall' ? { radius: number('曲面半径', 11, 7, 18, .5), coverIndex: number('当前封面', 0, 0, 100000, 1) } : {}) },
    camera: id === 'reactor' ? { theta: 0, phi: .06, radius: 15, fov: 48, lookAt: [0, 0, 0], minRadius: 3, maxRadius: 36, orbit: true, zoom: true, fit: { halfWidth: 6.2, halfHeight: 5.4 } } :
      { theta: prismScene ? .3 : orbScene ? .3 : galaxy || towers ? .3 : 0,
        phi: silkScene ? .12 : orbScene ? .3 : warpScene ? .02 : prismScene ? .32 : id === 'cover-particles' ? 0 : terrain || towers ? .35 : galaxy ? .35 : .06,
        radius: warpScene ? 8 : orbScene ? 11.5 : prismScene ? 18 : silkScene ? 13 : tunnel ? 5 : lyrics ? 15 : galaxy ? 21 : terrain ? 22 : sphere ? 9.2 : id === 'cover-wall' ? 8 : id === 'cover-particles' ? 9.6 : 13,
        lookAt: warpScene ? [0, 0, -11] : terrain ? [0, -1, -2] : tunnel ? [0, 0, -4] : [0, 0, 0], fov: warpScene ? 66 : id === 'cover-particles' ? 54 : 58, minRadius: 3, maxRadius: 36, orbit: true, zoom: true },
    capabilities: { interaction: true, threejs: true, depth: true, lyrics, ownsLyrics: lyrics, ...(stanzaRenderer ? { stanzaRenderer } : {}), ...(id === 'reactor' || id === 'cover-wall' ? { queuePreview: true } : {}), effects: true, director: true, cues: true, cover: id.includes('cover') },
    quality: id === 'cover-particles' ? { low: { particles: 9216, drawCalls: 16 }, medium: { particles: 20736, drawCalls: 20 }, high: { particles: 36864, drawCalls: 24 } } :
      { low: { particles: 4000, drawCalls: 16 }, medium: { particles: 7000, drawCalls: 20 }, high: { particles: 10000, drawCalls: 24 } },
    create(ctx) {
      const primary = factory(ctx), effects = createEffects(ctx, ctx.layer === 'lyrics' ? [] : undefined); let params = ctx.params;
      return {
        update(frame) {
          const visualFrame = motionFrame(frame, params.reduced, lyrics), sceneTime = visualFrame.sceneTime;
          primary.update(visualFrame); effects.update(visualFrame);
          if (primary.group && !lyrics) {
            primary.group.rotation.z = params.director ? Math.sin(sceneTime * .08) * .04 : 0;
            primary.group.scale.setScalar((params.scale ?? 1) * (params.cue === 'chorus' ? 1.08 : 1));
            primary.group.rotation.x = params.cue === 'bridge' ? .06 : 0;
          }
        }, resize(w, h) { primary.resize(w, h); effects.resize(w, h); },
        setParams(next) { params = next; primary.setParams(next); effects.setParams(next); }, setQuality(profile) { primary.setQuality(profile); effects.setQuality(profile); },
        ...(primary.setRig ? { setRig(pose) { primary.setRig(pose); } } : {}),
        dispose() { effects.dispose(); primary.dispose(); }, stats: () => ({ primary: primary.stats?.(), effects: effects.stats() })
      };
    }
  };
}
export const sceneDefinitions = definitions.map(definition);
export function registerScenes(registry) { sceneDefinitions.forEach(def => registry.register(def)); }
