import React, { useState } from 'react';
import {
  ChevronDown,
  Disc,
  Square,
  Heart,
  Sparkles,
  Languages,
  Cpu,
  Volume2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Shuffle,
  ListMusic,
} from 'lucide-react';
import { Track } from '../data/mockMusicData';
import { CoverArt } from './CoverArt';

interface ImmersiveLyricsModalProps {
  isOpen: boolean;
  track: Track;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  ambientEnabled: boolean;
  ambientIntensity: number;
  slowDrift: boolean;
  playMode: 'loop' | 'single' | 'shuffle' | 'order';
  volume: number;
  onClose: () => void;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (time: number) => void;
  onToggleLike: (trackId: string) => void;
  onCyclePlayMode: () => void;
  onVolumeChange: (val: number) => void;
  onOpenQueue: () => void;
}

export const ImmersiveLyricsModal: React.FC<ImmersiveLyricsModalProps> = ({
  isOpen,
  track,
  isPlaying,
  currentTime,
  duration,
  ambientEnabled,
  ambientIntensity,
  slowDrift,
  playMode,
  volume,
  onClose,
  onTogglePlay,
  onPrev,
  onNext,
  onSeek,
  onToggleLike,
  onCyclePlayMode,
  onVolumeChange,
  onOpenQueue,
}) => {
  const [showTranslation, setShowTranslation] = useState(true);
  const [vinylMode, setVinylMode] = useState(false);

  if (!isOpen) return null;

  // Determine active lyric index based on currentTime
  const lyrics = track.lyrics || [];
  let activeLyricIndex = 0;
  for (let i = 0; i < lyrics.length; i++) {
    if (currentTime >= lyrics[i].time) {
      activeLyricIndex = i;
    } else {
      break;
    }
  }

  const formatTime = (secs: number) => {
    const s = Math.max(0, Math.floor(secs));
    const mins = Math.floor(s / 60);
    const rem = s % 60;
    return `${mins}:${rem < 10 ? '0' : ''}${rem}`;
  };

  const playModeLabel = {
    loop: '列表循环',
    single: '单曲循环',
    shuffle: '随机播放',
    order: '顺序播放',
  }[playMode];

  const glowOpacity = ambientEnabled ? (ambientIntensity / 100) * 0.55 : 0;

  return (
    <div className="fixed inset-0 top-9 z-40 bg-[#08090C] text-zinc-100 flex flex-col overflow-hidden select-none">
      {/* Dynamic extracted cover ambient glow */}
      {ambientEnabled && (
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-1000"
          style={{ opacity: glowOpacity }}
        >
          <div
            className={`absolute -top-24 -left-24 w-[560px] h-[560px] rounded-full blur-[130px] ${
              slowDrift ? 'animate-ambient-drift' : ''
            }`}
            style={{ background: track.accentColor }}
          />
          <div
            className={`absolute -bottom-32 right-12 w-[520px] h-[520px] rounded-full blur-[140px] ${
              slowDrift ? 'animate-ambient-drift' : ''
            }`}
            style={{
              background: track.secondaryColor,
              animationDelay: '-6s',
            }}
          />
        </div>
      )}

      {/* Top Bar */}
      <div className="relative z-10 px-8 py-5 flex items-center justify-between border-b border-white/6">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/8 hover:bg-white/14 border border-white/10 text-xs font-medium transition-all"
          >
            <ChevronDown className="w-4 h-4" />
            <span>返回日常视图 (Esc)</span>
          </button>

          {/* Lossless Signal Chain Badge */}
          <div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-[11px] font-mono-tabular">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <Cpu className="w-3.5 h-3.5" />
            <span>
              {track.format} · {track.bitDepth} / {track.sampleRate} · Direct DAC
            </span>
          </div>
        </div>

        {/* Right Stage Switches */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setVinylMode((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-all ${
              vinylMode
                ? 'bg-white text-zinc-950 border-white font-semibold'
                : 'bg-white/6 text-zinc-300 border-white/10 hover:bg-white/12'
            }`}
          >
            {vinylMode ? (
              <Disc className="w-3.5 h-3.5" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
            <span>{vinylMode ? '黑胶唱盘' : '艺术封套'}</span>
          </button>

          <button
            onClick={() => setShowTranslation((t) => !t)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-all ${
              showTranslation
                ? 'bg-indigo-500/25 text-indigo-200 border-indigo-400/40'
                : 'bg-white/6 text-zinc-400 border-white/10 hover:bg-white/12'
            }`}
          >
            <Languages className="w-3.5 h-3.5" />
            <span>双语注释</span>
          </button>
        </div>
      </div>

      {/* Center Split Stage: Artwork Left + Synchronized Lyrics Right */}
      <div className="relative z-10 flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 px-8 lg:px-16 py-6 items-center overflow-hidden">
        {/* Left Column: Album Art / Vinyl + Metadata */}
        <div className="lg:col-span-5 flex flex-col items-center lg:items-start justify-center">
          <div className="relative group">
            {vinylMode ? (
              <div className="relative w-64 h-64 sm:w-80 sm:h-80 rounded-full bg-gradient-to-br from-zinc-900 via-black to-zinc-900 border-4 border-white/10 shadow-[0_24px_60px_rgba(0,0,0,0.8)] flex items-center justify-center">
                {/* Vinyl grooves */}
                <div
                  className="absolute inset-3 rounded-full opacity-30 pointer-events-none"
                  style={{
                    background:
                      'repeating-radial-gradient(circle at center, rgba(255,255,255,0.12) 0px, rgba(255,255,255,0.12) 1px, transparent 2px, transparent 6px)',
                  }}
                />
                <div
                  className={`w-36 h-36 sm:w-44 sm:h-44 rounded-full overflow-hidden border-4 border-zinc-950 shadow-inner ${
                    isPlaying ? 'animate-spin-slow' : ''
                  }`}
                >
                  <CoverArt
                    styleType={track.coverStyle}
                    size="xl"
                    className="w-full h-full rounded-full"
                    isPlaying={isPlaying}
                  />
                </div>
                <div className="absolute w-5 h-5 rounded-full bg-[#08090C] border-2 border-white/30" />
              </div>
            ) : (
              <CoverArt
                styleType={track.coverStyle}
                size="hero"
                isPlaying={isPlaying}
                className="w-64 h-64 sm:w-84 sm:h-84 rounded-3xl shadow-[0_28px_70px_rgba(0,0,0,0.75)]"
              />
            )}
          </div>

          {/* Track Meta below Cover */}
          <div className="mt-7 w-full max-w-sm text-center lg:text-left">
            <div className="flex items-center justify-center lg:justify-between gap-3">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight truncate">
                {track.title}
              </h1>
              <button
                onClick={() => onToggleLike(track.id)}
                className="p-2 rounded-full bg-white/6 hover:bg-white/12 transition-colors shrink-0"
                title={track.liked ? '取消收藏' : '收藏'}
              >
                <Heart
                  className={`w-5 h-5 ${
                    track.liked
                      ? 'fill-rose-500 text-rose-500'
                      : 'text-zinc-400'
                  }`}
                />
              </button>
            </div>
            <div className="text-sm text-zinc-400 mt-1 flex items-center justify-center lg:justify-start gap-2">
              <span className="text-zinc-200 font-medium">{track.artist}</span>
              <span>·</span>
              <span>{track.album}</span>
              <span>·</span>
              <span className="font-mono-tabular text-xs px-2 py-0.5 rounded bg-white/8 text-indigo-300">
                {track.quality}
              </span>
            </div>
          </div>
        </div>

        {/* Right Column: Synchronized Interactive Lyrics */}
        <div className="lg:col-span-7 h-[340px] sm:h-[440px] overflow-y-auto pr-2 space-y-5 mask-linear">
          <div className="text-xs font-mono-tabular uppercase tracking-widest text-indigo-300/70 flex items-center gap-1.5 mb-2">
            <Sparkles className="w-3.5 h-3.5" />
            <span>同步歌词与曲目导聆（点击任意行跳转进度）</span>
          </div>

          {lyrics.map((line, index) => {
            const isActive = index === activeLyricIndex;
            const isPast = index < activeLyricIndex;
            return (
              <div
                key={index}
                onClick={() => onSeek(line.time)}
                className={`group cursor-pointer rounded-2xl px-4 py-3 transition-all duration-300 ${
                  isActive
                    ? 'bg-white/10 border border-white/12 scale-[1.01] shadow-lg'
                    : 'hover:bg-white/5 opacity-45 hover:opacity-85'
                }`}
              >
                <div className="flex items-baseline justify-between gap-4">
                  <p
                    className={`font-semibold tracking-tight transition-all ${
                      isActive
                        ? 'text-xl sm:text-2xl text-white'
                        : isPast
                        ? 'text-base text-zinc-400'
                        : 'text-base text-zinc-300'
                    }`}
                  >
                    {line.text}
                  </p>
                  <span className="text-[11px] font-mono-tabular text-indigo-300/70 opacity-0 group-hover:opacity-100 shrink-0">
                    {formatTime(line.time)}
                  </span>
                </div>
                {showTranslation && line.trans && (
                  <p
                    className={`mt-1 text-xs sm:text-sm ${
                      isActive ? 'text-indigo-200/90' : 'text-zinc-400'
                    }`}
                  >
                    {line.trans}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Immersive Transport Bar */}
      <div className="relative z-10 px-8 lg:px-16 py-5 border-t border-white/8 bg-black/30 backdrop-blur-xl flex flex-col gap-3">
        {/* Progress Scrubber */}
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono-tabular text-zinc-400 w-10 text-right">
            {formatTime(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={currentTime}
            onChange={(e) => onSeek(Number(e.target.value))}
            className="flex-1 h-1.5 bg-white/15 rounded-lg appearance-none cursor-pointer accent-indigo-400"
          />
          <span className="text-xs font-mono-tabular text-zinc-400 w-10">
            {formatTime(duration)}
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between">
          <button
            onClick={onCyclePlayMode}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/8 hover:bg-white/14 text-xs text-zinc-300 transition-colors"
          >
            {playMode === 'shuffle' ? (
              <Shuffle className="w-3.5 h-3.5" />
            ) : (
              <Repeat className="w-3.5 h-3.5" />
            )}
            <span>{playModeLabel}</span>
          </button>

          <div className="flex items-center gap-5">
            <button
              onClick={onPrev}
              className="p-2 rounded-full hover:bg-white/10 text-zinc-200 transition-colors"
              title="上一首"
            >
              <SkipBack className="w-5 h-5 fill-current" />
            </button>
            <button
              onClick={onTogglePlay}
              className="w-12 h-12 rounded-full bg-white text-zinc-950 flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-transform"
              title="播放 / 暂停 (空格)"
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 fill-current" />
              ) : (
                <Play className="w-5 h-5 fill-current ml-0.5" />
              )}
            </button>
            <button
              onClick={onNext}
              className="p-2 rounded-full hover:bg-white/10 text-zinc-200 transition-colors"
              title="下一首"
            >
              <SkipForward className="w-5 h-5 fill-current" />
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-zinc-400" />
              <input
                type="range"
                min={0}
                max={100}
                value={volume}
                onChange={(e) => onVolumeChange(Number(e.target.value))}
                className="w-24 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white"
              />
            </div>
            <button
              onClick={onOpenQueue}
              className="p-2 rounded-full bg-white/8 hover:bg-white/15 text-zinc-200 transition-colors"
              title="打开播放队列"
            >
              <ListMusic className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
