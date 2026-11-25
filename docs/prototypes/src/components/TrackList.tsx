import React from 'react';
import {
  Play,
  Pause,
  Heart,
  MoreHorizontal,
  CheckSquare,
  Square,
  ListPlus,
  GripVertical,
  SearchX,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { Track } from '../data/mockMusicData';
import { CoverArt } from './CoverArt';

interface TrackListProps {
  tracks: Track[];
  currentTrack: Track;
  isPlaying: boolean;
  isDark: boolean;
  viewMode: 'list' | 'grid';
  selectedIds: Set<string>;
  multiSelectMode: boolean;
  showSourceBadge?: boolean;
  emptyMessage?: string;
  emptySubMessage?: string;
  onTrackClick: (track: Track, e: React.MouseEvent, index: number) => void;
  onTrackContextMenu: (track: Track, e: React.MouseEvent) => void;
  onToggleLike: (trackId: string) => void;
  onDragStartTrack: (track: Track, e: React.DragEvent) => void;
  onDragEndTrack: () => void;
  onBatchPlay: () => void;
  onBatchAddToQueue: () => void;
  onBatchLike: () => void;
  onClearSelection: () => void;
  onToggleMultiSelectMode: () => void;
  onSelectAll: () => void;
  onResetFilters?: () => void;
}

export const TrackList: React.FC<TrackListProps> = ({
  tracks,
  currentTrack,
  isPlaying,
  isDark,
  viewMode,
  selectedIds,
  multiSelectMode,
  showSourceBadge = false,
  emptyMessage = '未找到匹配的曲目',
  emptySubMessage = '尝试调整搜索关键词、切换流派筛选或清空过滤条件',
  onTrackClick,
  onTrackContextMenu,
  onToggleLike,
  onDragStartTrack,
  onDragEndTrack,
  onBatchPlay,
  onBatchAddToQueue,
  onBatchLike,
  onClearSelection,
  onToggleMultiSelectMode,
  onSelectAll,
  onResetFilters,
}) => {
  // Empty state
  if (tracks.length === 0) {
    return (
      <div
        className={`my-6 rounded-2xl border p-12 flex flex-col items-center justify-center text-center ${
          isDark
            ? 'bg-white/[0.02] border-white/8 text-zinc-300'
            : 'bg-black/[0.02] border-black/8 text-zinc-700'
        }`}
      >
        <div
          className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-4 ${
            isDark
              ? 'bg-indigo-500/12 text-indigo-400 border border-indigo-500/25'
              : 'bg-indigo-50 text-indigo-600 border border-indigo-200'
          }`}
        >
          <SearchX className="w-7 h-7" />
        </div>
        <h4 className="text-base font-semibold">{emptyMessage}</h4>
        <p className="text-xs opacity-60 mt-1.5 max-w-sm">{emptySubMessage}</p>
        {onResetFilters && (
          <button
            onClick={onResetFilters}
            className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-medium bg-indigo-500 text-white hover:bg-indigo-400 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>重置筛选与搜索</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Multi-select / Interactive Hint Bar */}
      {selectedIds.size > 0 ? (
        <div
          className={`sticky top-0 z-20 px-4 py-2.5 rounded-xl border backdrop-blur-xl flex flex-wrap items-center justify-between gap-2 shadow-lg transition-all ${
            isDark
              ? 'bg-indigo-950/90 border-indigo-500/40 text-indigo-100'
              : 'bg-indigo-50/95 border-indigo-300 text-indigo-950'
          }`}
        >
          <div className="flex items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <CheckSquare className="w-4 h-4 text-indigo-400" />
              已选择 {selectedIds.size} 首曲目
            </span>
            <button
              onClick={onSelectAll}
              className="underline opacity-80 hover:opacity-100"
            >
              全选当前 ({tracks.length})
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onBatchPlay}
              className="px-3 py-1 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-400 inline-flex items-center gap-1.5 transition-colors"
            >
              <Play className="w-3 h-3 fill-current" />
              <span>播放所选</span>
            </button>
            <button
              onClick={onBatchAddToQueue}
              className={`px-3 py-1 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                isDark
                  ? 'bg-white/10 hover:bg-white/18'
                  : 'bg-white hover:bg-zinc-100 border border-indigo-200'
              }`}
            >
              <ListPlus className="w-3.5 h-3.5" />
              <span>批量入队</span>
            </button>
            <button
              onClick={onBatchLike}
              className={`px-3 py-1 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                isDark
                  ? 'bg-white/10 hover:bg-white/18'
                  : 'bg-white hover:bg-zinc-100 border border-indigo-200'
              }`}
            >
              <Heart className="w-3.5 h-3.5 text-rose-400" />
              <span>批量收藏</span>
            </button>
            <button
              onClick={onClearSelection}
              className="px-2.5 py-1 rounded-lg text-xs opacity-75 hover:opacity-100"
            >
              取消 (Esc)
            </button>
          </div>
        </div>
      ) : null}

      {/* Grid View (封面模式) */}
      {viewMode === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4 pt-1">
          {tracks.map((track, idx) => {
            const isCurrent = track.id === currentTrack.id;
            const isSelected = selectedIds.has(track.id);
            return (
              <div
                key={track.id}
                tabIndex={0}
                draggable
                onDragStart={(e) => onDragStartTrack(track, e)}
                onDragEnd={onDragEndTrack}
                onClick={(e) => onTrackClick(track, e, idx)}
                onContextMenu={(e) => onTrackContextMenu(track, e)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onTrackClick(
                      track,
                      e as unknown as React.MouseEvent,
                      idx
                    );
                  }
                }}
                className={`group relative rounded-2xl p-3 border cursor-pointer transition-all duration-200 ${
                  isSelected
                    ? isDark
                      ? 'bg-indigo-500/18 border-indigo-500/60 ring-1 ring-indigo-500/50'
                      : 'bg-indigo-50 border-indigo-400'
                    : isCurrent
                    ? isDark
                      ? 'bg-white/[0.07] border-indigo-500/40'
                      : 'bg-indigo-50/60 border-indigo-300'
                    : isDark
                    ? 'bg-white/[0.025] border-white/8 hover:bg-white/[0.06] hover:border-white/15 hover:-translate-y-0.5'
                    : 'bg-white border-black/8 hover:shadow-md hover:-translate-y-0.5'
                }`}
              >
                <div className="relative aspect-square rounded-xl overflow-hidden mb-3">
                  <CoverArt
                    styleType={track.coverStyle}
                    size="lg"
                    isPlaying={isCurrent && isPlaying}
                    className="w-full h-full rounded-xl transition-transform duration-500 group-hover:scale-105"
                  />
                  {/* Play overlay */}
                  <div
                    className={`absolute inset-0 bg-black/35 flex items-center justify-center transition-opacity ${
                      isCurrent
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <div className="w-11 h-11 rounded-full bg-white text-zinc-950 flex items-center justify-center shadow-xl">
                      {isCurrent && isPlaying ? (
                        <Pause className="w-5 h-5 fill-current" />
                      ) : (
                        <Play className="w-5 h-5 fill-current ml-0.5" />
                      )}
                    </div>
                  </div>

                  {/* Quality badge */}
                  <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/65 backdrop-blur-md text-[10px] font-mono-tabular text-amber-200 border border-white/10">
                    {track.format}
                  </span>
                </div>

                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div
                      className={`text-xs font-semibold truncate ${
                        isCurrent ? 'text-indigo-400' : ''
                      }`}
                    >
                      {track.title}
                    </div>
                    <div className="text-[11px] opacity-60 truncate mt-0.5">
                      {track.artist}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleLike(track.id);
                    }}
                    className="p-1 rounded-full hover:bg-current/10 shrink-0"
                  >
                    <Heart
                      className={`w-3.5 h-3.5 ${
                        track.liked
                          ? 'fill-rose-500 text-rose-500'
                          : 'opacity-40 group-hover:opacity-80'
                      }`}
                    />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Table List View (列表模式) */
        <div className="w-full">
          {/* Table Header */}
          <div
            className={`grid grid-cols-12 items-center px-3 py-2.5 text-xs font-medium border-b select-none ${
              isDark
                ? 'border-white/8 text-zinc-500'
                : 'border-black/8 text-zinc-500'
            }`}
          >
            <div className="col-span-6 sm:col-span-5 flex items-center gap-3">
              <button
                onClick={onToggleMultiSelectMode}
                title="切换多选模式 (也支持按住 Ctrl 点击行)"
                className={`w-6 text-center flex items-center justify-center transition-colors ${
                  multiSelectMode ? 'text-indigo-400' : 'hover:text-zinc-300'
                }`}
              >
                {multiSelectMode ? (
                  <CheckSquare className="w-3.5 h-3.5" />
                ) : (
                  <span>#</span>
                )}
              </button>
              <span>标题</span>
            </div>
            <div className="hidden sm:block sm:col-span-3">专辑</div>
            <div className="col-span-3 sm:col-span-2 text-right pr-3">
              {showSourceBadge ? '音源 / 音质' : '音质'}
            </div>
            <div className="col-span-3 sm:col-span-2 text-right pr-2">时长</div>
          </div>

          {/* Track Rows */}
          <div className="divide-y divide-transparent space-y-0.5 pt-1">
            {tracks.map((track, idx) => {
              const isCurrent = track.id === currentTrack.id;
              const isSelected = selectedIds.has(track.id);

              return (
                <div
                  key={track.id}
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => onDragStartTrack(track, e)}
                  onDragEnd={onDragEndTrack}
                  onClick={(e) => onTrackClick(track, e, idx)}
                  onContextMenu={(e) => onTrackContextMenu(track, e)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      onTrackClick(
                        track,
                        e as unknown as React.MouseEvent,
                        idx
                      );
                    }
                  }}
                  className={`group relative grid grid-cols-12 items-center px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-150 ${
                    isSelected
                      ? isDark
                        ? 'bg-indigo-500/18 text-indigo-100 ring-1 ring-inset ring-indigo-500/50'
                        : 'bg-indigo-50 text-indigo-950 ring-1 ring-inset ring-indigo-300'
                      : isCurrent
                      ? isDark
                        ? 'bg-white/[0.06] text-white'
                        : 'bg-indigo-50/70 text-indigo-950'
                      : isDark
                      ? 'hover:bg-white/[0.04] text-zinc-200'
                      : 'hover:bg-black/[0.035] text-zinc-800'
                  }`}
                >
                  {/* Active or Selected left indicator bar */}
                  {(isCurrent || isSelected) && (
                    <span
                      className={`absolute left-0 top-2.5 bottom-2.5 w-1 rounded-r-full ${
                        isSelected ? 'bg-indigo-400' : 'bg-indigo-500'
                      }`}
                    />
                  )}

                  {/* Column 1: # / Checkbox / Equalizer + Cover + Title & Artist */}
                  <div className="col-span-6 sm:col-span-5 flex items-center gap-3 min-w-0 pr-2">
                    <div className="w-6 flex items-center justify-center shrink-0">
                      {multiSelectMode || isSelected ? (
                        isSelected ? (
                          <CheckSquare className="w-4 h-4 text-indigo-400" />
                        ) : (
                          <Square className="w-4 h-4 opacity-40" />
                        )
                      ) : isCurrent && isPlaying ? (
                        <div className="flex items-end gap-0.5 h-3.5">
                          <span className="w-0.5 bg-indigo-400 rounded-full animate-eq-1" />
                          <span className="w-0.5 bg-indigo-400 rounded-full animate-eq-2" />
                          <span className="w-0.5 bg-indigo-400 rounded-full animate-eq-3" />
                        </div>
                      ) : (
                        <>
                          <span className="text-xs font-mono-tabular opacity-45 group-hover:hidden">
                            {idx + 1}
                          </span>
                          <Play className="w-3.5 h-3.5 fill-current hidden group-hover:block text-indigo-400" />
                        </>
                      )}
                    </div>

                    <CoverArt
                      styleType={track.coverStyle}
                      size="sm"
                      isPlaying={isCurrent && isPlaying}
                      className="w-10 h-10 rounded-lg shrink-0"
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-semibold truncate ${
                            isCurrent
                              ? isDark
                                ? 'text-indigo-300'
                                : 'text-indigo-600'
                              : ''
                          }`}
                        >
                          {track.title}
                        </span>
                      </div>
                      <div className="text-xs opacity-60 truncate mt-0.5">
                        {track.artist}
                      </div>
                    </div>
                  </div>

                  {/* Column 2: Album */}
                  <div className="hidden sm:block sm:col-span-3 text-xs opacity-65 truncate pr-3">
                    {track.album || '—'}
                  </div>

                  {/* Column 3: Source Badge / Audio Quality */}
                  <div className="col-span-3 sm:col-span-2 flex items-center justify-end gap-2 pr-3">
                    {showSourceBadge && track.source === 'netease' && (
                      <span
                        title="网易云音乐音源"
                        className="w-5 h-5 rounded-full bg-[#E60026] text-white flex items-center justify-center text-[10px] font-bold shadow-xs shrink-0"
                      >
                        <Sparkles className="w-2.5 h-2.5" />
                      </span>
                    )}
                    <div className="text-right">
                      <div className="text-[11px] font-mono-tabular opacity-75 leading-tight">
                        {track.quality.split('·')[0]?.trim()}
                      </div>
                      <div className="text-[10px] font-mono-tabular opacity-45 leading-tight">
                        {track.sampleRate}
                      </div>
                    </div>
                  </div>

                  {/* Column 4: Duration + Hover Actions */}
                  <div className="col-span-3 sm:col-span-2 flex items-center justify-end gap-2 pr-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleLike(track.id);
                      }}
                      title={track.liked ? '取消收藏' : '收藏'}
                      className={`p-1 rounded-md transition-opacity ${
                        track.liked
                          ? 'opacity-100 text-rose-500'
                          : 'opacity-0 group-hover:opacity-70 hover:!opacity-100'
                      }`}
                    >
                      <Heart
                        className={`w-3.5 h-3.5 ${
                          track.liked ? 'fill-rose-500' : ''
                        }`}
                      />
                    </button>

                    <span className="text-xs font-mono-tabular opacity-65 w-10 text-right">
                      {track.durationStr}
                    </span>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onTrackContextMenu(track, e);
                      }}
                      title="更多操作 (右键菜单)"
                      className="p-1 rounded-md opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-current/10 transition-opacity"
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </button>

                    <span
                      title="按住可拖拽至播放队列"
                      className="opacity-0 group-hover:opacity-40 cursor-grab active:cursor-grabbing hidden md:inline-flex"
                    >
                      <GripVertical className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
