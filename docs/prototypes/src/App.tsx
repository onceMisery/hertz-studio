import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Home,
  Library,
  Globe,
  Calendar,
  ListMusic,
  Heart,
  Settings,
  LayoutGrid,
  Headphones,
  Users,
  BookOpen,
  Search,
  Menu,
  Sun,
  Moon,
  MoreVertical,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
  VolumeX,
  List,
  Grid,
  ChevronDown,
  ChevronUp,
  Shuffle,
  Sparkles,
  RefreshCw,
  FolderOpen,
  Wrench,
  Plus,
  Clock,
  SlidersHorizontal,
  Monitor,
  Minimize2,
  Maximize2,
  X,
  CheckCircle2,
  Radio,
  Disc,
  Mic2,
} from 'lucide-react';
import {
  INITIAL_TRACKS,
  MOCK_ALBUMS,
  MOCK_ARTISTS,
  INITIAL_PLAYLISTS,
  INITIAL_PODCASTS,
  POETIC_QUOTES,
  Track,
  Playlist,
  PodcastShow,
  CoverStyleType,
} from './data/mockMusicData';
import { CoverArt } from './components/CoverArt';
import { TrackList } from './components/TrackList';
import { ContextMenu, ContextMenuState } from './components/ContextMenu';
import { QueueDrawer } from './components/QueueDrawer';
import { ImmersiveLyricsModal } from './components/ImmersiveLyricsModal';
import {
  ShortcutsModal,
  MusicFoldersModal,
  CreatePlaylistModal,
} from './components/Modals';
import {
  PodcastView,
  ListenTogetherView,
  ReadingView,
  SettingsView,
} from './components/ExtendedViews';
import { soundEngine } from './utils/soundEngine';

type NavKey =
  | 'home'
  | 'library'
  | 'online'
  | 'daily'
  | 'playlists'
  | 'favorites'
  | 'settings'
  | 'podcast'
  | 'together'
  | 'reading';

type LibrarySubTab = '歌曲' | '专辑' | '歌手' | '歌单';
type PlayMode = 'loop' | 'single' | 'shuffle' | 'order';

interface ToastItem {
  id: number;
  message: string;
}

