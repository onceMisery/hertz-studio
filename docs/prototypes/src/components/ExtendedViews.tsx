import React, { useState } from 'react';
import {
  Headphones,
  ChevronRight,
  ChevronDown,
  Plus,
  Check,
  Play,
  Users,
  Settings2,
  Palette,
  ArrowLeft,
  Radio,
  Sparkles,
  BookOpen,
  Cpu,
  Sliders,
  Wifi,
  Wrench,
  Rss,
} from 'lucide-react';
import {
  PodcastShow,
  READING_ARTICLES,
  Track,
} from '../data/mockMusicData';
import { CoverArt } from './CoverArt';

/* ==========================================
   1. 播客视图 (Screenshot 2: Podcasts)
   ========================================== */
interface PodcastViewProps {
  isDark: boolean;
  podcasts: PodcastShow[];
  tracks: Track[];
  onPlayTrack: (track: Track) => void;
  onToggleSubscribe: (podcastId: string) => void;
  onAddRssFeed: (rssUrl: string) => void;
}

export const PodcastView: React.FC<PodcastViewProps> = ({
  isDark,
  podcasts,
  tracks,
  onPlayTrack,
  onToggleSubscribe,
  onAddRssFeed,
}) => {
  const [region, setRegion] = useState('中国大陆');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'discover' | 'subscribed'>('discover');
  const [rssExpanded, setRssExpanded] = useState(false);
  const [rssInput, setRssInput] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const quickTags = ['故事FM', '忽左忽右', '声东击西', '架构深潜'];

  const filteredPodcasts = podcasts.filter((p) => {
    if (activeTab === 'subscribed' && !p.subscribed) return false;
    const q = (selectedTag || searchQuery).trim().toLowerCase();
    if (!q) return true;
    return (
      p.title.toLowerCase().includes(q) ||
      p.host.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q)
    );
  });

  const handleRssSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rssInput.trim()) return;
    onAddRssFeed(rssInput.trim());
    setRssInput('');
    setRssExpanded(false);
  };

  const playPodcastEpisode = (pod: PodcastShow) => {
    const ep =
      tracks.find((t) => t.id === pod.episodeTrackId) || tracks[1] || tracks[0];
    if (ep) onPlayTrack(ep);
  };

  return (
    <div className="space-y-6 pb-10">
      {/* Header matching Screenshot 2 */}
      <div className="flex items-baseline gap-3">
        <h1 className="text-3xl font-bold tracking-tight">播客</h1>
        <span className="text-sm opacity-55">全球节目 · 公开 RSS</span>
      </div>

      {/* Region + Search Bar row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative">
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className={`h-11 pl-4 pr-9 rounded-xl border text-xs font-medium appearance-none cursor-pointer transition-colors ${
              isDark
                ? 'bg-white/[0.04] border-white/10 text-zinc-200 hover:border-white/20'
                : 'bg-white border-black/12 text-zinc-800'
            }`}
          >
            <option value="中国大陆">中国大陆</option>
            <option value="全球 Global">全球 Global</option>
            <option value="美国 US">美国 US</option>
            <option value="日本 JP">日本 JP</option>
            <option value="英国 UK">英国 UK</option>
          </select>
          <ChevronDown className="w-3.5 h-3.5 opacity-60 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>

        <input
          type="text"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setSelectedTag(null);
          }}
          placeholder="搜索节目名或主播名..."
          className={`flex-1 h-11 px-4 rounded-xl border text-xs transition-colors ${
            isDark
              ? 'bg-white/[0.04] border-white/10 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500/60'
              : 'bg-white border-black/12 text-zinc-900 placeholder:text-zinc-400'
          }`}
        />

        <button
          onClick={() => setSelectedTag(null)}
          className={`h-11 px-6 rounded-full text-xs font-semibold transition-transform active:scale-95 ${
            isDark
              ? 'bg-white text-zinc-950 hover:bg-zinc-200'
              : 'bg-zinc-900 text-white hover:bg-zinc-800'
          }`}
        >
          搜索节目
        </button>
      </div>

      {/* Tabs: 发现节目 | 我的订阅 */}
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => setActiveTab('discover')}
          className={`px-4 py-1.5 rounded-full text-xs font-medium border transition-all ${
            activeTab === 'discover'
              ? isDark
                ? 'bg-white/12 border-white/40 text-white'
                : 'bg-zinc-900 border-zinc-900 text-white'
              : isDark
              ? 'bg-transparent border-white/10 text-zinc-400 hover:text-zinc-200'
              : 'bg-transparent border-black/12 text-zinc-600'
          }`}
        >
          发现节目
        </button>
        <button
          onClick={() => setActiveTab('subscribed')}
          className={`px-4 py-1.5 rounded-full text-xs font-medium border transition-all ${
            activeTab === 'subscribed'
              ? isDark
                ? 'bg-white/12 border-white/40 text-white'
                : 'bg-zinc-900 border-zinc-900 text-white'
              : isDark
              ? 'bg-transparent border-white/10 text-zinc-400 hover:text-zinc-200'
              : 'bg-transparent border-black/12 text-zinc-600'
          }`}
        >
          我的订阅 ({podcasts.filter((p) => p.subscribed).length})
        </button>
      </div>

      {/* Expandable RSS Subscription Row */}
      <div
        className={`pb-4 border-b ${
          isDark ? 'border-white/8' : 'border-black/8'
        }`}
      >
        <button
          onClick={() => setRssExpanded((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs opacity-70 hover:opacity-100 transition-opacity"
        >
          {rssExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          <span>添加 RSS 订阅</span>
        </button>

        {rssExpanded && (
          <form
            onSubmit={handleRssSubmit}
            className="mt-3 flex items-center gap-2 max-w-xl"
          >
            <div className="relative flex-1">
              <Rss className="w-3.5 h-3.5 opacity-50 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="url"
                required
                value={rssInput}
                onChange={(e) => setRssInput(e.target.value)}
                placeholder="https://example.com/podcast/feed.xml"
                className={`w-full pl-9 pr-3 py-2 rounded-xl border text-xs font-mono-tabular ${
                  isDark
                    ? 'bg-white/5 border-white/12 text-white'
                    : 'bg-white border-black/12 text-zinc-900'
                }`}
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-400"
            >
              解析并订阅
            </button>
          </form>
        )}
      </div>

      {/* Starter Guide & Quick Tags (Screenshot 2) */}
      <div className="space-y-3">
        <h2 className="text-lg font-bold">从一个感兴趣的节目开始</h2>
        <p className="text-xs opacity-60">
          搜索节目名或主播名，也可以添加公开 RSS。点击下方标签立即筛选或试听单集：
        </p>
        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          {quickTags.map((tag) => {
            const isSelected = selectedTag === tag;
            return (
              <button
                key={tag}
                onClick={() =>
                  setSelectedTag(isSelected ? null : tag)
                }
                className={`px-4 py-1.5 rounded-full text-xs font-medium border transition-all ${
                  isSelected
                    ? 'bg-indigo-500 text-white border-indigo-400'
                    : isDark
                    ? 'bg-white/[0.03] border-white/12 text-zinc-200 hover:bg-white/[0.08]'
                    : 'bg-white border-black/12 text-zinc-800 hover:bg-black/5'
                }`}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      {/* Podcast Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
        {filteredPodcasts.map((pod) => (
          <div
            key={pod.id}
            className={`p-4 rounded-2xl border flex items-start gap-4 transition-all ${
              isDark
                ? 'bg-white/[0.025] border-white/8 hover:bg-white/[0.05]'
                : 'bg-white border-black/8 hover:shadow-md'
            }`}
          >
            <CoverArt
              styleType={pod.coverStyle}
              size="md"
              className="w-20 h-20 rounded-xl shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold truncate">{pod.title}</h3>
                  <div className="text-xs opacity-60 mt-0.5">
                    {pod.host} · {pod.region}
                  </div>
                </div>
                <button
                  onClick={() => onToggleSubscribe(pod.id)}
                  className={`px-3 py-1 rounded-full text-[11px] font-medium inline-flex items-center gap-1 border transition-colors ${
                    pod.subscribed
                      ? isDark
                        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      : isDark
                      ? 'bg-white/8 border-white/12 hover:bg-white/15'
                      : 'bg-zinc-100 border-black/10 hover:bg-zinc-200'
                  }`}
                >
                  {pod.subscribed ? (
                    <>
                      <Check className="w-3 h-3" /> 已订阅
                    </>
                  ) : (
                    <>
                      <Plus className="w-3 h-3" /> 订阅
                    </>
                  )}
                </button>
              </div>

              <p className="text-xs opacity-70 line-clamp-2 mt-2">
                {pod.description}
              </p>

              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] font-mono-tabular opacity-50 truncate max-w-[180px]">
                  RSS: {pod.rssUrl}
                </span>
                <button
                  onClick={() => playPodcastEpisode(pod)}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500 hover:text-white transition-colors"
                >
                  <Play className="w-3 h-3 fill-current" />
                  <span>播放最新单集</span>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ==========================================
   2. 一起听视图 (Screenshot 6: Listen Together)
   ========================================== */
interface ListenTogetherViewProps {
  isDark: boolean;
  currentTrack: Track;
  isPlaying: boolean;
  onBackHome: () => void;
  onToggleTheme: () => void;
  onNotify: (msg: string) => void;
}

export const ListenTogetherView: React.FC<ListenTogetherViewProps> = ({
  isDark,
  currentTrack,
  isPlaying,
  onBackHome,
  onToggleTheme,
  onNotify,
}) => {
  const [roomActive, setRoomActive] = useState(false);
  const [roomCode, setRoomCode] = useState('HZ-8492');
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [inviteInput, setInviteInput] = useState('');
  const [recentSessions, setRecentSessions] = useState<
    { id: string; host: string; trackTitle: string; time: string }[]
  >([]);

  const handleCreateRoom = () => {
    const code = `HZ-${Math.floor(1000 + Math.random() * 9000)}`;
    setRoomCode(code);
    setRoomActive(true);
    setRecentSessions((prev) => [
      {
        id: code,
        host: 'Hertz 与 林深、阿泽',
        trackTitle: `${currentTrack.title} - ${currentTrack.artist}`,
        time: '刚刚同步',
      },
      ...prev,
    ]);
    onNotify(`已创建局域网同步房间 ${code}，进度已实时绑定`);
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const code = inviteInput.trim().toUpperCase() || 'HZ-2026';
    setRoomCode(code);
    setRoomActive(true);
    setJoinModalOpen(false);
    setInviteInput('');
    setRecentSessions((prev) => [
      {
        id: code,
        host: `受邀房间 (${code})`,
        trackTitle: `${currentTrack.title} - ${currentTrack.artist}`,
        time: '刚刚加入',
      },
      ...prev,
    ]);
    onNotify(`已成功加入房间 ${code}，正在同步音频时钟`);
  };

  return (
    <div className="pb-10">
      {/* Top Header Bar matching Screenshot 6 */}
      <div
        className={`flex items-center justify-between pb-4 mb-8 border-b ${
          isDark ? 'border-white/8' : 'border-black/8'
        }`}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={onBackHome}
            className="inline-flex items-center gap-1.5 text-xs opacity-70 hover:opacity-100 transition-opacity"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回 Hertz</span>
          </button>
          <span className="text-base font-bold">一起听</span>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={onToggleTheme}
            title="切换房间视觉主题"
            className={`p-2.5 rounded-xl border transition-colors ${
              isDark
                ? 'bg-white/[0.04] border-white/10 hover:bg-white/10'
                : 'bg-white border-black/10 hover:bg-black/5'
            }`}
          >
            <Palette className="w-4 h-4" />
          </button>
          <button
            onClick={() =>
              onNotify('房间设置：局域网 UDP 低延迟同步 (<12ms) 已启用')
            }
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl border text-xs font-medium transition-colors ${
              isDark
                ? 'bg-white/[0.04] border-white/10 hover:bg-white/10'
                : 'bg-white border-black/10 hover:bg-black/5'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>房间设置</span>
          </button>
        </div>
      </div>

      {/* Center Radar Stage matching Screenshot 6 */}
      <div className="max-w-xl mx-auto flex flex-col items-center text-center py-4">
        <div className="relative w-36 h-36 flex items-center justify-center mb-6">
          <div
            className={`absolute inset-0 rounded-full border ${
              isDark ? 'border-white/8' : 'border-black/10'
            } ${roomActive ? 'animate-radar border-indigo-500/40' : ''}`}
          />
          <div
            className={`w-24 h-24 rounded-full border flex items-center justify-center ${
              roomActive
                ? 'bg-indigo-500/20 border-indigo-400/50 text-indigo-300'
                : isDark
                ? 'bg-white/[0.03] border-white/12 text-zinc-300'
                : 'bg-black/[0.03] border-black/12 text-zinc-700'
            }`}
          >
            <Headphones className="w-7 h-7" />
          </div>
        </div>

        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          和身边的人，听同一首歌
        </h1>
        <p className="text-xs sm:text-sm opacity-60 mt-3 max-w-md leading-relaxed">
          创建一间房间，朋友们在同一网络里加入，进度实时同步。
        </p>

        {/* Action Buttons */}
        {!roomActive ? (
          <div className="mt-7 flex items-center gap-3">
            <button
              onClick={handleCreateRoom}
              className={`px-5 py-2.5 rounded-xl text-xs font-semibold transition-transform active:scale-95 ${
                isDark
                  ? 'bg-white text-zinc-950 hover:bg-zinc-200'
                  : 'bg-zinc-900 text-white hover:bg-zinc-800'
              }`}
            >
              + 创建房间
            </button>
            <button
              onClick={() => setJoinModalOpen((v) => !v)}
              className={`px-5 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${
                isDark
                  ? 'bg-white/[0.04] border-white/10 hover:bg-white/10 text-zinc-200'
                  : 'bg-white border-black/12 hover:bg-black/5 text-zinc-800'
              }`}
            >
              使用邀请加入
            </button>
          </div>
        ) : (
          /* Active Live Sync Room Card */
          <div
            className={`mt-6 w-full p-5 rounded-2xl border text-left ${
              isDark
                ? 'bg-indigo-500/10 border-indigo-500/30'
                : 'bg-indigo-50 border-indigo-200'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                <span className="text-xs font-bold">
                  房间已开启 · 邀请码：{roomCode}
                </span>
              </div>
              <button
                onClick={() => {
                  setRoomActive(false);
                  onNotify('已离开一起听房间');
                }}
                className="text-xs text-rose-400 hover:underline"
              >
                结束房间
              </button>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <CoverArt
                styleType={currentTrack.coverStyle}
                size="sm"
                className="w-12 h-12 rounded-xl"
                isPlaying={isPlaying}
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold truncate">
                  正在同步播放：{currentTrack.title}
                </div>
                <div className="text-[11px] opacity-65 mt-0.5">
                  {currentTrack.artist} · 3 位听友在线同步中 (延迟 8ms)
                </div>
              </div>
            </div>
          </div>
        )}

        {joinModalOpen && !roomActive && (
          <form
            onSubmit={handleJoinRoom}
            className="mt-4 flex items-center gap-2"
          >
            <input
              type="text"
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              placeholder="输入房间邀请码，如 HZ-8492"
              className={`px-3.5 py-2 rounded-xl border text-xs font-mono-tabular ${
                isDark
                  ? 'bg-white/5 border-white/15 text-white'
                  : 'bg-white border-black/15 text-zinc-900'
              }`}
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-500 text-white"
            >
              立即加入
            </button>
          </form>
        )}

        <button
          onClick={handleCreateRoom}
          className="mt-7 text-xs opacity-60 hover:opacity-100 inline-flex items-center gap-1.5 transition-opacity"
        >
          <Radio className="w-3.5 h-3.5" />
          <span>看看附近的房间</span>
        </button>

        {/* Bottom Card: 最近一起听过 (Screenshot 6) */}
        <div
          className={`mt-6 w-full rounded-2xl border p-6 text-left ${
            isDark
              ? 'bg-white/[0.02] border-white/8'
              : 'bg-white border-black/8'
          }`}
        >
          <div className="text-xs font-bold mb-4">最近一起听过</div>

          {recentSessions.length === 0 ? (
            <div className="py-6 flex flex-col items-center justify-center text-center">
              <div
                className={`w-12 h-12 rounded-full border flex items-center justify-center mb-3 ${
                  isDark
                    ? 'bg-white/[0.03] border-white/10 text-zinc-400'
                    : 'bg-black/[0.03] border-black/10 text-zinc-500'
                }`}
              >
                <Users className="w-5 h-5" />
              </div>
              <div className="text-xs font-bold">这里还没有人</div>
              <p className="text-[11px] opacity-55 mt-1 max-w-xs leading-relaxed">
                第一次一起听过之后，房间和参与者会出现在这里，下次可以再开一间。
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentSessions.map((s) => (
                <div
                  key={s.id}
                  className={`p-3 rounded-xl border flex items-center justify-between text-xs ${
                    isDark
                      ? 'bg-white/[0.03] border-white/8'
                      : 'bg-zinc-50 border-black/6'
                  }`}
                >
                  <div>
                    <div className="font-semibold">{s.host}</div>
                    <div className="opacity-60 text-[11px] mt-0.5">
                      曲目：{s.trackTitle}
                    </div>
                  </div>
                  <span className="text-[11px] font-mono-tabular opacity-60">
                    {s.time}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ==========================================
   3. 阅读视图 (Music Reading & Liner Notes)
   ========================================== */
interface ReadingViewProps {
  isDark: boolean;
  tracks: Track[];
  onPlayTrack: (track: Track) => void;
}

export const ReadingView: React.FC<ReadingViewProps> = ({
  isDark,
  tracks,
  onPlayTrack,
}) => {
  const [selectedArticleId, setSelectedArticleId] = useState(
    READING_ARTICLES[0].id
  );
  const activeArticle =
    READING_ARTICLES.find((a) => a.id === selectedArticleId) ||
    READING_ARTICLES[0];

  const playRelated = (trackId: string) => {
    const found = tracks.find((t) => t.id === trackId) || tracks[0];
    if (found) onPlayTrack(found);
  };

  return (
    <div className="space-y-6 pb-10">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-bold tracking-tight">阅读</h1>
          <span className="text-sm opacity-55">
            唱片内页志 · 声学专栏 · 深度导聆
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Article List */}
        <div className="lg:col-span-5 space-y-3">
          {READING_ARTICLES.map((art) => {
            const isSelected = art.id === activeArticle.id;
            return (
              <div
                key={art.id}
                onClick={() => setSelectedArticleId(art.id)}
                className={`p-4 rounded-2xl border cursor-pointer transition-all ${
                  isSelected
                    ? isDark
                      ? 'bg-indigo-500/15 border-indigo-500/40'
                      : 'bg-indigo-50 border-indigo-300'
                    : isDark
                    ? 'bg-white/[0.025] border-white/8 hover:bg-white/[0.05]'
                    : 'bg-white border-black/8 hover:shadow-sm'
                }`}
              >
                <div className="flex items-center gap-2 text-[11px] text-indigo-400 font-medium mb-1.5">
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{art.tag}</span>
                  <span>·</span>
                  <span className="opacity-70">{art.readTime}</span>
                </div>
                <h3 className="text-sm font-bold leading-snug">{art.title}</h3>
                <p className="text-xs opacity-65 mt-1.5 line-clamp-2">
                  {art.excerpt}
                </p>
              </div>
            );
          })}
        </div>

        {/* Right Article Reader */}
        <div
          className={`lg:col-span-7 p-6 sm:p-8 rounded-2xl border ${
            isDark
              ? 'bg-white/[0.025] border-white/8'
              : 'bg-white border-black/8'
          }`}
        >
          <div className="flex items-start justify-between gap-4 pb-6 border-b border-current/10">
            <div>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-indigo-500/20 text-indigo-300">
                {activeArticle.tag}
              </span>
              <h2 className="text-xl sm:text-2xl font-bold mt-2 leading-tight">
                {activeArticle.title}
              </h2>
              <p className="text-xs opacity-65 mt-1">
                {activeArticle.subtitle} · 作者：{activeArticle.author}
              </p>
            </div>
            <CoverArt
              styleType={activeArticle.coverStyle}
              size="md"
              className="w-20 h-20 rounded-xl shrink-0"
            />
          </div>

          <div className="mt-6 space-y-4 text-sm leading-relaxed opacity-85">
            {activeArticle.content.map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>

          <div className="mt-8 pt-4 border-t border-current/10 flex items-center justify-between">
            <span className="text-xs opacity-60">
              边读边听：点击右侧按钮直接播放本文关联母带曲目
            </span>
            <button
              onClick={() => playRelated(activeArticle.relatedTrackId)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-400 transition-colors"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>聆听关联曲目</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ==========================================
   4. 设置视图 (Screenshot 5: Settings)
   ========================================== */
interface SettingsViewProps {
  isDark: boolean;
  ambientEnabled: boolean;
  reduceMotion: boolean;
  ambientIntensity: number;
  slowDrift: boolean;
  synthEnabled: boolean;
  exclusiveAudio: boolean;
  onSetTheme: (dark: boolean) => void;
  onSetAmbientEnabled: (val: boolean) => void;
  onSetReduceMotion: (val: boolean) => void;
  onSetAmbientIntensity: (val: number) => void;
  onSetSlowDrift: (val: boolean) => void;
  onSetSynthEnabled: (val: boolean) => void;
  onSetExclusiveAudio: (val: boolean) => void;
  onNotify: (msg: string) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  isDark,
  ambientEnabled,
  reduceMotion,
  ambientIntensity,
  slowDrift,
  synthEnabled,
  exclusiveAudio,
  onSetTheme,
  onSetAmbientEnabled,
  onSetReduceMotion,
  onSetAmbientIntensity,
  onSetSlowDrift,
  onSetSynthEnabled,
  onSetExclusiveAudio,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<
    '外观' | '播放' | '歌词' | '桌面' | '连接' | '工具'
  >('外观');

  const tabs: ('外观' | '播放' | '歌词' | '桌面' | '连接' | '工具')[] = [
    '外观',
    '播放',
    '歌词',
    '桌面',
    '连接',
    '工具',
  ];

  const renderSwitch = (checked: boolean, onChange: (v: boolean) => void) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
        checked
          ? isDark
            ? 'bg-white'
            : 'bg-zinc-900'
          : isDark
          ? 'bg-white/15'
          : 'bg-black/15'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full shadow-md ring-0 transition duration-200 ease-in-out flex items-center justify-center text-[10px] font-bold ${
          checked
            ? isDark
              ? 'translate-x-5 bg-zinc-950 text-white'
              : 'translate-x-5 bg-white text-zinc-900'
            : 'translate-x-0 bg-zinc-400 text-zinc-950'
        }`}
      >
        {checked ? '✓' : '×'}
      </span>
    </button>
  );

  return (
    <div className="space-y-6 pb-12 max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">设置</h1>

      {/* Sub-navigation Tabs matching Screenshot 5 */}
      <div
        className={`flex items-center gap-6 border-b ${
          isDark ? 'border-white/8' : 'border-black/8'
        }`}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
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
        })}
      </div>

      {/* Tab Content */}
      {activeTab === '外观' && (
        <div className="space-y-2">
          <h2 className="text-base font-bold pt-2 pb-1">外观</h2>

          <div
            className={`divide-y ${
              isDark ? 'divide-white/8' : 'divide-black/8'
            }`}
          >
            {/* Row 1: 界面颜色 (夜色 / 暖白) */}
            <div className="py-5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">界面颜色</div>
                <div className="text-xs opacity-55 mt-1">
                  沉浸播放页始终使用深色外观
                </div>
              </div>
              <div
                className={`p-1 rounded-full border flex items-center ${
                  isDark
                    ? 'bg-white/[0.04] border-white/10'
                    : 'bg-black/[0.04] border-black/10'
                }`}
              >
                <button
                  onClick={() => onSetTheme(true)}
                  className={`px-3.5 py-1 rounded-full text-xs font-semibold transition-all ${
                    isDark
                      ? 'bg-white text-zinc-950 shadow-xs'
                      : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  夜色
                </button>
                <button
                  onClick={() => onSetTheme(false)}
                  className={`px-3.5 py-1 rounded-full text-xs font-semibold transition-all ${
                    !isDark
                      ? 'bg-zinc-900 text-white shadow-xs'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  暖白
                </button>
              </div>
            </div>

            {/* Row 2: 封面氛围光 */}
            <div className="py-5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">封面氛围光</div>
                <div className="text-xs opacity-55 mt-1">
                  从封面提取背景与舞台高亮色，即时生效并自动保存。
                </div>
              </div>
              {renderSwitch(ambientEnabled, onSetAmbientEnabled)}
            </div>

            {/* Row 3: 减少动效 */}
            <div className="py-5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">减少动效</div>
                <div className="text-xs opacity-55 mt-1">
                  全局压掉所有动效；只要某一面不舒服时，用下面的分面开关更合适
                </div>
              </div>
              {renderSwitch(reduceMotion, onSetReduceMotion)}
            </div>

            {/* Row 4: 氛围光强度 (70% slider) */}
            <div className="py-5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">氛围光强度</div>
                <div className="text-xs opacity-55 mt-1">
                  调节主舞台与沉浸歌词视图的背景色彩光晕浓度
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={ambientIntensity}
                  onChange={(e) =>
                    onSetAmbientIntensity(Number(e.target.value))
                  }
                  className="w-36 sm:w-44 h-1.5 rounded-lg appearance-none cursor-pointer bg-current/20 accent-white"
                />
                <span className="text-xs font-mono-tabular opacity-75 w-9 text-right">
                  {ambientIntensity}%
                </span>
              </div>
            </div>

            {/* Row 5: 背景缓慢流动 */}
            <div className="py-5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">背景缓慢流动</div>
                <div className="text-xs opacity-55 mt-1">
                  允许封面提取光斑在低帧率下做自然呼吸位移
                </div>
              </div>
              {renderSwitch(slowDrift, onSetSlowDrift)}
            </div>
          </div>
        </div>
      )}

      {activeTab === '播放' && (
        <div className="space-y-2">
          <h2 className="text-base font-bold pt-2 pb-1 flex items-center gap-2">
            <Cpu className="w-4 h-4 text-indigo-400" />
            <span>音频引擎与输出链路</span>
          </h2>
          <div
            className={`divide-y ${
              isDark ? 'divide-white/8' : 'divide-black/8'
            }`}
          >
            <div className="py-5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">
                  WASAPI / CoreAudio 独占整数模式
                </div>
                <div className="text-xs opacity-55 mt-1">
                  绕过系统混音器 SRC 重采样，按曲目原始采样率点对点输出至 DAC
                </div>
              </div>
              {renderSwitch(exclusiveAudio, onSetExclusiveAudio)}
            </div>

            <div className="py-5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">
                  Web Audio 合成器环境试听音（无外部音源时发声）
                </div>
                <div className="text-xs opacity-55 mt-1">
                  开启后播放曲目时将通过浏览器原生音频合成器奏响轻柔的电钢琴泛音
                </div>
              </div>
              {renderSwitch(synthEnabled, onSetSynthEnabled)}
            </div>
          </div>
        </div>
      )}

      {activeTab !== '外观' && activeTab !== '播放' && (
        <div
          className={`p-6 rounded-2xl border space-y-4 ${
            isDark
              ? 'bg-white/[0.02] border-white/8'
              : 'bg-white border-black/8'
          }`}
        >
          <div className="flex items-center gap-2.5 text-sm font-semibold">
            {activeTab === '歌词' && <Sparkles className="w-4 h-4 text-indigo-400" />}
            {activeTab === '桌面' && <Sliders className="w-4 h-4 text-indigo-400" />}
            {activeTab === '连接' && <Wifi className="w-4 h-4 text-indigo-400" />}
            {activeTab === '工具' && <Wrench className="w-4 h-4 text-indigo-400" />}
            <span>{activeTab}高级配置项</span>
          </div>
          <p className="text-xs opacity-65 leading-relaxed">
            当前模块已启用 HertzStudio 2.5 默认最佳参数（包含逐字 LRC 时间轴对齐、全局媒体键映射、网易云/QQ音乐双音源并发聚合、FLAC 完整性校验）。
          </p>
          <button
            onClick={() => onNotify(`已同步并校验「${activeTab}」配置参数`)}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-400"
          >
            恢复默认推荐值
          </button>
        </div>
      )}
    </div>
  );
};
