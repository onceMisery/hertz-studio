import React, { useState } from 'react';
import {
  X,
  Trash2,
  Play,
  Pause,
  Shuffle,
  ArrowUp,
  ArrowDown,
  ListMusic,
  Sparkles,
  Plus,
} from 'lucide-react';
import { Track } from '../data/mockMusicData';
import { CoverArt } from './CoverArt';

interface QueueDrawerProps {
  isOpen: boolean;
  isDark: boolean;
  queue: Track[];
  currentTrack: Track;
  isPlaying: boolean;
  isDraggingTrack: boolean;
  onClose: () => void;
  onSelectTrack: (track: Track) => void;
  onTogglePlay: () => void;
  onRemoveFromQueue: (trackId: string) => void;
  onClearQueue: () => void;
  onShuffleQueue: () => void;
  onMoveQueueItem: (index: number, direction: 'up' | 'down') => void;
  onDropTrackToQueue: (e: React.DragEvent) => void;
  onRestoreDefaultQueue: () => void;
}

export const QueueDrawer: React.FC<QueueDrawerProps> = ({
  isOpen,
  isDark,
  queue,
  currentTrack,
  isPlaying,
  isDraggingTrack,
  onClose,
  onSelectTrack,
  onTogglePlay,
  onRemoveFromQueue,
  onClearQueue,
  onShuffleQueue,
  onMoveQueueItem,
  onDropTrackToQueue,
  onRestoreDefaultQueue,
}) => {
  const [activeTab, setActiveTab] = useState<'upnext' | 'history'>('upnext');
  const [isDragOver, setIsDragOver] = useState(false);

  if (!isOpen && !isDraggingTrack) return null;

  // If user is dragging a track and drawer isn't open yet, show a sleek floating drop target dock on the right!
  if (!isOpen && isDraggingTrack) {
    return (
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          setIsDragOver(false);
          onDropTrackToQueue(e);
        }}
        className={`fixed right-6 bottom-28 z-50 w-72 rounded-2xl border-2 border-dashed p-5 backdrop-blur-2xl transition-all duration-200 shadow-2xl flex flex-col items-center justify-center text-center ${
          isDragOver
            ? 'border-indigo-400 bg-indigo-500/25 scale-105 text-white'
            : isDark
            ? 'border-indigo-500/60 bg-[#141722]/90 text-indigo-200'
            : 'border-indigo-500 bg-indigo-50/95 text-indigo-800'
        }`}
      >
        <div className="w-11 h-11 rounded-full bg-indigo-500/20 border border-indigo-400/40 flex items-center justify-center mb-2">
          <Plus className="w-5 h-5 text-indigo-400 animate-bounce" />
        </div>
        <div className="text-sm font-semibold">松开鼠标加入播放队列</div>
        <div className="text-xs opacity-70 mt-0.5">
          支持单曲或 Ctrl 多选批量拖拽入队
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] transition-opacity"
      />

      {/* Slide-over panel */}
      <aside
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          setIsDragOver(false);
          onDropTrackToQueue(e);
        }}
        className={`fixed top-9 bottom-[88px] right-0 z-50 w-[360px] max-w-[92vw] border-l flex flex-col backdrop-blur-2xl shadow-2xl transition-all duration-300 ${
          isDark
            ? 'bg-[#11131A]/95 border-white/10 text-zinc-100 shadow-black/80'
            : 'bg-[#FAF9F6]/95 border-black/10 text-zinc-900 shadow-zinc-900/20'
        } ${isDragOver ? 'ring-2 ring-inset ring-indigo-500' : ''}`}
      >
        {/* Header */}
        <div
          className={`px-5 py-4 border-b flex items-center justify-between ${
            isDark ? 'border-white/8' : 'border-black/8'
          }`}
        >
          <div className="flex items-center gap-2">
            <ListMusic className="w-4 h-4 text-indigo-400" />
            <h3 className="font-semibold text-sm tracking-tight">播放队列</h3>
            <span
              className={`px-2 py-0.5 text-[11px] font-mono-tabular rounded-full ${
                isDark
                  ? 'bg-white/10 text-zinc-300'
                  : 'bg-black/8 text-zinc-700'
              }`}
            >
              {queue.length}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={onShuffleQueue}
              title="随机打乱队列"
              className={`p-1.5 rounded-lg text-xs transition-colors ${
                isDark
                  ? 'hover:bg-white/10 text-zinc-400 hover:text-white'
                  : 'hover:bg-black/8 text-zinc-600 hover:text-black'
              }`}
            >
              <Shuffle className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onClearQueue}
              title="清空播放队列"
              className={`p-1.5 rounded-lg text-xs transition-colors ${
                isDark
                  ? 'hover:bg-rose-500/20 text-zinc-400 hover:text-rose-300'
                  : 'hover:bg-rose-50 text-zinc-600 hover:text-rose-600'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onClose}
              title="关闭抽屉 (Esc)"
              className={`p-1.5 rounded-lg transition-colors ${
                isDark
                  ? 'hover:bg-white/10 text-zinc-400 hover:text-white'
                  : 'hover:bg-black/8 text-zinc-600 hover:text-black'
              }`}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Drag-and-drop dropzone banner */}
        {(isDraggingTrack || isDragOver) && (
          <div className="mx-4 mt-3 p-3 rounded-xl border-2 border-dashed border-indigo-400 bg-indigo-500/15 text-center text-xs text-indigo-300 font-medium animate-pulse">
            释放鼠标以将曲目追加至队列末尾
          </div>
        )}

        {/* Tabs */}
        <div className="px-5 pt-3 flex items-center gap-2">
          <button
            onClick={() => setActiveTab('upnext')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
              activeTab === 'upnext'
                ? isDark
                  ? 'bg-white text-zinc-950'
                  : 'bg-zinc-900 text-white'
                : isDark
                ? 'bg-white/6 text-zinc-400 hover:text-zinc-200'
                : 'bg-black/6 text-zinc-600 hover:text-zinc-900'
            }`}
          >
            即将播放 ({queue.length})
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
              activeTab === 'history'
                ? isDark
                  ? 'bg-white text-zinc-950'
                  : 'bg-zinc-900 text-white'
                : isDark
                ? 'bg-white/6 text-zinc-400 hover:text-zinc-200'
                : 'bg-black/6 text-zinc-600 hover:text-zinc-900'
            }`}
          >
            最近听过
          </button>
        </div>

        {/* Now Playing Pinned Card */}
        <div className="px-4 pt-3 pb-2">
          <div className="text-[11px] font-medium uppercase tracking-wider opacity-50 mb-1.5 px-1">
            正在播放
          </div>
          <div
            className={`p-2.5 rounded-xl border flex items-center gap-3 ${
              isDark
                ? 'bg-indigo-500/12 border-indigo-500/30'
                : 'bg-indigo-50/90 border-indigo-200'
            }`}
          >
            <div className="relative w-11 h-11 rounded-lg overflow-hidden shrink-0">
              <CoverArt
                styleType={currentTrack.coverStyle}
                size="sm"
                className="w-full h-full rounded-lg"
                isPlaying={isPlaying}
              />
              <button
                onClick={onTogglePlay}
                className="absolute inset-0 bg-black/40 flex items-center justify-center text-white opacity-0 hover:opacity-100 transition-opacity"
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 fill-current" />
                ) : (
                  <Play className="w-4 h-4 fill-current" />
                )}
              </button>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold truncate flex items-center gap-1.5">
                <span className="truncate">{currentTrack.title}</span>
              </div>
              <div className="text-[11px] opacity-65 truncate mt-0.5">
                {currentTrack.artist} · {currentTrack.quality}
              </div>
            </div>
            {/* Equalizer animation */}
            <div className="flex items-end gap-0.5 h-3.5 px-1">
              <span
                className={`w-0.5 bg-indigo-400 rounded-full ${
                  isPlaying ? 'animate-eq-1' : 'h-1.5'
                }`}
              />
              <span
                className={`w-0.5 bg-indigo-400 rounded-full ${
                  isPlaying ? 'animate-eq-2' : 'h-2.5'
                }`}
              />
              <span
                className={`w-0.5 bg-indigo-400 rounded-full ${
                  isPlaying ? 'animate-eq-3' : 'h-1'
                }`}
              />
            </div>
          </div>
        </div>

        {/* Queue List */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {queue.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6">
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-3 ${
                  isDark ? 'bg-white/5 text-zinc-500' : 'bg-black/5 text-zinc-400'
                }`}
              >
                <ListMusic className="w-6 h-6" />
              </div>
              <div className="text-sm font-medium">播放队列为空</div>
              <p className="text-xs opacity-60 mt-1 max-w-[220px]">
                你可以从曲库拖拽任意歌曲到此处，或点击下方按钮载入推荐队列。
              </p>
              <button
                onClick={onRestoreDefaultQueue}
                className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium bg-indigo-500 text-white hover:bg-indigo-400 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>载入精选无损队列</span>
              </button>
            </div>
          ) : (
            queue.map((track, idx) => {
              const isCurrent = track.id === currentTrack.id;
              return (
                <div
                  key={`${track.id}-${idx}`}
                  onClick={() => onSelectTrack(track)}
                  className={`group flex items-center gap-2.5 p-2 rounded-xl cursor-pointer transition-all ${
                    isCurrent
                      ? isDark
                        ? 'bg-white/10 text-indigo-300'
                        : 'bg-indigo-50 text-indigo-700'
                      : isDark
                      ? 'hover:bg-white/6'
                      : 'hover:bg-black/5'
                  }`}
                >
                  <span className="w-5 text-center text-[11px] font-mono-tabular opacity-45 shrink-0">
                    {idx + 1}
                  </span>
                  <CoverArt
                    styleType={track.coverStyle}
                    size="xs"
                    className="w-8 h-8 rounded-md shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">
                      {track.title}
                    </div>
                    <div className="text-[11px] opacity-55 truncate">
                      {track.artist}
                    </div>
                  </div>
                  <span className="text-[11px] font-mono-tabular opacity-50 group-hover:hidden">
                    {track.durationStr}
                  </span>

                  {/* Hover actions */}
                  <div
                    className="hidden group-hover:flex items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => onMoveQueueItem(idx, 'up')}
                      disabled={idx === 0}
                      title="上移"
                      className="p-1 rounded hover:bg-white/10 disabled:opacity-25"
                    >
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => onMoveQueueItem(idx, 'down')}
                      disabled={idx === queue.length - 1}
                      title="下移"
                      className="p-1 rounded hover:bg-white/10 disabled:opacity-25"
                    >
                      <ArrowDown className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => onRemoveFromQueue(track.id)}
                      title="移除"
                      className="p-1 rounded hover:bg-rose-500/20 text-rose-400"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer tip */}
        <div
          className={`px-4 py-2.5 border-t text-[11px] opacity-55 flex items-center justify-between ${
            isDark ? 'border-white/8' : 'border-black/8'
          }`}
        >
          <span>提示：支持从曲库直接拖拽歌曲入队</span>
          <span className="font-mono-tabular">WASAPI 24-bit</span>
        </div>
      </aside>
    </>
  );
};
