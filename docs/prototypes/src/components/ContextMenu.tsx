import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  ListPlus,
  Heart,
  Disc,
  User,
  Copy,
  Trash2,
  FolderPlus,
  ChevronRight,
  CornerDownRight,
} from 'lucide-react';
import { Track, Playlist } from '../data/mockMusicData';

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  track: Track | null;
  selectedCount: number;
}

interface ContextMenuProps {
  menu: ContextMenuState;
  isDark: boolean;
  playlists: Playlist[];
  onClose: () => void;
  onPlayNow: (track: Track) => void;
  onPlayNext: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  onToggleLike: (trackId: string) => void;
  onAddToPlaylist: (playlistId: string, track: Track) => void;
  onFilterAlbum: (albumName: string) => void;
  onFilterArtist: (artistName: string) => void;
  onCopyInfo: (track: Track) => void;
  onRemoveTrack: (trackId: string) => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  menu,
  isDark,
  playlists,
  onClose,
  onPlayNow,
  onPlayNext,
  onAddToQueue,
  onToggleLike,
  onAddToPlaylist,
  onFilterAlbum,
  onFilterArtist,
  onCopyInfo,
  onRemoveTrack,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showPlaylistSub, setShowPlaylistSub] = useState(false);

  useEffect(() => {
    setShowPlaylistSub(false);
  }, [menu.track, menu.x, menu.y]);

  if (!menu.visible || !menu.track) return null;

  const track = menu.track;

  // Clamp coordinates so menu stays inside viewport
  const menuWidth = 230;
  const menuHeight = 340;
  const clampedX =
    typeof window !== 'undefined'
      ? Math.min(menu.x, window.innerWidth - menuWidth - 16)
      : menu.x;
  const clampedY =
    typeof window !== 'undefined'
      ? Math.min(menu.y, window.innerHeight - menuHeight - 16)
      : menu.y;

  const isMulti = menu.selectedCount > 1;

  return (
    <div
      ref={menuRef}
      style={{ left: clampedX, top: clampedY }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className={`fixed z-[100] w-56 rounded-xl border p-1.5 shadow-2xl backdrop-blur-2xl transition-all duration-150 ${
        isDark
          ? 'bg-[#161922]/95 border-white/12 text-zinc-100 shadow-black/70'
          : 'bg-white/95 border-black/10 text-zinc-800 shadow-zinc-900/15'
      }`}
    >
      {/* Header showing current track or multi-select count */}
      <div
        className={`px-2.5 py-2 mb-1 border-b text-xs ${
          isDark ? 'border-white/8' : 'border-black/8'
        }`}
      >
        <div className="font-semibold truncate">
          {isMulti ? `已选中 ${menu.selectedCount} 首曲目` : track.title}
        </div>
        <div className="text-[11px] opacity-60 truncate mt-0.5">
          {isMulti ? '支持批量入队与收藏操作' : `${track.artist} · ${track.quality}`}
        </div>
      </div>

      <button
        onClick={() => {
          onPlayNow(track);
          onClose();
        }}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors ${
          isDark ? 'hover:bg-indigo-500/20 hover:text-indigo-200' : 'hover:bg-indigo-50 hover:text-indigo-700'
        }`}
      >
        <Play className="w-3.5 h-3.5 fill-current" />
        <span>{isMulti ? `立即播放所选 (${menu.selectedCount})` : '立即播放'}</span>
      </button>

      <button
        onClick={() => {
          onPlayNext(track);
          onClose();
        }}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-colors ${
          isDark ? 'hover:bg-white/8' : 'hover:bg-black/5'
        }`}
      >
        <CornerDownRight className="w-3.5 h-3.5 opacity-75" />
        <span>下一首播放</span>
      </button>

      <button
        onClick={() => {
          onAddToQueue(track);
          onClose();
        }}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-colors ${
          isDark ? 'hover:bg-white/8' : 'hover:bg-black/5'
        }`}
      >
        <ListPlus className="w-3.5 h-3.5 opacity-75" />
        <span>{isMulti ? `批量加入队列 (${menu.selectedCount})` : '加入播放队列'}</span>
      </button>

      <div className={`my-1 h-px ${isDark ? 'bg-white/8' : 'bg-black/8'}`} />

      <button
        onClick={() => {
          onToggleLike(track.id);
          onClose();
        }}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-colors ${
          isDark ? 'hover:bg-white/8' : 'hover:bg-black/5'
        }`}
      >
        <Heart
          className={`w-3.5 h-3.5 ${
            track.liked ? 'fill-rose-500 text-rose-500' : 'opacity-75'
          }`}
        />
        <span>{track.liked ? '取消收藏' : '添加到我喜欢'}</span>
      </button>

      {/* Submenu: Add to Playlist */}
      <div
        className="relative"
        onMouseEnter={() => setShowPlaylistSub(true)}
        onMouseLeave={() => setShowPlaylistSub(false)}
      >
        <button
          onClick={() => setShowPlaylistSub((v) => !v)}
          className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs transition-colors ${
            isDark ? 'hover:bg-white/8' : 'hover:bg-black/5'
          }`}
        >
          <span className="flex items-center gap-2.5">
            <FolderPlus className="w-3.5 h-3.5 opacity-75" />
            <span>添加到歌单</span>
          </span>
          <ChevronRight className="w-3.5 h-3.5 opacity-60" />
        </button>

        {showPlaylistSub && (
          <div
            className={`absolute left-full top-0 ml-1 w-48 rounded-xl border p-1.5 shadow-xl backdrop-blur-2xl ${
              isDark
                ? 'bg-[#161922]/95 border-white/12 text-zinc-100'
                : 'bg-white/95 border-black/10 text-zinc-800'
            }`}
          >
            {playlists.map((pl) => (
              <button
                key={pl.id}
                onClick={() => {
                  onAddToPlaylist(pl.id, track);
                  onClose();
                }}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs truncate transition-colors ${
                  isDark ? 'hover:bg-indigo-500/20' : 'hover:bg-indigo-50'
                }`}
              >
                {pl.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`my-1 h-px ${isDark ? 'bg-white/8' : 'bg-black/8'}`} />

      <button
        onClick={() => {
          onFilterAlbum(track.album);
          onClose();
        }}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-colors ${
          isDark ? 'hover:bg-white/8' : 'hover:bg-black/5'
        }`}
      >
        <Disc className="w-3.5 h-3.5 opacity-75" />
        <span className="truncate">查看专辑：{track.album}</span>
      </button>

      <button
        onClick={() => {
          onFilterArtist(track.artist);
          onClose();
        }}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-colors ${
          isDark ? 'hover:bg-white/8' : 'hover:bg-black/5'
        }`}
      >
        <User className="w-3.5 h-3.5 opacity-75" />
        <span className="truncate">查看歌手：{track.artist}</span>
      </button>

      <button
        onClick={() => {
          onCopyInfo(track);
          onClose();
        }}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-colors ${
          isDark ? 'hover:bg-white/8' : 'hover:bg-black/5'
        }`}
      >
        <Copy className="w-3.5 h-3.5 opacity-75" />
        <span>复制曲目信息</span>
      </button>

      <div className={`my-1 h-px ${isDark ? 'bg-white/8' : 'bg-black/8'}`} />

      <button
        onClick={() => {
          onRemoveTrack(track.id);
          onClose();
        }}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-rose-400 hover:bg-rose-500/15 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
        <span>从当前列表移除</span>
      </button>
    </div>
  );
};