export function App() {
  // Theme & Visual Settings (Dark-First, switchable to Warm Alabaster Light)
  const [isDark, setIsDark] = useState(true);
  const [ambientEnabled, setAmbientEnabled] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [ambientIntensity, setAmbientIntensity] = useState(70);
  const [slowDrift, setSlowDrift] = useState(true);
  const [synthEnabled, setSynthEnabled] = useState(false);
  const [exclusiveAudio, setExclusiveAudio] = useState(true);

  // Navigation & Layout State
  const [activeNav, setActiveNav] = useState<NavKey>('home');
  const [libraryTab, setLibraryTab] = useState<LibrarySubTab>('歌曲');
  const [moreExpanded, setMoreExpanded] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [narrowWindowPreview, setNarrowWindowPreview] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [homeHeroExpanded, setHomeHeroExpanded] = useState(true);
  const [dailyBannerOpen, setDailyBannerOpen] = useState(true);
  const [dailySourceMode, setDailySourceMode] = useState<'online' | 'local'>('online');

  // Data State
  const [tracks, setTracks] = useState<Track[]>(INITIAL_TRACKS);
  const [playlists, setPlaylists] = useState<Playlist[]>(INITIAL_PLAYLISTS);
  const [activePlaylistId, setActivePlaylistId] = useState<string>(
    INITIAL_PLAYLISTS[0].id
  );
  const [podcasts, setPodcasts] = useState<PodcastShow[]>(INITIAL_PODCASTS);

  // Quote Carousel on Home Hero (Screenshot 1: 6 / 8)
  const [quoteIndex, setQuoteIndex] = useState(5); // index 5 => 6/8 "雁字回时，月满西楼..."

  // Search & Filter State
  const [globalSearch, setGlobalSearch] = useState('');
  const [onlineSearch, setOnlineSearch] = useState('');
  const [onlineGenre, setOnlineGenre] = useState<string>('热门');
  const [onlineSource, setOnlineSource] = useState('网易云音乐');
  const [onlineQuality, setOnlineQuality] = useState('Hi-Res');
  const [onlineTypeTab, setOnlineTypeTab] = useState<'单曲' | '歌单' | '歌手' | '专辑'>('单曲');
  const [artistFilter, setArtistFilter] = useState<string>('all');
  const [albumFilter, setAlbumFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'title' | 'duration' | 'quality'>('title');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Playback State
  const [queue, setQueue] = useState<Track[]>(INITIAL_TRACKS);
  const [currentTrack, setCurrentTrack] = useState<Track>(INITIAL_TRACKS[0]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(48);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [scrubTime, setScrubTime] = useState<number>(48);
  const [volume, setVolume] = useState<number>(78);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playMode, setPlayMode] = useState<PlayMode>('loop');
  const [sleepTimer, setSleepTimer] = useState<number | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);

  // Drawers, Modals & Overlays
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isImmersiveOpen, setIsImmersiveOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [isFoldersOpen, setIsFoldersOpen] = useState(false);
  const [isCreatePlaylistOpen, setIsCreatePlaylistOpen] = useState(false);

  // Multi-select & Drag-and-Drop & Context Menu State
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [isDraggingTrack, setIsDraggingTrack] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    track: null,
    selectedCount: 0,
  });

  // Toast Notification Queue
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const addToast = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2800);
  }, []);

  // Responsive narrow window detection (< 960px auto-collapses sidebar)
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 960) {
        setSidebarCollapsed(true);
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Sync Web Audio Synth Engine
  useEffect(() => {
    soundEngine.setVolume(isMuted ? 0 : volume / 100);
  }, [volume, isMuted]);

  useEffect(() => {
    soundEngine.setSynthEnabled(synthEnabled, isPlaying);
    return () => soundEngine.stopAmbientLoop();
  }, [synthEnabled, isPlaying]);

  // Playback Timer Interval
  useEffect(() => {
    if (!isPlaying || isScrubbing) return;
    const timer = window.setInterval(() => {
      setCurrentTime((prev) => {
        if (prev + 1 >= currentTrack.duration) {
          // Auto advance based on playMode
          if (playMode === 'single') {
            return 0;
          }
          handleNextTrack();
          return 0;
        }
        return prev + 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  });

  // Track navigation helpers
  const playTrackImmediately = useCallback(
    (track: Track) => {
      setCurrentTrack(track);
      setCurrentTime(0);
      setScrubTime(0);
      setIsPlaying(true);
      setQueue((prev) => {
        if (prev.some((t) => t.id === track.id)) return prev;
        return [track, ...prev];
      });
      if (synthEnabled) {
        soundEngine.playChime(587.33);
      }
      addToast(`正在播放：${track.title} - ${track.artist}`);
    },
    [addToast, synthEnabled]
  );

  const handleTogglePlay = useCallback(() => {
    setIsPlaying((prev) => {
      const next = !prev;
      addToast(next ? `继续播放：${currentTrack.title}` : '已暂停播放');
      return next;
    });
  }, [currentTrack.title, addToast]);

  const handleNextTrack = useCallback(() => {
    if (queue.length === 0) return;
    if (playMode === 'shuffle') {
      const randIdx = Math.floor(Math.random() * queue.length);
      const next = queue[randIdx];
      setCurrentTrack(next);
      setCurrentTime(0);
      setIsPlaying(true);
      addToast(`随机播放：${next.title}`);
      return;
    }
    const idx = queue.findIndex((t) => t.id === currentTrack.id);
    const nextIdx = idx === -1 ? 0 : (idx + 1) % queue.length;
    const next = queue[nextIdx];
    setCurrentTrack(next);
    setCurrentTime(0);
    setIsPlaying(true);
    addToast(`下一首：${next.title}`);
  }, [queue, currentTrack.id, playMode, addToast]);

  const handlePrevTrack = useCallback(() => {
    if (queue.length === 0) return;
    if (currentTime > 5) {
      setCurrentTime(0);
      addToast('已回到曲目开头');
      return;
    }
    const idx = queue.findIndex((t) => t.id === currentTrack.id);
    const prevIdx =
      idx <= 0 ? queue.length - 1 : (idx - 1 + queue.length) % queue.length;
    const prev = queue[prevIdx];
    setCurrentTrack(prev);
    setCurrentTime(0);
    setIsPlaying(true);
    addToast(`上一首：${prev.title}`);
  }, [queue, currentTrack.id, currentTime, addToast]);

  const handleStopPlayback = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setScrubTime(0);
    addToast('已停止播放并重置进度');
  }, [addToast]);

  const handleCyclePlayMode = useCallback(() => {
    const order: PlayMode[] = ['loop', 'single', 'shuffle', 'order'];
    const labels: Record<PlayMode, string> = {
      loop: '列表循环',
      single: '单曲循环',
      shuffle: '随机播放',
      order: '顺序播放',
    };
    const next = order[(order.indexOf(playMode) + 1) % order.length];
    setPlayMode(next);
    addToast(`播放模式已切换为：${labels[next]}`);
  }, [playMode, addToast]);

  // Global Keyboard Shortcuts (Space, Ctrl/Cmd+K, Esc)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      // Ctrl/Cmd + K -> Focus Global Search Input
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        addToast('已聚焦全局搜索框 (Ctrl/Cmd + K)');
        return;
      }

      // Escape -> Close overlays in priority order
      if (e.key === 'Escape') {
        if (contextMenu.visible) {
          setContextMenu((prev) => ({ ...prev, visible: false }));
          return;
        }
        if (isShortcutsOpen) {
          setIsShortcutsOpen(false);
          return;
        }
        if (isFoldersOpen) {
          setIsFoldersOpen(false);
          return;
        }
        if (isCreatePlaylistOpen) {
          setIsCreatePlaylistOpen(false);
          return;
        }
        if (isQueueOpen) {
          setIsQueueOpen(false);
          addToast('已关闭播放队列抽屉');
          return;
        }
        if (isImmersiveOpen) {
          setIsImmersiveOpen(false);
          addToast('已退出沉浸歌词视图');
          return;
        }
        if (selectedIds.size > 0 || multiSelectMode) {
          setSelectedIds(new Set());
          setMultiSelectMode(false);
          addToast('已清空多选状态');
          return;
        }
        if (isInputFocused) {
          target?.blur();
          return;
        }
      }

      // Space -> Play / Pause when not typing in an input
      if (e.code === 'Space' && !isInputFocused) {
        e.preventDefault();
        handleTogglePlay();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    contextMenu.visible,
    isShortcutsOpen,
    isFoldersOpen,
    isCreatePlaylistOpen,
    isQueueOpen,
    isImmersiveOpen,
    selectedIds.size,
    multiSelectMode,
    handleTogglePlay,
    addToast,
  ]);

  // Close context menu on window click
  useEffect(() => {
    const closeMenu = () => {
      if (contextMenu.visible) {
        setContextMenu((prev) => ({ ...prev, visible: false }));
      }
    };
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, [contextMenu.visible]);

  // Interactive Progress Bar Scrubbing (MouseDown / MouseMove / MouseUp)
  const calculateTimeFromClientX = useCallback(
    (clientX: number) => {
      if (!progressBarRef.current) return currentTime;
      const rect = progressBarRef.current.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width)
      );
      return Math.round(ratio * (currentTrack.duration || 100));
    },
    [currentTrack.duration, currentTime]
  );

  const handleProgressMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const newTime = calculateTimeFromClientX(e.clientX);
    setIsScrubbing(true);
    setScrubTime(newTime);
  };

  useEffect(() => {
    if (!isScrubbing) return;
    const handleMouseMove = (e: MouseEvent) => {
      setScrubTime(calculateTimeFromClientX(e.clientX));
    };
    const handleMouseUp = (e: MouseEvent) => {
      const finalTime = calculateTimeFromClientX(e.clientX);
      setCurrentTime(finalTime);
      setIsScrubbing(false);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isScrubbing, calculateTimeFromClientX]);

  // Filtered tracks for current view
  const displayedTracks = useMemo(() => {
    let list = [...tracks];

    // View-specific base filtering
    if (activeNav === 'online') {
      if (onlineGenre !== '热门') {
        list = list.filter((t) => t.genre === onlineGenre);
      }
      if (onlineSearch.trim()) {
        const q = onlineSearch.trim().toLowerCase();
        list = list.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.artist.toLowerCase().includes(q) ||
            t.album.toLowerCase().includes(q)
        );
      }
    } else if (activeNav === 'favorites') {
      list = list.filter((t) => t.liked);
    } else if (activeNav === 'playlists') {
      const activePl = playlists.find((p) => p.id === activePlaylistId);
      if (activePl) {
        list = list.filter((t) => activePl.trackIds.includes(t.id));
      }
    } else if (activeNav === 'daily') {
      if (dailySourceMode === 'local') {
        list = list.filter((t) => t.source === 'local');
      }
    } else if (activeNav === 'library') {
      if (artistFilter !== 'all') {
        list = list.filter((t) => t.artist.includes(artistFilter));
      }
      if (albumFilter !== 'all') {
        list = list.filter((t) => t.album === albumFilter);
      }
    }

    // Global Search filter
    if (globalSearch.trim()) {
      const q = globalSearch.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q) ||
          t.quality.toLowerCase().includes(q)
      );
    }

    // Sorting
    list.sort((a, b) => {
      if (sortBy === 'duration') return b.duration - a.duration;
      if (sortBy === 'quality') return b.sampleRate.localeCompare(a.sampleRate);
      return a.title.localeCompare(b.title, 'zh-CN');
    });

    return list;
  }, [
    tracks,
    activeNav,
    onlineGenre,
    onlineSearch,
    playlists,
    activePlaylistId,
    dailySourceMode,
    artistFilter,
    albumFilter,
    globalSearch,
    sortBy,
  ]);

  // Track Row Click Handler (Supports Single Click Play + Ctrl/Cmd Multi-Select + Shift Range Select)
  const handleTrackClick = (
    track: Track,
    e: React.MouseEvent,
    index: number
  ) => {
    if (e.ctrlKey || e.metaKey || multiSelectMode) {
      e.preventDefault();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(track.id)) {
          next.delete(track.id);
        } else {
          next.add(track.id);
        }
        return next;
      });
      setLastClickedIndex(index);
      return;
    }

    if (e.shiftKey && lastClickedIndex !== null) {
      e.preventDefault();
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      const rangeIds = displayedTracks.slice(start, end + 1).map((t) => t.id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        rangeIds.forEach((id) => next.add(id));
        return next;
      });
      return;
    }

    // Normal click: play track immediately
    playTrackImmediately(track);
  };

  // Right-click Context Menu Handler
  const handleTrackContextMenu = (track: Track, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let count = selectedIds.size;
    if (!selectedIds.has(track.id)) {
      count = 1;
    }
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      track,
      selectedCount: count,
    });
  };

  // Like / Favorite Toggle
  const handleToggleLike = (trackId: string) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id === trackId) {
          const nextLiked = !t.liked;
          addToast(
            nextLiked ? `已收藏《${t.title}》` : `已取消收藏《${t.title}》`
          );
          return { ...t, liked: nextLiked };
        }
        return t;
      })
    );
    if (currentTrack.id === trackId) {
      setCurrentTrack((prev) => ({ ...prev, liked: !prev.liked }));
    }
  };

  // Drag and Drop to Queue handlers
  const handleDragStartTrack = (track: Track, e: React.DragEvent) => {
    const idsToDrag =
      selectedIds.has(track.id) && selectedIds.size > 1
        ? Array.from(selectedIds)
        : [track.id];
    e.dataTransfer.setData(
      'application/hertz-tracks',
      JSON.stringify(idsToDrag)
    );
    e.dataTransfer.effectAllowed = 'copy';
    setIsDraggingTrack(true);
  };

  const handleDropTrackToQueue = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingTrack(false);
    try {
      const raw = e.dataTransfer.getData('application/hertz-tracks');
      if (!raw) return;
      const ids: string[] = JSON.parse(raw);
      const tracksToAdd = tracks.filter((t) => ids.includes(t.id));
      if (tracksToAdd.length === 0) return;

      setQueue((prev) => {
        const existingIds = new Set(prev.map((t) => t.id));
        const uniqueNew = tracksToAdd.filter((t) => !existingIds.has(t.id));
        return [...prev, ...(uniqueNew.length > 0 ? uniqueNew : tracksToAdd)];
      });
      addToast(
        tracksToAdd.length > 1
          ? `已将 ${tracksToAdd.length} 首曲目拖拽加入播放队列`
          : `已将《${tracksToAdd[0].title}》拖拽加入播放队列`
      );
    } catch {
      // Fallback
    }
  };

  // Multi-select batch actions
  const handleBatchPlay = () => {
    const selected = tracks.filter((t) => selectedIds.has(t.id));
    if (selected.length === 0) return;
    setQueue(selected);
    setCurrentTrack(selected[0]);
    setCurrentTime(0);
    setIsPlaying(true);
    setSelectedIds(new Set());
    setMultiSelectMode(false);
    addToast(`已开始播放选中的 ${selected.length} 首曲目`);
  };

  const handleBatchAddToQueue = () => {
    const selected = tracks.filter((t) => selectedIds.has(t.id));
    if (selected.length === 0) return;
    setQueue((prev) => [...prev, ...selected]);
    setSelectedIds(new Set());
    setMultiSelectMode(false);
    addToast(`已将选中的 ${selected.length} 首曲目加入播放队列`);
  };

  const handleBatchLike = () => {
    const count = selectedIds.size;
    if (count === 0) return;
    setTracks((prev) =>
      prev.map((t) => (selectedIds.has(t.id) ? { ...t, liked: true } : t))
    );
    setSelectedIds(new Set());
    setMultiSelectMode(false);
    addToast(`已批量收藏 ${count} 首曲目`);
  };

  // Format seconds helper
  const formatSeconds = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  };

  const activeTime = isScrubbing ? scrubTime : currentTime;
  const progressPercent = currentTrack.duration
    ? Math.min(100, (activeTime / currentTrack.duration) * 100)
    : 0;

  const currentQuote = POETIC_QUOTES[quoteIndex % POETIC_QUOTES.length];
  const uniqueArtists = useMemo(
    () => Array.from(new Set(tracks.map((t) => t.artist))),
    [tracks]
  );
  const uniqueAlbums = useMemo(
    () => Array.from(new Set(tracks.map((t) => t.album))),
    [tracks]
  );

  const playModeLabel = {
    loop: '列表循环',
    single: '单曲循环',
    shuffle: '随机播放',
    order: '顺序播放',
  }[playMode];

  const isSidebarCompact = sidebarCollapsed || narrowWindowPreview;
  const mainAmbientOpacity = ambientEnabled
    ? (ambientIntensity / 100) * (isDark ? 0.22 : 0.12)
    : 0;

  return (
    <div
      className={`h-screen w-screen overflow-hidden flex flex-col select-none transition-colors duration-300 ${
        isDark
          ? 'bg-[#0A0B0E] text-[#F3F4F6]'
          : 'bg-[#F6F5F2] text-[#111827]'
      }`}
    >
      {/* Wrapper supporting Narrow Window Preview mode */}
      <div
        className={`relative flex-1 flex flex-col overflow-hidden transition-all duration-300 mx-auto w-full ${
          narrowWindowPreview
            ? 'max-w-[860px] my-2 rounded-2xl border shadow-2xl border-indigo-500/40'
            : ''
        }`}
      >
        {/* =========================================================
            1. TOP NATIVE DESKTOP WINDOW TITLE BAR (HertzStudio)
           ========================================================= */}
        <header
          className={`h-9 px-3.5 flex items-center justify-between border-b text-xs shrink-0 z-30 ${
            isDark
              ? 'bg-[#07080A] border-white/6 text-zinc-300'
              : 'bg-[#EAE8E3] border-black/8 text-zinc-700'
          }`}
        >
          {/* Left App Title */}
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-indigo-500/20 border border-indigo-400/40 flex items-center justify-center text-[9px] font-mono-tabular text-indigo-400">
              |||
            </div>
            <span className="font-medium tracking-tight text-[12px]">
              HertzStudio Music Player
            </span>
            <span
              className={`hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono-tabular ${
                isDark
                  ? 'bg-white/6 text-zinc-400'
                  : 'bg-black/6 text-zinc-600'
              }`}
            >
              v2.5 Hi-Fi Engine
            </span>
          </div>

          {/* Right Quick Prototype Controls & Native Window Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const next = !synthEnabled;
                setSynthEnabled(next);
                addToast(
                  next
                    ? '已开启 Web Audio 合成器环境试听音'
                    : '已关闭 Web Audio 合成器试听音'
                );
              }}
              className={`px-2 py-0.5 rounded text-[11px] inline-flex items-center gap-1 border transition-colors ${
                synthEnabled
                  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                  : isDark
                  ? 'bg-white/5 border-white/10 text-zinc-400 hover:text-white'
                  : 'bg-black/5 border-black/10 text-zinc-600 hover:text-black'
              }`}
              title="开启后将通过浏览器原生音频合成器发出柔和的试听弦音"
            >
              <Volume2 className="w-3 h-3" />
              <span>{synthEnabled ? '合成音效: 开' : '合成音效: 关'}</span>
            </button>

            <button
              onClick={() => {
                const next = !narrowWindowPreview;
                setNarrowWindowPreview(next);
                addToast(
                  next
                    ? '已切换至窄窗口模式（侧栏自动折叠为图标栏）'
                    : '已恢复标准桌面宽屏窗口模式'
                );
              }}
              className={`px-2 py-0.5 rounded text-[11px] inline-flex items-center gap-1 border transition-colors ${
                narrowWindowPreview
                  ? 'bg-indigo-500/25 border-indigo-400/50 text-indigo-300'
                  : isDark
                  ? 'bg-white/5 border-white/10 text-zinc-400 hover:text-white'
                  : 'bg-black/5 border-black/10 text-zinc-600 hover:text-black'
              }`}
              title="一键测试窄窗口下的侧边栏折叠与自适应布局"
            >
              <Monitor className="w-3 h-3" />
              <span>{narrowWindowPreview ? '窄窗口预览中' : '窄窗口测试'}</span>
            </button>

            <div className="h-3 w-px bg-current/15 mx-1" />

            <div className="flex items-center gap-1 opacity-70">
              <button
                onClick={() => addToast('窗口最小化（桌面原型演示）')}
                className="p-1 rounded hover:bg-current/10"
                title="最小化"
              >
                <Minimize2 className="w-3 h-3" />
              </button>
              <button
                onClick={() => setNarrowWindowPreview((v) => !v)}
                className="p-1 rounded hover:bg-current/10"
                title="切换窗口尺寸"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
              <button
                onClick={() => addToast('感谢体验 HertzStudio 高保真桌面原型')}
                className="p-1 rounded hover:bg-rose-500 hover:text-white"
                title="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </header>

        {/* =========================================================
            2. MIDDLE WORKSPACE: SIDEBAR + MAIN STAGE
           ========================================================= */}
        <div className="relative flex-1 flex overflow-hidden">
          {/* Dynamic Cover Ambient Glow behind Stage */}
          {ambientEnabled && (
            <div
              className="pointer-events-none absolute inset-0 overflow-hidden z-0 transition-opacity duration-700"
              style={{ opacity: mainAmbientOpacity }}
            >
              <div
                className={`absolute -top-28 left-1/4 w-[500px] h-[500px] rounded-full blur-[130px] ${
                  slowDrift && !reduceMotion ? 'animate-ambient-drift' : ''
                }`}
                style={{ background: currentTrack.accentColor }}
              />
              <div
                className={`absolute bottom-0 right-10 w-[440px] h-[440px] rounded-full blur-[140px] ${
                  slowDrift && !reduceMotion ? 'animate-ambient-drift' : ''
                }`}
                style={{
                  background: currentTrack.secondaryColor,
                  animationDelay: '-8s',
                }}
              />
            </div>
          )}

          {/* ---------------------------------------------------------
              LEFT SIDEBAR NAVIGATION (236px expanded / 68px collapsed)
             --------------------------------------------------------- */}
          <aside
            className={`relative z-20 flex flex-col justify-between border-r shrink-0 transition-all duration-200 ${
              isSidebarCompact ? 'w-[68px] px-2' : 'w-[232px] px-3.5'
            } ${
              isDark
                ? 'bg-[#08090C]/90 border-white/7'
                : 'bg-[#EFECE6]/90 border-black/8'
            }`}
          >
            {/* Top Brand & Nav List */}
            <div className="flex-1 overflow-y-auto py-4 space-y-5 no-scrollbar">
              {/* Brand Header: Waveform + HertzStudio Serif */}
              <div
                onClick={() => setActiveNav('home')}
                className={`flex items-center gap-3 cursor-pointer px-2 ${
                  isSidebarCompact ? 'justify-center' : ''
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-full border flex items-center justify-center shrink-0 shadow-inner ${
                    isDark
                      ? 'bg-white/[0.04] border-white/15 text-white'
                      : 'bg-white border-black/15 text-zinc-900'
                  }`}
                >
                  <div className="flex items-center gap-0.5 h-3.5">
                    <span className="w-0.5 h-2 bg-current rounded-full" />
                    <span className="w-0.5 h-3.5 bg-current rounded-full" />
                    <span className="w-0.5 h-1.5 bg-current rounded-full" />
                    <span className="w-0.5 h-2.5 bg-current rounded-full" />
                  </div>
                </div>
                {!isSidebarCompact && (
                  <span className="font-display-serif text-[26px] tracking-tight leading-none">
                    HertzStudio
                  </span>
                )}
              </div>

              {/* Primary Navigation Items matching Screenshots */}
              <nav className="space-y-1">
                {(
                  [
                    { key: 'home', label: '首页', icon: Home },
                    { key: 'library', label: '曲库', icon: Library },
                    { key: 'online', label: '在线', icon: Globe },
                    { key: 'daily', label: '每日推荐', icon: Calendar },
                    { key: 'playlists', label: '歌单', icon: ListMusic },
                  ] as const
                ).map((item) => {
                  const Icon = item.icon;
                  const isActive = activeNav === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => setActiveNav(item.key)}
                      title={isSidebarCompact ? item.label : undefined}
                      className={`w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all ${
                        isSidebarCompact ? 'justify-center px-0' : ''
                      } ${
                        isActive
                          ? isDark
                            ? 'bg-white/[0.09] text-white font-semibold shadow-2xs'
                            : 'bg-zinc-900 text-white font-semibold shadow-xs'
                          : isDark
                          ? 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                          : 'text-zinc-600 hover:text-zinc-950 hover:bg-black/[0.04]'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      {!isSidebarCompact && <span>{item.label}</span>}
                    </button>
                  );
                })}

                {/* Queue Drawer Trigger in Sidebar with Badge (Screenshot: 队列 30) */}
                <button
                  onClick={() => setIsQueueOpen(true)}
                  title={isSidebarCompact ? `队列 (${queue.length})` : undefined}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all ${
                    isSidebarCompact ? 'justify-center px-0' : ''
                  } ${
                    isQueueOpen
                      ? isDark
                        ? 'bg-indigo-500/20 text-indigo-200'
                        : 'bg-indigo-100 text-indigo-900'
                      : isDark
                      ? 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                      : 'text-zinc-600 hover:text-zinc-950 hover:bg-black/[0.04]'
                  }`}
                >
                  <span className="flex items-center gap-3.5">
                    <List className="w-4 h-4 shrink-0" />
                    {!isSidebarCompact && <span>队列</span>}
                  </span>
                  {!isSidebarCompact && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-mono-tabular font-semibold ${
                        isDark
                          ? 'bg-white/15 text-zinc-200'
                          : 'bg-black/10 text-zinc-800'
                      }`}
                    >
                      {queue.length}
                    </span>
                  )}
                </button>

                {/* Favorites (收藏 with Red Heart) */}
                <button
                  onClick={() => setActiveNav('favorites')}
                  title={isSidebarCompact ? '收藏' : undefined}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all ${
                    isSidebarCompact ? 'justify-center px-0' : ''
                  } ${
                    activeNav === 'favorites'
                      ? isDark
                        ? 'bg-white/[0.09] text-white font-semibold'
                        : 'bg-zinc-900 text-white font-semibold'
                      : isDark
                      ? 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                      : 'text-zinc-600 hover:text-zinc-950 hover:bg-black/[0.04]'
                  }`}
                >
                  <span className="flex items-center gap-3.5">
                    <Heart className="w-4 h-4 fill-rose-500 text-rose-500 shrink-0" />
                    {!isSidebarCompact && <span>收藏</span>}
                  </span>
                  {!isSidebarCompact && (
                    <span className="text-[11px] font-mono-tabular opacity-50">
                      {tracks.filter((t) => t.liked).length}
                    </span>
                  )}
                </button>

                {/* Settings (设置) */}
                <button
                  onClick={() => setActiveNav('settings')}
                  title={isSidebarCompact ? '设置' : undefined}
                  className={`w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all ${
                    isSidebarCompact ? 'justify-center px-0' : ''
                  } ${
                    activeNav === 'settings'
                      ? isDark
                        ? 'bg-white/[0.09] text-white font-semibold'
                        : 'bg-zinc-900 text-white font-semibold'
                      : isDark
                      ? 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                      : 'text-zinc-600 hover:text-zinc-950 hover:bg-black/[0.04]'
                  }`}
                >
                  <Settings className="w-4 h-4 shrink-0" />
                  {!isSidebarCompact && <span>设置</span>}
                </button>

                {/* Collapsible More Features (更多功能: 播客 / 一起听 / 阅读) */}
                <div className="pt-1">
                  <button
                    onClick={() => setMoreExpanded((v) => !v)}
                    title={isSidebarCompact ? '更多功能' : undefined}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all ${
                      isSidebarCompact ? 'justify-center px-0' : ''
                    } ${
                      isDark
                        ? 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                        : 'text-zinc-600 hover:text-zinc-950 hover:bg-black/[0.04]'
                    }`}
                  >
                    <span className="flex items-center gap-3.5">
                      <LayoutGrid className="w-4 h-4 shrink-0" />
                      {!isSidebarCompact && <span>更多功能</span>}
                    </span>
                    {!isSidebarCompact &&
                      (moreExpanded ? (
                        <ChevronUp className="w-3.5 h-3.5 opacity-60" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 opacity-60" />
                      ))}
                  </button>

                  {moreExpanded && (
                    <div className="mt-1 space-y-1">
                      {(
                        [
                          { key: 'podcast', label: '播客', icon: Headphones },
                          { key: 'together', label: '一起听', icon: Users },
                          { key: 'reading', label: '阅读', icon: BookOpen },
                        ] as const
                      ).map((sub) => {
                        const SubIcon = sub.icon;
                        const isActive = activeNav === sub.key;
                        return (
                          <button
                            key={sub.key}
                            onClick={() => setActiveNav(sub.key)}
                            title={isSidebarCompact ? sub.label : undefined}
                            className={`w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all ${
                              isSidebarCompact ? 'justify-center px-0' : ''
                            } ${
                              isActive
                                ? isDark
                                  ? 'bg-white/[0.09] text-white font-semibold'
                                  : 'bg-zinc-900 text-white font-semibold'
                                : isDark
                                ? 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                                : 'text-zinc-600 hover:text-zinc-950 hover:bg-black/[0.04]'
                            }`}
                          >
                            <SubIcon className="w-4 h-4 shrink-0" />
                            {!isSidebarCompact && <span>{sub.label}</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </nav>
            </div>

            {/* Bottom Listening Mode Switcher (聆听方式: 日常 | 沉浸) */}
            <div
              className={`py-3 border-t ${
                isDark ? 'border-white/7' : 'border-black/8'
              }`}
            >
              {!isSidebarCompact ? (
                <div>
                  <div className="text-[11px] opacity-50 mb-2 px-1">
                    聆听方式
                  </div>
                  <div
                    className={`p-1 rounded-full border grid grid-cols-2 ${
                      isDark
                        ? 'bg-white/[0.03] border-white/8'
                        : 'bg-black/[0.04] border-black/8'
                    }`}
                  >
                    <button
                      onClick={() => setIsImmersiveOpen(false)}
                      className={`py-1.5 rounded-full text-xs font-semibold transition-all ${
                        !isImmersiveOpen
                          ? isDark
                            ? 'bg-white text-zinc-950 shadow-xs'
                            : 'bg-zinc-900 text-white shadow-xs'
                          : 'opacity-65 hover:opacity-100'
                      }`}
                    >
                      日常
                    </button>
                    <button
                      onClick={() => setIsImmersiveOpen(true)}
                      className={`py-1.5 rounded-full text-xs font-semibold transition-all ${
                        isImmersiveOpen
                          ? isDark
                            ? 'bg-white text-zinc-950 shadow-xs'
                            : 'bg-zinc-900 text-white shadow-xs'
                          : 'opacity-65 hover:opacity-100'
                      }`}
                    >
                      沉浸
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setIsImmersiveOpen((v) => !v)}
                  title="切换日常 / 沉浸歌词模式"
                  className={`w-full py-2 rounded-xl flex items-center justify-center ${
                    isDark ? 'bg-white/8 hover:bg-white/15' : 'bg-black/8'
                  }`}
                >
                  <Sparkles className="w-4 h-4 text-indigo-400" />
                </button>
              )}
            </div>
          </aside>

          {/* ---------------------------------------------------------
              RIGHT MAIN STAGE AREA
             --------------------------------------------------------- */}
          <main className="relative z-10 flex-1 flex flex-col overflow-hidden">
            {/* Top Utility & Global Search Bar (Hidden only when inside full Listen Together header if desired, but keeping it accessible everywhere is even better!) */}
            <div
              className={`h-16 px-6 flex items-center justify-between gap-4 shrink-0 border-b ${
                isDark ? 'border-white/5' : 'border-black/6'
              }`}
            >
              {/* Left: Sidebar Toggle + Search Input */}
              <div className="flex items-center gap-3 flex-1 max-w-xl">
                <button
                  onClick={() => {
                    setSidebarCollapsed((prev) => !prev);
                    if (narrowWindowPreview) setNarrowWindowPreview(false);
                  }}
                  title="折叠 / 展开侧边栏"
                  className={`w-9 h-9 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                    isDark
                      ? 'bg-white/[0.04] border-white/10 hover:bg-white/10 text-zinc-200'
                      : 'bg-white border-black/10 hover:bg-black/5 text-zinc-800'
                  }`}
                >
                  <Menu className="w-4 h-4" />
                </button>

                <div className="relative flex-1">
                  <Search className="w-4 h-4 opacity-45 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={globalSearch}
                    onChange={(e) => {
                      setGlobalSearch(e.target.value);
                      if (
                        activeNav === 'home' ||
                        activeNav === 'settings' ||
                        activeNav === 'together'
                      ) {
                        setActiveNav('library');
                      }
                    }}
                    placeholder="搜索在线歌曲、本地曲库、专辑或艺术家..."
                    className={`w-full h-9 pl-10 pr-16 rounded-full border text-xs transition-all ${
                      isDark
                        ? 'bg-white/[0.04] border-white/10 text-zinc-100 placeholder:text-zinc-500 focus:bg-white/[0.07] focus:border-indigo-500/50'
                        : 'bg-white border-black/10 text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500'
                    }`}
                  />
                  {globalSearch ? (
                    <button
                      onClick={() => setGlobalSearch('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] opacity-60 hover:opacity-100"
                    >
                      清空
                    </button>
                  ) : (
                    <kbd
                      className={`hidden sm:inline-block absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded text-[10px] font-mono-tabular opacity-50 border ${
                        isDark ? 'border-white/15' : 'border-black/15'
                      }`}
                    >
                      ⌘K
                    </kbd>
                  )}
                </div>
              </div>

              {/* Right: View Mode Switch (列表 | 封面) + Theme Toggle + Queue + Shortcuts + Avatar */}
              <div className="flex items-center gap-2.5">
                {/* Segmented Pill: 列表 | 封面 */}
                <div
                  className={`p-1 rounded-full border flex items-center ${
                    isDark
                      ? 'bg-white/[0.04] border-white/10'
                      : 'bg-black/[0.04] border-black/10'
                  }`}
                >
                  <button
                    onClick={() => setViewMode('list')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                      viewMode === 'list'
                        ? isDark
                          ? 'bg-white text-zinc-950 shadow-xs'
                          : 'bg-zinc-900 text-white shadow-xs'
                        : 'opacity-65 hover:opacity-100'
                    }`}
                  >
                    <List className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">列表</span>
                  </button>
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                      viewMode === 'grid'
                        ? isDark
                          ? 'bg-white text-zinc-950 shadow-xs'
                          : 'bg-zinc-900 text-white shadow-xs'
                        : 'opacity-65 hover:opacity-100'
                    }`}
                  >
                    <Grid className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">封面</span>
                  </button>
                </div>

                {/* Theme Switcher Button (Sun/Moon) */}
                <button
                  onClick={() => {
                    const next = !isDark;
                    setIsDark(next);
                    addToast(
                      next
                        ? '已切换为「夜色」深色外观'
                        : '已切换为「暖白」浅色外观'
                    );
                  }}
                  title={isDark ? '切换为暖白浅色主题' : '切换为夜色深色主题'}
                  className={`w-9 h-9 rounded-full border flex items-center justify-center transition-colors ${
                    isDark
                      ? 'bg-white/[0.04] border-white/10 hover:bg-white/10 text-zinc-200'
                      : 'bg-white border-black/10 hover:bg-black/5 text-zinc-800'
                  }`}
                >
                  {isDark ? (
                    <Sun className="w-4 h-4" />
                  ) : (
                    <Moon className="w-4 h-4" />
                  )}
                </button>

                {/* Queue Drawer Toggle Button */}
                <button
                  onClick={() => setIsQueueOpen((v) => !v)}
                  title="打开/关闭播放队列抽屉"
                  className={`relative w-9 h-9 rounded-full border flex items-center justify-center transition-colors ${
                    isQueueOpen
                      ? 'bg-indigo-500 text-white border-indigo-400'
                      : isDark
                      ? 'bg-white/[0.04] border-white/10 hover:bg-white/10 text-zinc-200'
                      : 'bg-white border-black/10 hover:bg-black/5 text-zinc-800'
                  }`}
                >
                  <ListMusic className="w-4 h-4" />
                </button>

                {/* Shortcuts / More Help Button */}
                <button
                  onClick={() => setIsShortcutsOpen(true)}
                  title="查看键盘快捷键与交互说明"
                  className={`w-9 h-9 rounded-full border flex items-center justify-center transition-colors ${
                    isDark
                      ? 'bg-white/[0.04] border-white/10 hover:bg-white/10 text-zinc-200'
                      : 'bg-white border-black/10 hover:bg-black/5 text-zinc-800'
                  }`}
                >
                  <MoreVertical className="w-4 h-4" />
                </button>

                {/* User Avatar matching Screenshot top-right */}
                <div
                  onClick={() => setActiveNav('settings')}
                  title="Hertz 个人中心与设置"
                  className="w-8 h-8 rounded-full bg-gradient-to-tr from-amber-200 via-indigo-300 to-rose-300 p-0.5 cursor-pointer shrink-0 shadow-sm"
                >
                  <div className="w-full h-full rounded-full bg-zinc-900 flex items-center justify-center text-[11px] font-bold text-amber-200">
                    HZ
                  </div>
                </div>
              </div>
            </div>

            {/* ---------------------------------------------------------
                SCROLLABLE STAGE CONTENT BY ACTIVE VIEW
               --------------------------------------------------------- */}
            <div className="flex-1 overflow-y-auto px-6 sm:px-8 py-5">
              {/* =====================================================
                  VIEW A: 首页 (HOME VIEW - Screenshot 1)
                 ===================================================== */}
              {activeNav === 'home' && (
                <div className="space-y-7 pb-10">
                  {/* Collapsible Header: ▼ 继续聆听与快捷入口 */}
                  <div>
                    <button
                      onClick={() => setHomeHeroExpanded((v) => !v)}
                      className="inline-flex items-center gap-1.5 text-xs opacity-60 hover:opacity-100 transition-opacity mb-4"
                    >
                      <span>{homeHeroExpanded ? '▼' : '▶'}</span>
                      <span>继续聆听与快捷入口</span>
                    </button>

                    {homeHeroExpanded && (
                      <div className="space-y-6">
                        {/* Hero Continue Listening Section (Screenshot 1) */}
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-7 items-center">
                          {/* Left Large Bauhaus Cover Art (Teleman - Breakfast or active track) */}
                          <div className="lg:col-span-5 max-w-[350px] w-full mx-auto lg:mx-0">
                            <div
                              draggable
                              onDragStart={(e) =>
                                handleDragStartTrack(currentTrack, e)
                              }
                              onDragEnd={() => setIsDraggingTrack(false)}
                              onClick={() => handleTogglePlay()}
                              className="group relative aspect-square rounded-2xl overflow-hidden cursor-pointer shadow-2xl"
                            >
                              <CoverArt
                                styleType={currentTrack.coverStyle}
                                size="hero"
                                isPlaying={isPlaying}
                                className="w-full h-full rounded-2xl transition-transform duration-700 group-hover:scale-[1.02]"
                              />
                              <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <div className="w-14 h-14 rounded-full bg-white text-zinc-950 flex items-center justify-center shadow-2xl scale-95 group-hover:scale-100 transition-transform">
                                  {isPlaying ? (
                                    <Pause className="w-6 h-6 fill-current" />
                                  ) : (
                                    <Play className="w-6 h-6 fill-current ml-0.5" />
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Right Editorial Info + Poetic Quote (Screenshot 1) */}
                          <div className="lg:col-span-7 space-y-4">
                            <div className="inline-flex items-center gap-2 text-xs opacity-60">
                              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
                              <span>
                                接着上次的位置听 · {formatSeconds(currentTime)} /{' '}
                                {currentTrack.durationStr}
                              </span>
                            </div>

                            <div>
                              <h1
                                onClick={handleTogglePlay}
                                className="text-2xl sm:text-4xl font-bold tracking-tight cursor-pointer hover:text-indigo-400 transition-colors"
                              >
                                {currentTrack.title} - {currentTrack.artist}
                              </h1>
                              <p className="text-sm opacity-60 mt-1.5">
                                {currentTrack.artist} · 《{currentTrack.album}》·{' '}
                                <span className="font-mono-tabular">
                                  {currentTrack.quality}
                                </span>
                              </p>
                            </div>

                            {/* Poetic Quote Block */}
                            <div className="pt-2 space-y-3">
                              <p className="text-lg sm:text-[21px] font-semibold leading-relaxed tracking-wide">
                                {currentQuote.content}
                                <span className="text-sm font-normal opacity-55 ml-3">
                                  —— {currentQuote.source}
                                </span>
                              </p>

                              <div className="flex items-center gap-3 pt-1">
                                <button
                                  onClick={() =>
                                    setQuoteIndex(
                                      (prev) =>
                                        (prev + 1) % POETIC_QUOTES.length
                                    )
                                  }
                                  className={`px-3.5 py-1.5 rounded-full text-xs font-medium border transition-all active:scale-95 ${
                                    isDark
                                      ? 'bg-white/[0.04] border-white/12 hover:bg-white/10 text-zinc-200'
                                      : 'bg-white border-black/12 hover:bg-black/5 text-zinc-800'
                                  }`}
                                >
                                  换一条
                                </button>
                                <span className="text-xs font-mono-tabular opacity-55">
                                  {(quoteIndex % POETIC_QUOTES.length) + 1} /{' '}
                                  {POETIC_QUOTES.length}
                                </span>
                                <button
                                  onClick={() => setIsImmersiveOpen(true)}
                                  className="ml-2 text-xs text-indigo-400 hover:underline inline-flex items-center gap-1"
                                >
                                  <Sparkles className="w-3.5 h-3.5" />
                                  <span>进入沉浸歌词舞台</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* 3 Quick-Entry Bento Cards (Screenshot 1: 音乐库 / 每日推荐 / 最近播放) */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                          <button
                            onClick={() => {
                              setActiveNav('library');
                              setLibraryTab('歌曲');
                            }}
                            className={`p-5 rounded-2xl border text-left flex items-center gap-4 transition-all hover:-translate-y-0.5 ${
                              isDark
                                ? 'bg-white/[0.03] border-white/8 hover:bg-white/[0.06] hover:border-white/15'
                                : 'bg-white border-black/8 hover:shadow-md'
                            }`}
                          >
                            <div
                              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                                isDark
                                  ? 'bg-white/6 text-zinc-200'
                                  : 'bg-zinc-100 text-zinc-800'
                              }`}
                            >
                              <Library className="w-5 h-5" />
                            </div>
                            <div>
                              <div className="text-sm font-bold">音乐库</div>
                              <div className="text-xs opacity-55 mt-0.5">
                                浏览本地歌曲 ({tracks.length} 首)
                              </div>
                            </div>
                          </button>

                          <button
                            onClick={() => setActiveNav('daily')}
                            className={`p-5 rounded-2xl border text-left flex items-center gap-4 transition-all hover:-translate-y-0.5 ${
                              isDark
                                ? 'bg-white/[0.03] border-white/8 hover:bg-white/[0.06] hover:border-white/15'
                                : 'bg-white border-black/8 hover:shadow-md'
                            }`}
                          >
                            <div
                              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                                isDark
                                  ? 'bg-white/6 text-zinc-200'
                                  : 'bg-zinc-100 text-zinc-800'
                              }`}
                            >
                              <Calendar className="w-5 h-5" />
                            </div>
                            <div>
                              <div className="text-sm font-bold">每日推荐</div>
                              <div className="text-xs opacity-55 mt-0.5">
                                看看今天想听什么
                              </div>
                            </div>
                          </button>

                          <button
                            onClick={() => setIsQueueOpen(true)}
                            className={`p-5 rounded-2xl border text-left flex items-center gap-4 transition-all hover:-translate-y-0.5 ${
                              isDark
                                ? 'bg-white/[0.03] border-white/8 hover:bg-white/[0.06] hover:border-white/15'
                                : 'bg-white border-black/8 hover:shadow-md'
                            }`}
                          >
                            <div
                              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                                isDark
                                  ? 'bg-white/6 text-zinc-200'
                                  : 'bg-zinc-100 text-zinc-800'
                              }`}
                            >
                              <ListMusic className="w-5 h-5" />
                            </div>
                            <div>
                              <div className="text-sm font-bold">最近播放</div>
                              <div className="text-xs opacity-55 mt-0.5">
                                找回听过的歌曲
                              </div>
                            </div>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Recently Played Cover Carousel (Screenshot 1 bottom section) */}
                  <div className="space-y-3.5 pt-2">
                    <div className="flex items-center justify-between">
                      <h2 className="text-xs font-semibold opacity-65 tracking-wider">
                        最近播放
                      </h2>
                      <button
                        onClick={() => setActiveNav('library')}
                        className="text-xs opacity-60 hover:opacity-100 transition-opacity"
                      >
                        查看全部
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
                      {[
                        tracks[0], // Teleman - Breakfast
                        tracks[11], // Monochrome Tapes
                        tracks[8], // PolyGram 宝丽金88
                        tracks[9], // 童话镇Plus
                        tracks[10], // 万事
                      ]
                        .filter(Boolean)
                        .map((item) => {
                          const isCurrent = item.id === currentTrack.id;
                          return (
                            <div
                              key={item.id}
                              draggable
                              onDragStart={(e) => handleDragStartTrack(item, e)}
                              onDragEnd={() => setIsDraggingTrack(false)}
                              onClick={() => playTrackImmediately(item)}
                              onContextMenu={(e) =>
                                handleTrackContextMenu(item, e)
                              }
                              className="group cursor-pointer space-y-2"
                            >
                              <div className="relative aspect-square rounded-2xl overflow-hidden shadow-lg">
                                <CoverArt
                                  styleType={item.coverStyle}
                                  size="lg"
                                  isPlaying={isCurrent && isPlaying}
                                  className="w-full h-full rounded-2xl transition-transform duration-500 group-hover:scale-105"
                                />
                                <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                  <div className="w-11 h-11 rounded-full bg-white text-zinc-950 flex items-center justify-center shadow-xl">
                                    {isCurrent && isPlaying ? (
                                      <Pause className="w-5 h-5 fill-current" />
                                    ) : (
                                      <Play className="w-5 h-5 fill-current ml-0.5" />
                                    )}
                                  </div>
                                </div>
                              </div>
                              <div>
                                <div className="text-xs font-semibold truncate">
                                  {item.title}
                                </div>
                                <div className="text-[11px] opacity-55 truncate">
                                  {item.artist} · {item.album}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                </div>
              )}

              {/* =====================================================
                  VIEW B: 曲库 (LOCAL LIBRARY - Screenshot 4 + Albums/Artists/Playlists)
                 ===================================================== */}
              {activeNav === 'library' && (
                <div className="space-y-5 pb-12">
                  {/* Top Header & Filter Controls matching Screenshot 4 */}
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-baseline gap-3">
                      <h1 className="text-3xl font-bold tracking-tight">曲库</h1>
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-mono-tabular border ${
                          isDark
                            ? 'bg-white/[0.04] border-white/10 text-zinc-300'
                            : 'bg-black/[0.04] border-black/10 text-zinc-700'
                        }`}
                      >
                        共 {displayedTracks.length} 首
                      </span>
                    </div>

                    {/* Right Filter Pills (全部歌手 / 全部专辑 / 按标题 / 失效整理 / 音乐目录) */}
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={artistFilter}
                        onChange={(e) => setArtistFilter(e.target.value)}
                        className={`h-8 px-3 rounded-full border text-xs cursor-pointer ${
                          isDark
                            ? 'bg-white/[0.04] border-white/10 text-zinc-200'
                            : 'bg-white border-black/10 text-zinc-800'
                        }`}
                      >
                        <option value="all">全部歌手</option>
                        {uniqueArtists.map((art) => (
                          <option key={art} value={art}>
                            {art}
                          </option>
                        ))}
                      </select>

                      <select
                        value={albumFilter}
                        onChange={(e) => setAlbumFilter(e.target.value)}
                        className={`h-8 px-3 rounded-full border text-xs cursor-pointer ${
                          isDark
                            ? 'bg-white/[0.04] border-white/10 text-zinc-200'
                            : 'bg-white border-black/10 text-zinc-800'
                        }`}
                      >
                        <option value="all">全部专辑</option>
                        {uniqueAlbums.map((alb) => (
                          <option key={alb} value={alb}>
                            {alb}
                          </option>
                        ))}
                      </select>

                      <select
                        value={sortBy}
                        onChange={(e) =>
                          setSortBy(
                            e.target.value as 'title' | 'duration' | 'quality'
                          )
                        }
                        className={`h-8 px-3 rounded-full border text-xs cursor-pointer ${
                          isDark
                            ? 'bg-white/[0.04] border-white/10 text-zinc-200'
                            : 'bg-white border-black/10 text-zinc-800'
                        }`}
                      >
                        <option value="title">按标题</option>
                        <option value="duration">按时长</option>
                        <option value="quality">按音质采样率</option>
                      </select>

                      <button
                        onClick={() =>
                          addToast('已完成曲库失效路径扫描：全部 14 首音频路径完整有效')
                        }
                        className={`h-8 px-3.5 rounded-full border text-xs inline-flex items-center gap-1.5 transition-colors ${
                          isDark
                            ? 'bg-white/[0.04] border-white/10 hover:bg-white/10 text-zinc-200'
                            : 'bg-white border-black/10 hover:bg-black/5 text-zinc-800'
                        }`}
                      >
                        <Wrench className="w-3 h-3 opacity-70" />
                        <span>失效整理</span>
                      </button>

                      <button
                        onClick={() => setIsFoldersOpen(true)}
                        className={`h-8 px-3.5 rounded-full border text-xs inline-flex items-center gap-1.5 transition-colors ${
                          isDark
                            ? 'bg-white/[0.04] border-white/10 hover:bg-white/10 text-zinc-200'
                            : 'bg-white border-black/10 hover:bg-black/5 text-zinc-800'
                        }`}
                      >
                        <FolderOpen className="w-3 h-3 opacity-70" />
                        <span>音乐目录</span>
                      </button>
                    </div>
                  </div>

                  {/* Sub-Navigation Tabs: 歌曲 | 专辑 | 歌手 | 歌单 (Screenshot 4) */}
                  <div
                    className={`flex items-center gap-6 border-b ${
                      isDark ? 'border-white/8' : 'border-black/8'
                    }`}
                  >
                    {(['歌曲', '专辑', '歌手', '歌单'] as LibrarySubTab[]).map(
                      (tab) => {
                        const isActive = libraryTab === tab;
                        return (
                          <button
                            key={tab}
                            onClick={() => setLibraryTab(tab)}
                            className={`relative pb-3 text-xs sm:text-sm font-medium transition-colors ${
                              isActive
                                ? isDark
                                  ? 'text-white font-semibold'
                                  : 'text-zinc-950 font-semibold'
                                : 'opacity-55 hover:opacity-90'
                            }`}
                          >
                            {tab}
                            {isActive && (
                              <span
                                className={`absolute bottom-0 inset-x-0 h-0.5 rounded-full ${
                                  isDark ? 'bg-white' : 'bg-zinc-950'
                                }`}
                              />
                            )}
                          </button>
                        );
                      }
                    )}
                  </div>

                  {/* TAB 1: 歌曲 (Songs Table / Grid) */}
                  {libraryTab === '歌曲' && (
                    <div className="space-y-4">
                      {/* Action Buttons Row: ▶ 播放全部 | 🔀 随机播放 | 多选提示 */}
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                        <div className="flex items-center gap-2.5">
                          <button
                            onClick={() => {
                              if (displayedTracks.length === 0) return;
                              setQueue(displayedTracks);
                              playTrackImmediately(displayedTracks[0]);
                            }}
                            className={`h-9 px-5 rounded-full text-xs font-semibold inline-flex items-center gap-2 transition-transform active:scale-95 ${
                              isDark
                                ? 'bg-white text-zinc-950 hover:bg-zinc-200'
                                : 'bg-zinc-900 text-white hover:bg-zinc-800'
                            }`}
                          >
                            <Play className="w-3.5 h-3.5 fill-current" />
                            <span>播放全部</span>
                          </button>

                          <button
                            onClick={() => {
                              if (displayedTracks.length === 0) return;
                              const shuffled = [...displayedTracks].sort(
                                () => Math.random() - 0.5
                              );
                              setQueue(shuffled);
                              setPlayMode('shuffle');
                              playTrackImmediately(shuffled[0]);
                            }}
                            className={`h-9 px-4 rounded-full border text-xs font-medium inline-flex items-center gap-2 transition-colors ${
                              isDark
                                ? 'bg-white/[0.04] border-white/10 hover:bg-white/10 text-zinc-200'
                                : 'bg-white border-black/10 hover:bg-black/5 text-zinc-800'
                            }`}
                          >
                            <Shuffle className="w-3.5 h-3.5" />
                            <span>随机播放</span>
                          </button>

                          {(artistFilter !== 'all' ||
                            albumFilter !== 'all' ||
                            globalSearch) && (
                            <button
                              onClick={() => {
                                setArtistFilter('all');
                                setAlbumFilter('all');
                                setGlobalSearch('');
                              }}
                              className="text-xs text-indigo-400 hover:underline px-2"
                            >
                              清除筛选条件
                            </button>
                          )}
                        </div>

                        <div className="text-[11px] opacity-50 hidden md:block">
                          支持 Ctrl+点击多选 · 右键呼出菜单 · 按住曲目拖拽至右侧队列
                        </div>
                      </div>

                      <TrackList
                        tracks={displayedTracks}
                        currentTrack={currentTrack}
                        isPlaying={isPlaying}
                        isDark={isDark}
                        viewMode={viewMode}
                        selectedIds={selectedIds}
                        multiSelectMode={multiSelectMode}
                        onTrackClick={handleTrackClick}
                        onTrackContextMenu={handleTrackContextMenu}
                        onToggleLike={handleToggleLike}
                        onDragStartTrack={handleDragStartTrack}
                        onDragEndTrack={() => setIsDraggingTrack(false)}
                        onBatchPlay={handleBatchPlay}
                        onBatchAddToQueue={handleBatchAddToQueue}
                        onBatchLike={handleBatchLike}
                        onClearSelection={() => {
                          setSelectedIds(new Set());
                          setMultiSelectMode(false);
                        }}
                        onToggleMultiSelectMode={() =>
                          setMultiSelectMode((v) => !v)
                        }
                        onSelectAll={() =>
                          setSelectedIds(
                            new Set(displayedTracks.map((t) => t.id))
                          )
                        }
                        onResetFilters={() => {
                          setArtistFilter('all');
                          setAlbumFilter('all');
                          setGlobalSearch('');
                        }}
                      />

                      {/* Screenshot 4 Bottom Daily Recommendation Aggregation Banner */}
                      <div
                        className={`mt-8 rounded-2xl border p-5 transition-all ${
                          isDark
                            ? 'bg-white/[0.025] border-white/8'
                            : 'bg-white border-black/8 shadow-xs'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] opacity-55">每日推荐</div>
                            <div className="text-lg font-bold font-mono-tabular mt-0.5">
                              2026-11-25
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <div
                              className={`p-0.5 rounded-full border flex items-center text-xs ${
                                isDark
                                  ? 'bg-white/[0.04] border-white/10'
                                  : 'bg-black/[0.04] border-black/10'
                              }`}
                            >
                              <button
                                onClick={() => setDailySourceMode('online')}
                                className={`px-3 py-1 rounded-full font-medium transition-colors ${
                                  dailySourceMode === 'online'
                                    ? isDark
                                      ? 'bg-white/15 text-white'
                                      : 'bg-zinc-900 text-white'
                                    : 'opacity-60'
                                }`}
                              >
                                在线
                              </button>
                              <button
                                onClick={() => setDailySourceMode('local')}
                                className={`px-3 py-1 rounded-full font-medium transition-colors ${
                                  dailySourceMode === 'local'
                                    ? isDark
                                      ? 'bg-white/15 text-white'
                                      : 'bg-zinc-900 text-white'
                                    : 'opacity-60'
                                }`}
                              >
                                本地
                              </button>
                            </div>

                            <button
                              onClick={() => {
                                setQueue(tracks);
                                playTrackImmediately(tracks[0]);
                              }}
                              className={`px-4 py-1.5 rounded-full text-xs font-semibold ${
                                isDark
                                  ? 'bg-white text-zinc-950 hover:bg-zinc-200'
                                  : 'bg-zinc-900 text-white'
                              }`}
                            >
                              播放全部
                            </button>

                            <button
                              onClick={() =>
                                addToast(
                                  '已刷新今日多音源聚合推荐（网易云 30 首 + QQ音乐 20 首）'
                                )
                              }
                              className={`px-3.5 py-1.5 rounded-full border text-xs ${
                                isDark
                                  ? 'border-white/12 hover:bg-white/8'
                                  : 'border-black/12 hover:bg-black/5'
                              }`}
                            >
                              刷新
                            </button>

                            <button
                              onClick={() => setDailyBannerOpen((v) => !v)}
                              className={`p-1.5 rounded-full border ${
                                isDark ? 'border-white/12' : 'border-black/12'
                              }`}
                            >
                              {dailyBannerOpen ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>

                        {dailyBannerOpen && (
                          <p className="text-xs opacity-55 mt-2.5 leading-relaxed">
                            已合并 24 首 · 网易云音乐 30 首、QQ音乐 20 首 · 已跳过：酷狗音乐（该音源没有每日推荐歌曲接口）、酷我音乐（该音源没有每日推荐歌曲接口）、CCmixter · CC 授权曲库、汽水音乐、咪咕音乐。
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* TAB 2: 专辑 (Albums Grid View) */}
                  {libraryTab === '专辑' && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5 pt-2">
                      {MOCK_ALBUMS.map((alb) => (
                        <div
                          key={alb.id}
                          onClick={() => {
                            setAlbumFilter(alb.title);
                            setLibraryTab('歌曲');
                            addToast(`已筛选专辑《${alb.title}》`);
                          }}
                          className={`group rounded-2xl p-3.5 border cursor-pointer transition-all hover:-translate-y-1 ${
                            isDark
                              ? 'bg-white/[0.025] border-white/8 hover:bg-white/[0.05] hover:border-white/15'
                              : 'bg-white border-black/8 hover:shadow-lg'
                          }`}
                        >
                          <div className="relative aspect-square rounded-xl overflow-hidden mb-3">
                            <CoverArt
                              styleType={alb.coverStyle}
                              size="lg"
                              className="w-full h-full rounded-xl transition-transform duration-500 group-hover:scale-105"
                            />
                            <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-md text-[10px] font-mono-tabular text-amber-200">
                              {alb.qualityBadge}
                            </span>
                            <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <div className="w-11 h-11 rounded-full bg-white text-zinc-950 flex items-center justify-center shadow-lg">
                                <Disc className="w-5 h-5" />
                              </div>
                            </div>
                          </div>
                          <h3 className="text-sm font-bold truncate">
                            {alb.title}
                          </h3>
                          <div className="text-xs opacity-60 truncate mt-0.5">
                            {alb.artist} · {alb.year}
                          </div>
                          <p className="text-[11px] opacity-50 line-clamp-2 mt-2 leading-relaxed">
                            {alb.description}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* TAB 3: 歌手 (Artists View) */}
                  {libraryTab === '歌手' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
                      {MOCK_ARTISTS.map((art) => (
                        <div
                          key={art.id}
                          onClick={() => {
                            setArtistFilter(art.name.split(' ')[0]);
                            setLibraryTab('歌曲');
                            addToast(`已筛选艺术家：${art.name}`);
                          }}
                          className={`p-4 rounded-2xl border cursor-pointer flex items-start gap-4 transition-all hover:-translate-y-0.5 ${
                            isDark
                              ? 'bg-white/[0.025] border-white/8 hover:bg-white/[0.05]'
                              : 'bg-white border-black/8 hover:shadow-md'
                          }`}
                        >
                          <CoverArt
                            styleType={art.coverStyle}
                            size="md"
                            className="w-16 h-16 rounded-full shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <h3 className="text-sm font-bold truncate">
                                {art.name}
                              </h3>
                              <Mic2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                            </div>
                            <div className="text-[11px] opacity-55 mt-0.5">
                              {art.genre} · {art.albumCount} 张专辑 ·{' '}
                              {art.trackCount} 首曲目
                            </div>
                            <p className="text-xs opacity-70 line-clamp-2 mt-2 leading-relaxed">
                              {art.bio}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* TAB 4: 歌单 (Playlists inside Library) */}
                  {libraryTab === '歌单' && (
                    <div className="space-y-4 pt-2">
                      <div className="flex justify-end">
                        <button
                          onClick={() => setIsCreatePlaylistOpen(true)}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-400"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>新建歌单</span>
                        </button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {playlists.map((pl) => (
                          <div
                            key={pl.id}
                            onClick={() => {
                              setActivePlaylistId(pl.id);
                              setActiveNav('playlists');
                            }}
                            className={`p-4 rounded-2xl border cursor-pointer transition-all hover:-translate-y-0.5 ${
                              isDark
                                ? 'bg-white/[0.025] border-white/8 hover:bg-white/[0.05]'
                                : 'bg-white border-black/8 hover:shadow-md'
                            }`}
                          >
                            <div className="flex items-center gap-3.5">
                              <CoverArt
                                styleType={pl.coverStyle}
                                size="md"
                                className="w-16 h-16 rounded-xl shrink-0"
                              />
                              <div className="min-w-0">
                                <h3 className="text-sm font-bold truncate">
                                  {pl.name}
                                </h3>
                                <div className="text-xs opacity-55 mt-0.5">
                                  {pl.trackIds.length} 首曲目 · {pl.creator}
                                </div>
                              </div>
                            </div>
                            <p className="text-xs opacity-65 mt-3 line-clamp-2">
                              {pl.description}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* =====================================================
                  VIEW C: 在线曲库 (ONLINE LIBRARY - Screenshot 3)
                 ===================================================== */}
              {activeNav === 'online' && (
                <div className="space-y-5 pb-12">
                  {/* Top Header Row matching Screenshot 3 */}
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-baseline gap-3">
                      <h1 className="text-3xl font-bold tracking-tight">
                        在线曲库
                      </h1>
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-mono-tabular border ${
                          isDark
                            ? 'bg-white/[0.04] border-white/10 text-zinc-300'
                            : 'bg-black/[0.04] border-black/10 text-zinc-700'
                        }`}
                      >
                        20 首已加载
                      </span>
                    </div>

                    <div className="flex items-center gap-2.5">
                      <select
                        value={onlineSource}
                        onChange={(e) => {
                          setOnlineSource(e.target.value);
                          addToast(`已切换在线音源至：${e.target.value}`);
                        }}
                        className={`h-9 px-3.5 rounded-xl border text-xs font-medium cursor-pointer ${
                          isDark
                            ? 'bg-white/[0.04] border-white/10 text-zinc-200'
                            : 'bg-white border-black/10 text-zinc-800'
                        }`}
                      >
                        <option value="网易云音乐">网易云音乐</option>
                        <option value="QQ音乐">QQ音乐</option>
                        <option value="Apple Music">Apple Music</option>
                        <option value="Tidal HiFi">Tidal HiFi</option>
                      </select>

                      <select
                        value={onlineQuality}
                        onChange={(e) => {
                          setOnlineQuality(e.target.value);
                          addToast(`在线解析音质已设为：${e.target.value}`);
                        }}
                        className={`h-9 px-3.5 rounded-xl border text-xs font-mono-tabular font-medium cursor-pointer ${
                          isDark
                            ? 'bg-white/[0.04] border-white/10 text-zinc-200'
                            : 'bg-white border-black/10 text-zinc-800'
                        }`}
                      >
                        <option value="Hi-Res">Hi-Res</option>
                        <option value="无损 FLAC">无损 FLAC</option>
                        <option value="320kbps">320kbps</option>
                      </select>
                    </div>
                  </div>

                  {/* Type Pills (单曲 | 歌单 | 歌手 | 专辑) + Search Bar (Screenshot 3) */}
                  <div className="flex flex-wrap items-center gap-2.5">
                    {(['单曲', '歌单', '歌手', '专辑'] as const).map((tp) => (
                      <button
                        key={tp}
                        onClick={() => setOnlineTypeTab(tp)}
                        className={`px-4 py-2 rounded-full text-xs font-medium border transition-all ${
                          onlineTypeTab === tp
                            ? isDark
                              ? 'bg-white/12 border-white/40 text-white font-semibold'
                              : 'bg-zinc-900 border-zinc-900 text-white font-semibold'
                            : isDark
                            ? 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-zinc-200'
                            : 'bg-white border-black/10 text-zinc-600'
                        }`}
                      >
                        {tp}
                      </button>
                    ))}

                    <input
                      type="text"
                      value={onlineSearch}
                      onChange={(e) => setOnlineSearch(e.target.value)}
                      placeholder="搜索在线音乐..."
                      className={`flex-1 min-w-[200px] h-10 px-4 rounded-xl border text-xs ${
                        isDark
                          ? 'bg-white/[0.04] border-white/10 text-zinc-100 placeholder:text-zinc-500'
                          : 'bg-white border-black/10 text-zinc-900 placeholder:text-zinc-400'
                      }`}
                    />

                    <button
                      onClick={() =>
                        addToast(
                          `已从 ${onlineSource} 检索 “${onlineSearch || onlineGenre}”`
                        )
                      }
                      className={`h-10 px-6 rounded-full text-xs font-semibold ${
                        isDark
                          ? 'bg-white text-zinc-950 hover:bg-zinc-200'
                          : 'bg-zinc-900 text-white hover:bg-zinc-800'
                      }`}
                    >
                      搜索
                    </button>
                  </div>

                  {/* 私人 FM Banner Card (Screenshot 3) */}
                  <div
                    className={`p-4 sm:p-5 rounded-2xl border flex items-center justify-between gap-4 ${
                      isDark
                        ? 'bg-white/[0.025] border-white/8'
                        : 'bg-white border-black/8 shadow-2xs'
                    }`}
                  >
                    <div>
                      <div className="flex items-baseline gap-2.5">
                        <span className="text-sm font-bold">私人 FM</span>
                        <span className="text-xs opacity-55">
                          {onlineSource} · 连续推荐
                        </span>
                      </div>
                      <p className="text-xs opacity-60 mt-1">
                        可尝试游客收听；推荐和播放范围由音源决定。
                      </p>
                    </div>

                    <button
                      onClick={() => {
                        const rand =
                          tracks[Math.floor(Math.random() * tracks.length)];
                        playTrackImmediately(rand);
                        addToast(`已开启私人 FM 电台：正在播放《${rand.title}》`);
                      }}
                      className={`px-4 py-2 rounded-full border text-xs font-medium inline-flex items-center gap-1.5 shrink-0 transition-colors ${
                        isDark
                          ? 'bg-white/[0.04] border-white/12 hover:bg-white/10 text-zinc-100'
                          : 'bg-zinc-50 border-black/12 hover:bg-zinc-100 text-zinc-900'
                      }`}
                    >
                      <Radio className="w-3.5 h-3.5 text-indigo-400" />
                      <span>开启 FM</span>
                    </button>
                  </div>

                  {/* Genre Filter Pills: 热门 | 新歌 | 摇滚 | 电子 | 民谣 | 爵士 | 古典 | ACG */}
                  <div className="flex flex-wrap items-center gap-2">
                    {[
                      '热门',
                      '新歌',
                      '摇滚',
                      '电子',
                      '民谣',
                      '爵士',
                      '古典',
                      'ACG',
                    ].map((g) => (
                      <button
                        key={g}
                        onClick={() => setOnlineGenre(g)}
                        className={`px-3.5 py-1.5 rounded-full text-xs font-medium border transition-all ${
                          onlineGenre === g
                            ? isDark
                              ? 'bg-white/12 border-white/40 text-white font-semibold'
                              : 'bg-zinc-900 border-zinc-900 text-white font-semibold'
                            : isDark
                            ? 'bg-white/[0.03] border-white/8 text-zinc-400 hover:text-zinc-200'
                            : 'bg-white border-black/10 text-zinc-600'
                        }`}
                      >
                        {g}
                      </button>
                    ))}
                  </div>

                  <div className="text-xs opacity-55">
                    {displayedTracks.length} 首已加载 · 1/1 个音源已响应
                  </div>

                  <TrackList
                    tracks={displayedTracks}
                    currentTrack={currentTrack}
                    isPlaying={isPlaying}
                    isDark={isDark}
                    viewMode={viewMode}
                    selectedIds={selectedIds}
                    multiSelectMode={multiSelectMode}
                    showSourceBadge={true}
                    onTrackClick={handleTrackClick}
                    onTrackContextMenu={handleTrackContextMenu}
                    onToggleLike={handleToggleLike}
                    onDragStartTrack={handleDragStartTrack}
                    onDragEndTrack={() => setIsDraggingTrack(false)}
                    onBatchPlay={handleBatchPlay}
                    onBatchAddToQueue={handleBatchAddToQueue}
                    onBatchLike={handleBatchLike}
                    onClearSelection={() => {
                      setSelectedIds(new Set());
                      setMultiSelectMode(false);
                    }}
                    onToggleMultiSelectMode={() =>
                      setMultiSelectMode((v) => !v)
                    }
                    onSelectAll={() =>
                      setSelectedIds(new Set(displayedTracks.map((t) => t.id)))
                    }
                    onResetFilters={() => {
                      setOnlineGenre('热门');
                      setOnlineSearch('');
                    }}
                  />
                </div>
              )}

              {/* =====================================================
                  VIEW D: 每日推荐 (DAILY RECOMMENDATIONS)
                 ===================================================== */}
              {activeNav === 'daily' && (
                <div className="space-y-6 pb-12">
                  <div
                    className={`p-6 rounded-2xl border ${
                      isDark
                        ? 'bg-gradient-to-r from-indigo-950/40 via-white/[0.02] to-white/[0.02] border-white/10'
                        : 'bg-gradient-to-r from-indigo-50 via-white to-white border-black/10'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <span className="text-xs text-indigo-400 font-semibold">
                          每日推荐 · 多音源智能聚合
                        </span>
                        <h1 className="text-3xl font-bold font-mono-tabular mt-1">
                          2026-11-25
                        </h1>
                        <p className="text-xs opacity-60 mt-2 max-w-2xl leading-relaxed">
                          已合并 {displayedTracks.length} 首 · 网易云音乐 30 首、QQ音乐 20 首 · 根据你的本地无损听歌偏好与最近播放《{currentTrack.title}》实时生成。
                        </p>
                      </div>

                      <div className="flex items-center gap-2.5">
                        <div
                          className={`p-1 rounded-full border flex items-center text-xs ${
                            isDark
                              ? 'bg-white/[0.04] border-white/10'
                              : 'bg-black/[0.04] border-black/10'
                          }`}
                        >
                          <button
                            onClick={() => setDailySourceMode('online')}
                            className={`px-3.5 py-1 rounded-full font-semibold ${
                              dailySourceMode === 'online'
                                ? isDark
                                  ? 'bg-white text-zinc-950'
                                  : 'bg-zinc-900 text-white'
                                : 'opacity-65'
                            }`}
                          >
                            在线 + 本地
                          </button>
                          <button
                            onClick={() => setDailySourceMode('local')}
                            className={`px-3.5 py-1 rounded-full font-semibold ${
                              dailySourceMode === 'local'
                                ? isDark
                                  ? 'bg-white text-zinc-950'
                                  : 'bg-zinc-900 text-white'
                                : 'opacity-65'
                            }`}
                          >
                            仅本地无损
                          </button>
                        </div>

                        <button
                          onClick={() => {
                            if (displayedTracks.length === 0) return;
                            setQueue(displayedTracks);
                            playTrackImmediately(displayedTracks[0]);
                          }}
                          className={`px-5 py-2 rounded-full text-xs font-semibold inline-flex items-center gap-1.5 ${
                            isDark
                              ? 'bg-white text-zinc-950 hover:bg-zinc-200'
                              : 'bg-zinc-900 text-white'
                          }`}
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>播放全部</span>
                        </button>

                        <button
                          onClick={() => {
                            setTracks((prev) => [...prev].reverse());
                            addToast('已刷新今日推荐序列');
                          }}
                          className={`p-2 rounded-full border ${
                            isDark
                              ? 'border-white/12 hover:bg-white/10'
                              : 'border-black/12 hover:bg-black/5'
                          }`}
                          title="刷新推荐"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <TrackList
                    tracks={displayedTracks}
                    currentTrack={currentTrack}
                    isPlaying={isPlaying}
                    isDark={isDark}
                    viewMode={viewMode}
                    selectedIds={selectedIds}
                    multiSelectMode={multiSelectMode}
                    showSourceBadge={true}
                    onTrackClick={handleTrackClick}
                    onTrackContextMenu={handleTrackContextMenu}
                    onToggleLike={handleToggleLike}
                    onDragStartTrack={handleDragStartTrack}
                    onDragEndTrack={() => setIsDraggingTrack(false)}
                    onBatchPlay={handleBatchPlay}
                    onBatchAddToQueue={handleBatchAddToQueue}
                    onBatchLike={handleBatchLike}
                    onClearSelection={() => {
                      setSelectedIds(new Set());
                      setMultiSelectMode(false);
                    }}
                    onToggleMultiSelectMode={() =>
                      setMultiSelectMode((v) => !v)
                    }
                    onSelectAll={() =>
                      setSelectedIds(new Set(displayedTracks.map((t) => t.id)))
                    }
                  />
                </div>
              )}

              {/* =====================================================
                  VIEW E: 歌单 (PLAYLISTS VIEW)
                 ===================================================== */}
              {activeNav === 'playlists' && (
                <div className="space-y-6 pb-12">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-2 overflow-x-auto pb-1">
                      {playlists.map((pl) => (
                        <button
                          key={pl.id}
                          onClick={() => setActivePlaylistId(pl.id)}
                          className={`px-4 py-2 rounded-full text-xs font-semibold border transition-all shrink-0 ${
                            activePlaylistId === pl.id
                              ? isDark
                                ? 'bg-white text-zinc-950 border-white'
                                : 'bg-zinc-900 text-white border-zinc-900'
                              : isDark
                              ? 'bg-white/[0.04] border-white/10 text-zinc-300 hover:bg-white/10'
                              : 'bg-white border-black/10 text-zinc-700'
                          }`}
                        >
                          {pl.name} ({pl.trackIds.length})
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={() => setIsCreatePlaylistOpen(true)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-400 shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>新建歌单</span>
                    </button>
                  </div>

                  {/* Active Playlist Header Card */}
                  {(() => {
                    const activePl =
                      playlists.find((p) => p.id === activePlaylistId) ||
                      playlists[0];
                    if (!activePl) return null;
                    return (
                      <div
                        className={`p-6 rounded-2xl border flex flex-col sm:flex-row items-start sm:items-center gap-6 ${
                          isDark
                            ? 'bg-white/[0.025] border-white/8'
                            : 'bg-white border-black/8'
                        }`}
                      >
                        <CoverArt
                          styleType={activePl.coverStyle}
                          size="lg"
                          className="w-28 h-28 rounded-2xl shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            {activePl.tags.map((tg) => (
                              <span
                                key={tg}
                                className="px-2 py-0.5 rounded text-[10px] font-mono-tabular bg-indigo-500/20 text-indigo-300"
                              >
                                #{tg}
                              </span>
                            ))}
                          </div>
                          <h2 className="text-2xl font-bold mt-2">
                            {activePl.name}
                          </h2>
                          <p className="text-xs opacity-65 mt-1.5 max-w-2xl">
                            {activePl.description}
                          </p>
                          <div className="mt-4 flex items-center gap-3">
                            <button
                              onClick={() => {
                                if (displayedTracks.length === 0) return;
                                setQueue(displayedTracks);
                                playTrackImmediately(displayedTracks[0]);
                              }}
                              className={`px-5 py-2 rounded-full text-xs font-semibold inline-flex items-center gap-1.5 ${
                                isDark
                                  ? 'bg-white text-zinc-950 hover:bg-zinc-200'
                                  : 'bg-zinc-900 text-white'
                              }`}
                            >
                              <Play className="w-3.5 h-3.5 fill-current" />
                              <span>播放歌单 ({displayedTracks.length})</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  <TrackList
                    tracks={displayedTracks}
                    currentTrack={currentTrack}
                    isPlaying={isPlaying}
                    isDark={isDark}
                    viewMode={viewMode}
                    selectedIds={selectedIds}
                    multiSelectMode={multiSelectMode}
                    emptyMessage="该歌单暂无歌曲"
                    emptySubMessage="可以在曲库中右键点击任意歌曲，选择「添加到歌单」"
                    onTrackClick={handleTrackClick}
                    onTrackContextMenu={handleTrackContextMenu}
                    onToggleLike={handleToggleLike}
                    onDragStartTrack={handleDragStartTrack}
                    onDragEndTrack={() => setIsDraggingTrack(false)}
                    onBatchPlay={handleBatchPlay}
                    onBatchAddToQueue={handleBatchAddToQueue}
                    onBatchLike={handleBatchLike}
                    onClearSelection={() => {
                      setSelectedIds(new Set());
                      setMultiSelectMode(false);
                    }}
                    onToggleMultiSelectMode={() =>
                      setMultiSelectMode((v) => !v)
                    }
                    onSelectAll={() =>
                      setSelectedIds(new Set(displayedTracks.map((t) => t.id)))
                    }
                  />
                </div>
              )}

              {/* =====================================================
                  VIEW F: 收藏 (FAVORITES VIEW)
                 ===================================================== */}
              {activeNav === 'favorites' && (
                <div className="space-y-5 pb-12">
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-3">
                      <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2.5">
                        <Heart className="w-7 h-7 fill-rose-500 text-rose-500" />
                        <span>我喜欢的音乐</span>
                      </h1>
                      <span className="text-xs font-mono-tabular opacity-60">
                        共 {displayedTracks.length} 首红心曲目
                      </span>
                    </div>

                    {displayedTracks.length > 0 && (
                      <button
                        onClick={() => {
                          setQueue(displayedTracks);
                          playTrackImmediately(displayedTracks[0]);
                        }}
                        className={`px-5 py-2 rounded-full text-xs font-semibold inline-flex items-center gap-1.5 ${
                          isDark
                            ? 'bg-white text-zinc-950 hover:bg-zinc-200'
                            : 'bg-zinc-900 text-white'
                        }`}
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>播放全部收藏</span>
                      </button>
                    )}
                  </div>

                  <TrackList
                    tracks={displayedTracks}
                    currentTrack={currentTrack}
                    isPlaying={isPlaying}
                    isDark={isDark}
                    viewMode={viewMode}
                    selectedIds={selectedIds}
                    multiSelectMode={multiSelectMode}
                    emptyMessage="还没有收藏的红心歌曲"
                    emptySubMessage="点击任意曲目右侧的心形图标，或在右键菜单中添加到我喜欢"
                    onTrackClick={handleTrackClick}
                    onTrackContextMenu={handleTrackContextMenu}
                    onToggleLike={handleToggleLike}
                    onDragStartTrack={handleDragStartTrack}
                    onDragEndTrack={() => setIsDraggingTrack(false)}
                    onBatchPlay={handleBatchPlay}
                    onBatchAddToQueue={handleBatchAddToQueue}
                    onBatchLike={handleBatchLike}
                    onClearSelection={() => {
                      setSelectedIds(new Set());
                      setMultiSelectMode(false);
                    }}
                    onToggleMultiSelectMode={() =>
                      setMultiSelectMode((v) => !v)
                    }
                    onSelectAll={() =>
                      setSelectedIds(new Set(displayedTracks.map((t) => t.id)))
                    }
                  />
                </div>
              )}

              {/* =====================================================
                  VIEW G: 设置 (SETTINGS VIEW - Screenshot 5)
                 ===================================================== */}
              {activeNav === 'settings' && (
                <SettingsView
                  isDark={isDark}
                  ambientEnabled={ambientEnabled}
                  reduceMotion={reduceMotion}
                  ambientIntensity={ambientIntensity}
                  slowDrift={slowDrift}
                  synthEnabled={synthEnabled}
                  exclusiveAudio={exclusiveAudio}
                  onSetTheme={(dark) => {
                    setIsDark(dark);
                    addToast(
                      dark
                        ? '已切换为「夜色」深色模式'
                        : '已切换为「暖白」浅色模式'
                    );
                  }}
                  onSetAmbientEnabled={(val) => {
                    setAmbientEnabled(val);
                    addToast(val ? '封面氛围光已开启' : '封面氛围光已关闭');
                  }}
                  onSetReduceMotion={(val) => {
                    setReduceMotion(val);
                    addToast(val ? '全局减少动效已开启' : '全局动效已恢复');
                  }}
                  onSetAmbientIntensity={setAmbientIntensity}
                  onSetSlowDrift={setSlowDrift}
                  onSetSynthEnabled={(val) => {
                    setSynthEnabled(val);
                    addToast(
                      val
                        ? '已开启 Web Audio 合成器环境试听音'
                        : '已关闭 Web Audio 合成器环境试听音'
                    );
                  }}
                  onSetExclusiveAudio={(val) => {
                    setExclusiveAudio(val);
                    addToast(
                      val
                        ? '已启用 WASAPI / CoreAudio 独占整数直通模式'
                        : '已切换为系统混音共享输出模式'
                    );
                  }}
                  onNotify={addToast}
                />
              )}

              {/* =====================================================
                  VIEW H: 播客 (PODCASTS VIEW - Screenshot 2)
                 ===================================================== */}
              {activeNav === 'podcast' && (
                <PodcastView
                  isDark={isDark}
                  podcasts={podcasts}
                  tracks={tracks}
                  onPlayTrack={playTrackImmediately}
                  onToggleSubscribe={(podId) => {
                    setPodcasts((prev) =>
                      prev.map((p) => {
                        if (p.id === podId) {
                          const next = !p.subscribed;
                          addToast(
                            next
                              ? `已订阅播客《${p.title}》`
                              : `已取消订阅《${p.title}》`
                          );
                          return { ...p, subscribed: next };
                        }
                        return p;
                      })
                    );
                  }}
                  onAddRssFeed={(url) => {
                    const newPod: PodcastShow = {
                      id: `pod-${Date.now()}`,
                      title: '自定义公开 RSS 节目',
                      host: '独立主播',
                      region: '全球 Global',
                      category: '科技与文化',
                      rssUrl: url,
                      subscribers: '1.2万',
                      description: `通过公开 RSS (${url}) 添加的订阅源，已同步最新单集。`,
                      coverStyle: 'agent-podcast',
                      accentColor: '#6366F1',
                      subscribed: true,
                      episodeTrackId: 'track-agent-04',
                    };
                    setPodcasts((prev) => [newPod, ...prev]);
                    addToast(`已成功解析并订阅 RSS：${url}`);
                  }}
                />
              )}

              {/* =====================================================
                  VIEW I: 一起听 (LISTEN TOGETHER VIEW - Screenshot 6)
                 ===================================================== */}
              {activeNav === 'together' && (
                <ListenTogetherView
                  isDark={isDark}
                  currentTrack={currentTrack}
                  isPlaying={isPlaying}
                  onBackHome={() => setActiveNav('home')}
                  onToggleTheme={() => setIsDark((d) => !d)}
                  onNotify={addToast}
                />
              )}

              {/* =====================================================
                  VIEW J: 阅读 (READING / LINER NOTES VIEW)
                 ===================================================== */}
              {activeNav === 'reading' && (
                <ReadingView
                  isDark={isDark}
                  tracks={tracks}
                  onPlayTrack={playTrackImmediately}
                />
              )}
            </div>
          </main>
        </div>

        {/* =========================================================
            3. PERSISTENT BOTTOM TRANSPORT PLAYER DOCK (88px)
           ========================================================= */}
        <footer
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDropTrackToQueue}
          className={`relative z-30 h-[88px] px-4 sm:px-6 border-t flex items-center justify-between gap-4 shrink-0 backdrop-blur-2xl transition-colors ${
            isDark
              ? 'bg-[#0C0E14]/92 border-white/8 text-zinc-100'
              : 'bg-[#FAF9F5]/92 border-black/10 text-zinc-900'
          }`}
        >
          {/* Left Zone: Cover Thumbnail + Track Title & Artist + Heart */}
          <div className="flex items-center gap-3.5 min-w-[180px] sm:w-[280px]">
            <div
              onClick={() => setIsImmersiveOpen((v) => !v)}
              title="点击展开沉浸歌词与唱片舞台"
              className="group relative w-13 h-13 rounded-xl overflow-hidden cursor-pointer shrink-0"
            >
              <CoverArt
                styleType={currentTrack.coverStyle}
                size="sm"
                isPlaying={isPlaying}
                className="w-full h-full rounded-xl"
              />
              <div className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
                <ChevronUp className="w-5 h-5" />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div
                onClick={() => setIsImmersiveOpen(true)}
                className="text-sm font-bold truncate cursor-pointer hover:text-indigo-400 transition-colors"
              >
                {currentTrack.title}
              </div>
              <div className="text-xs opacity-55 truncate mt-0.5">
                {currentTrack.artist} · {currentTrack.album}
              </div>
            </div>

            <button
              onClick={() => handleToggleLike(currentTrack.id)}
              title={currentTrack.liked ? '取消收藏' : '收藏'}
              className="p-2 rounded-full hover:bg-current/10 transition-colors shrink-0"
            >
              <Heart
                className={`w-4 h-4 ${
                  currentTrack.liked
                    ? 'fill-rose-500 text-rose-500'
                    : 'opacity-55 hover:opacity-100'
                }`}
              />
            </button>
          </div>

          {/* Center Zone: Transport Controls + Draggable Scrubbing Bar (matching Screenshots) */}
          <div className="flex-1 max-w-2xl flex flex-col items-center justify-center gap-2">
            {/* Top Controls Row: [列表循环] | Prev | Play(44px) | Next | Stop | Volume */}
            <div className="flex items-center gap-3 sm:gap-5">
              {/* Play Mode Pill matching Screenshot: 列表循环 */}
              <button
                onClick={handleCyclePlayMode}
                title="点击切换播放模式"
                className={`px-3 py-1 rounded-full border text-[11px] font-medium transition-colors ${
                  isDark
                    ? 'bg-white/[0.04] border-white/12 hover:bg-white/10 text-zinc-300'
                    : 'bg-black/[0.04] border-black/12 hover:bg-black/8 text-zinc-700'
                }`}
              >
                {playModeLabel}
              </button>

              <button
                onClick={handlePrevTrack}
                title="上一首"
                className="p-1.5 rounded-full opacity-75 hover:opacity-100 hover:bg-current/10 transition-all"
              >
                <SkipBack className="w-4 h-4 fill-current" />
              </button>

              {/* Primary Play / Pause Circular Button */}
              <button
                onClick={handleTogglePlay}
                title="播放 / 暂停 (快捷键: 空格)"
                className={`w-11 h-11 rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95 ${
                  isDark
                    ? 'bg-white text-zinc-950'
                    : 'bg-zinc-900 text-white'
                }`}
              >
                {isPlaying ? (
                  <Pause className="w-5 h-5 fill-current" />
                ) : (
                  <Play className="w-5 h-5 fill-current ml-0.5" />
                )}
              </button>

              <button
                onClick={handleNextTrack}
                title="下一首"
                className="p-1.5 rounded-full opacity-75 hover:opacity-100 hover:bg-current/10 transition-all"
              >
                <SkipForward className="w-4 h-4 fill-current" />
              </button>

              <button
                onClick={handleStopPlayback}
                title="停止播放"
                className="p-1.5 rounded-full opacity-65 hover:opacity-100 hover:bg-current/10 transition-all hidden sm:inline-flex"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
              </button>

              {/* Volume Control with Inline Slider */}
              <div className="hidden md:flex items-center gap-2 group">
                <button
                  onClick={() => setIsMuted((m) => !m)}
                  title={isMuted ? '取消静音' : '静音'}
                  className="p-1.5 rounded-full opacity-75 hover:opacity-100 hover:bg-current/10"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-4 h-4 text-rose-400" />
                  ) : (
                    <Volume2 className="w-4 h-4" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    setVolume(Number(e.target.value));
                    if (isMuted) setIsMuted(false);
                  }}
                  title={`音量: ${isMuted ? 0 : volume}%`}
                  className="w-20 h-1 rounded-lg appearance-none cursor-pointer bg-current/20 accent-indigo-400"
                />
              </div>
            </div>

            {/* Bottom Interactive Scrubbing Progress Bar + Tabular Readout */}
            <div className="w-full flex items-center gap-3">
              <div
                ref={progressBarRef}
                onMouseDown={handleProgressMouseDown}
                title="点击或按住拖拽调节播放进度"
                className="group relative flex-1 h-4 flex items-center cursor-pointer"
              >
                <div
                  className={`w-full h-1 group-hover:h-1.5 rounded-full overflow-hidden transition-all ${
                    isDark ? 'bg-white/15' : 'bg-black/15'
                  }`}
                >
                  <div
                    className="h-full bg-indigo-400 rounded-full transition-all duration-75"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                {/* Scrubbing Thumb */}
                <div
                  className={`w-3 h-3 rounded-full bg-white shadow-md border border-indigo-500 absolute -translate-x-1/2 transition-opacity ${
                    isScrubbing
                      ? 'opacity-100 scale-125'
                      : 'opacity-0 group-hover:opacity-100'
                  }`}
                  style={{ left: `${progressPercent}%` }}
                />
              </div>

              <span className="text-[11px] font-mono-tabular opacity-60 shrink-0 min-w-[74px] text-right">
                {formatSeconds(activeTime)} / {currentTrack.durationStr}
              </span>
            </div>
          </div>

          {/* Right Zone: Queue Add / Queue Drawer / Lyrics Stage / Sleep Timer (matching Screenshots) */}
          <div className="flex items-center justify-end gap-1.5 sm:w-[240px]">
            <button
              onClick={() => {
                setQueue((prev) => [...prev, currentTrack]);
                addToast(`已将《${currentTrack.title}》再次追加至队列`);
              }}
              title="将当前曲目加入队列"
              className="p-2 rounded-xl opacity-70 hover:opacity-100 hover:bg-current/8 transition-colors hidden sm:inline-flex"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>

            <button
              onClick={() => setIsQueueOpen((v) => !v)}
              title={`播放队列 (${queue.length})`}
              className={`relative p-2 rounded-xl transition-colors ${
                isQueueOpen
                  ? 'bg-indigo-500/20 text-indigo-400 opacity-100'
                  : 'opacity-70 hover:opacity-100 hover:bg-current/8'
              }`}
            >
              <List className="w-4 h-4" />
              <span className="absolute -top-0.5 -right-0.5 px-1 rounded-full text-[9px] font-mono-tabular bg-indigo-500 text-white">
                {queue.length}
              </span>
            </button>

            <button
              onClick={() => setIsImmersiveOpen((v) => !v)}
              title="打开沉浸式全屏歌词舞台"
              className={`p-2 rounded-xl transition-colors ${
                isImmersiveOpen
                  ? 'bg-indigo-500/20 text-indigo-400 opacity-100'
                  : 'opacity-70 hover:opacity-100 hover:bg-current/8'
              }`}
            >
              <Monitor className="w-4 h-4" />
            </button>

            <button
              onClick={() => {
                const options = [null, 15, 30, 60];
                const next =
                  options[(options.indexOf(sleepTimer) + 1) % options.length];
                setSleepTimer(next);
                addToast(
                  next
                    ? `已开启睡眠定时：${next} 分钟后自动停止播放`
                    : '已关闭睡眠定时'
                );
              }}
              title={
                sleepTimer ? `睡眠定时: ${sleepTimer}分钟` : '设置睡眠定时'
              }
              className={`relative p-2 rounded-xl transition-colors ${
                sleepTimer
                  ? 'bg-amber-500/20 text-amber-400 opacity-100'
                  : 'opacity-70 hover:opacity-100 hover:bg-current/8'
              }`}
            >
              <Clock className="w-4 h-4" />
              {sleepTimer && (
                <span className="absolute -top-0.5 -right-0.5 px-1 rounded-full text-[9px] font-mono-tabular bg-amber-500 text-zinc-950 font-bold">
                  {sleepTimer}
                </span>
              )}
            </button>
          </div>
        </footer>

        {/* =========================================================
            4. OVERLAYS: QUEUE DRAWER, IMMERSIVE LYRICS, CONTEXT MENU, MODALS, TOASTS
           ========================================================= */}
        <QueueDrawer
          isOpen={isQueueOpen}
          isDark={isDark}
          queue={queue}
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          isDraggingTrack={isDraggingTrack}
          onClose={() => setIsQueueOpen(false)}
          onSelectTrack={playTrackImmediately}
          onTogglePlay={handleTogglePlay}
          onRemoveFromQueue={(id) => {
            setQueue((prev) => prev.filter((t) => t.id !== id));
            addToast('已从播放队列移除该曲目');
          }}
          onClearQueue={() => {
            setQueue([]);
            addToast('已清空播放队列');
          }}
          onShuffleQueue={() => {
            setQueue((prev) => [...prev].sort(() => Math.random() - 0.5));
            addToast('已随机打乱当前播放队列');
          }}
          onMoveQueueItem={(index, direction) => {
            setQueue((prev) => {
              const copy = [...prev];
              const target = direction === 'up' ? index - 1 : index + 1;
              if (target < 0 || target >= copy.length) return prev;
              const [item] = copy.splice(index, 1);
              copy.splice(target, 0, item);
              return copy;
            });
          }}
          onDropTrackToQueue={handleDropTrackToQueue}
          onRestoreDefaultQueue={() => {
            setQueue(tracks);
            addToast('已恢复默认精选无损队列');
          }}
        />

        <ImmersiveLyricsModal
          isOpen={isImmersiveOpen}
          track={currentTrack}
          isPlaying={isPlaying}
          currentTime={activeTime}
          duration={currentTrack.duration}
          ambientEnabled={ambientEnabled}
          ambientIntensity={ambientIntensity}
          slowDrift={slowDrift && !reduceMotion}
          playMode={playMode}
          volume={isMuted ? 0 : volume}
          onClose={() => setIsImmersiveOpen(false)}
          onTogglePlay={handleTogglePlay}
          onPrev={handlePrevTrack}
          onNext={handleNextTrack}
          onSeek={(t) => {
            setCurrentTime(t);
            setIsPlaying(true);
            addToast(`已跳转至歌词时间点 ${formatSeconds(t)}`);
          }}
          onToggleLike={handleToggleLike}
          onCyclePlayMode={handleCyclePlayMode}
          onVolumeChange={(v) => {
            setVolume(v);
            if (isMuted) setIsMuted(false);
          }}
          onOpenQueue={() => setIsQueueOpen(true)}
        />

        <ContextMenu
          menu={contextMenu}
          isDark={isDark}
          playlists={playlists}
          onClose={() =>
            setContextMenu((prev) => ({ ...prev, visible: false }))
          }
          onPlayNow={(track) => {
            if (selectedIds.size > 1 && selectedIds.has(track.id)) {
              handleBatchPlay();
            } else {
              playTrackImmediately(track);
            }
          }}
          onPlayNext={(track) => {
            setQueue((prev) => {
              const curIdx = prev.findIndex((t) => t.id === currentTrack.id);
              const filtered = prev.filter((t) => t.id !== track.id);
              filtered.splice(curIdx + 1, 0, track);
              return filtered;
            });
            addToast(`已将《${track.title}》设为下一首播放`);
          }}
          onAddToQueue={(track) => {
            if (selectedIds.size > 1 && selectedIds.has(track.id)) {
              handleBatchAddToQueue();
            } else {
              setQueue((prev) => [...prev, track]);
              addToast(`已将《${track.title}》加入播放队列`);
            }
          }}
          onToggleLike={handleToggleLike}
          onAddToPlaylist={(playlistId, track) => {
            setPlaylists((prev) =>
              prev.map((pl) => {
                if (pl.id === playlistId) {
                  const nextIds = pl.trackIds.includes(track.id)
                    ? pl.trackIds
                    : [...pl.trackIds, track.id];
                  addToast(`已将《${track.title}》添加至歌单「${pl.name}」`);
                  return { ...pl, trackIds: nextIds };
                }
                return pl;
              })
            );
          }}
          onFilterAlbum={(alb) => {
            setAlbumFilter(alb);
            setActiveNav('library');
            setLibraryTab('歌曲');
            addToast(`已定位至专辑：${alb}`);
          }}
          onFilterArtist={(art) => {
            setArtistFilter(art);
            setActiveNav('library');
            setLibraryTab('歌曲');
            addToast(`已定位至歌手：${art}`);
          }}
          onCopyInfo={(track) => {
            const info = `${track.title} - ${track.artist} [${track.album}] (${track.quality})`;
            navigator.clipboard?.writeText(info).catch(() => {});
            addToast(`已复制曲目信息：${info}`);
          }}
          onRemoveTrack={(id) => {
            setTracks((prev) => prev.filter((t) => t.id !== id));
            setQueue((prev) => prev.filter((t) => t.id !== id));
            addToast('已从曲库列表中移除该曲目');
          }}
        />

        <ShortcutsModal
          isOpen={isShortcutsOpen}
          isDark={isDark}
          onClose={() => setIsShortcutsOpen(false)}
        />

        <MusicFoldersModal
          isOpen={isFoldersOpen}
          isDark={isDark}
          onClose={() => setIsFoldersOpen(false)}
          onRescan={(folder) => {
            addToast(
              folder
                ? `已完成目录扫描 (${folder})，曲库索引已更新`
                : '已完成全盘无损音频目录重扫'
            );
          }}
        />

        <CreatePlaylistModal
          isOpen={isCreatePlaylistOpen}
          isDark={isDark}
          onClose={() => setIsCreatePlaylistOpen(false)}
          onCreate={(name, desc, coverStyle: CoverStyleType) => {
            const newPl: Playlist = {
              id: `pl-${Date.now()}`,
              name,
              description: desc,
              creator: 'Hertz 用户',
              coverStyle,
              accentColor: '#6366F1',
              trackIds: [currentTrack.id],
              updatedAt: '2026-11-25',
              tags: ['自定义', 'Hi-Fi'],
            };
            setPlaylists((prev) => [newPl, ...prev]);
            setActivePlaylistId(newPl.id);
            setActiveNav('playlists');
            addToast(`已创建新歌单「${name}」`);
          }}
        />

        {/* Stacked Glassmorphic Toast Notifications */}
        <div className="fixed bottom-24 right-6 z-[90] flex flex-col items-end gap-2 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`px-4 py-2.5 rounded-xl border shadow-xl backdrop-blur-2xl flex items-center gap-2 text-xs font-medium transition-all duration-200 ${
                isDark
                  ? 'bg-[#171A24]/95 border-white/15 text-zinc-100 shadow-black/60'
                  : 'bg-white/95 border-black/10 text-zinc-900 shadow-zinc-900/15'
              }`}
            >
              <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
