import React, { useState } from 'react';
import {
  X,
  FolderOpen,
  Plus,
  RefreshCw,
  CheckCircle2,
  Keyboard,
  MousePointerClick,
  Move,
  Music,
} from 'lucide-react';
import { CoverStyleType } from '../data/mockMusicData';
import { CoverArt } from './CoverArt';

interface ShortcutsModalProps {
  isOpen: boolean;
  isDark: boolean;
  onClose: () => void;
}

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({
  isOpen,
  isDark,
  onClose,
}) => {
  if (!isOpen) return null;

  const shortcuts = [
    { key: 'Space (空格)', desc: '全局播放 / 暂停当前曲目（非输入框聚焦时）' },
    { key: 'Ctrl / Cmd + K', desc: '立即聚焦顶部全局搜索框并选中文本' },
    { key: 'Esc', desc: '关闭右键菜单 / 队列抽屉 / 沉浸歌词 / 清空多选状态' },
    { key: 'Ctrl / Cmd + 点击', desc: '在曲库或列表中多选曲目，触发批量操作栏' },
    { key: '鼠标右键点击曲目', desc: '唤出高保真毛玻璃上下文菜单（播放、入队、收藏、跳专辑）' },
    { key: '拖拽任意曲目 / 封面', desc: '直接拖拽至右侧队列抽屉或悬浮入队区加入播放队列' },
  ];

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-lg rounded-2xl border p-6 shadow-2xl ${
          isDark
            ? 'bg-[#131620] border-white/12 text-zinc-100'
            : 'bg-white border-black/10 text-zinc-900'
        }`}
      >
        <div className="flex items-center justify-between pb-4 border-b border-current/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center">
              <Keyboard className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base">键盘快捷键与桌面交互指南</h3>
              <p className="text-xs opacity-60">HertzStudio Desktop Audio Workstation</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-current/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          {shortcuts.map((item, i) => (
            <div
              key={i}
              className={`flex items-center justify-between gap-4 p-2.5 rounded-xl border ${
                isDark
                  ? 'bg-white/[0.03] border-white/8'
                  : 'bg-zinc-50 border-black/6'
              }`}
            >
              <span className="text-xs opacity-80">{item.desc}</span>
              <kbd
                className={`px-2.5 py-1 rounded-md text-[11px] font-mono-tabular font-semibold shrink-0 border ${
                  isDark
                    ? 'bg-zinc-900 border-white/15 text-indigo-300'
                    : 'bg-white border-zinc-300 text-indigo-700 shadow-2xs'
                }`}
              >
                {item.key}
              </kbd>
            </div>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
          <div
            className={`p-3 rounded-xl border flex items-start gap-2.5 ${
              isDark ? 'bg-indigo-500/10 border-indigo-500/20' : 'bg-indigo-50 border-indigo-100'
            }`}
          >
            <MousePointerClick className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">多选与右键菜单</div>
              <div className="opacity-70 text-[11px] mt-0.5">
                按住 Ctrl 点击多行或开启“多选模式”即可批量入队/收藏。
              </div>
            </div>
          </div>
          <div
            className={`p-3 rounded-xl border flex items-start gap-2.5 ${
              isDark ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-emerald-50 border-emerald-100'
            }`}
          >
            <Move className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">拖拽快速入队</div>
              <div className="opacity-70 text-[11px] mt-0.5">
                按住任意歌曲行拖动，右下角将自动弹出入队感应区。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface MusicFoldersModalProps {
  isOpen: boolean;
  isDark: boolean;
  onClose: () => void;
  onRescan: (newFolderPath?: string) => void;
}

export const MusicFoldersModal: React.FC<MusicFoldersModalProps> = ({
  isOpen,
  isDark,
  onClose,
  onRescan,
}) => {
  const [folders, setFolders] = useState([
    { path: '/Users/Hertz/Music/FLAC_Lossless', count: 8, format: 'FLAC / 24-bit' },
    { path: '/Users/Hertz/Music/Hi-Res_DSD_Masters', count: 5, format: 'DSD64 / 192kHz' },
    { path: '/Users/Hertz/Music/LocalPodcasts', count: 1, format: 'FLAC / 24.0kHz' },
  ]);
  const [newPath, setNewPath] = useState('');

  if (!isOpen) return null;

  const handleAddFolder = (e: React.FormEvent) => {
    e.preventDefault();
    const pathVal = newPath.trim() || '/Volumes/Audiophile_NAS/Studio_Masters';
    setFolders((prev) => [
      ...prev,
      { path: pathVal, count: 3, format: 'Hi-Res FLAC' },
    ]);
    setNewPath('');
    onRescan(pathVal);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-lg rounded-2xl border p-6 shadow-2xl ${
          isDark
            ? 'bg-[#131620] border-white/12 text-zinc-100'
            : 'bg-white border-black/10 text-zinc-900'
        }`}
      >
        <div className="flex items-center justify-between pb-4 border-b border-current/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center">
              <FolderOpen className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base">本地音乐目录管理</h3>
              <p className="text-xs opacity-60">实时监控无损音频文件夹变动并自动解析 CUE / 内嵌封面</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-current/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          {folders.map((f, idx) => (
            <div
              key={idx}
              className={`p-3 rounded-xl border flex items-center justify-between ${
                isDark ? 'bg-white/[0.03] border-white/8' : 'bg-zinc-50 border-black/8'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-mono-tabular font-medium truncate">
                  {f.path}
                </div>
                <div className="text-[11px] opacity-60 mt-0.5 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-emerald-400">
                    <CheckCircle2 className="w-3 h-3" /> 已同步
                  </span>
                  <span>·</span>
                  <span>{f.count} 首音频</span>
                  <span>·</span>
                  <span>{f.format}</span>
                </div>
              </div>
              <button
                onClick={() => onRescan(f.path)}
                className={`px-2.5 py-1 rounded-lg text-xs inline-flex items-center gap-1 transition-colors ${
                  isDark ? 'bg-white/8 hover:bg-white/14' : 'bg-black/6 hover:bg-black/12'
                }`}
              >
                <RefreshCw className="w-3 h-3" />
                <span>重扫</span>
              </button>
            </div>
          ))}
        </div>

        <form onSubmit={handleAddFolder} className="mt-4 flex items-center gap-2">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="输入本地路径或 NAS 目录，如 /Volumes/NAS/Hi-Res..."
            className={`flex-1 px-3 py-2 rounded-xl text-xs border ${
              isDark
                ? 'bg-white/5 border-white/12 text-white placeholder:text-zinc-500'
                : 'bg-zinc-50 border-black/12 text-zinc-900 placeholder:text-zinc-400'
            }`}
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-xl text-xs font-medium bg-indigo-500 text-white hover:bg-indigo-400 inline-flex items-center gap-1.5 shrink-0 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加并扫描</span>
          </button>
        </form>
      </div>
    </div>
  );
};

interface CreatePlaylistModalProps {
  isOpen: boolean;
  isDark: boolean;
  onClose: () => void;
  onCreate: (name: string, desc: string, coverStyle: CoverStyleType) => void;
}

export const CreatePlaylistModal: React.FC<CreatePlaylistModalProps> = ({
  isOpen,
  isDark,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [coverStyle, setCoverStyle] = useState<CoverStyleType>('teleman');

  if (!isOpen) return null;

  const styles: CoverStyleType[] = [
    'teleman',
    'polygram',
    'starry',
    'sakamoto',
    'monochrome',
    'jingwei',
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(
      name.trim(),
      desc.trim() || '自定义桌面精选歌单',
      coverStyle
    );
    setName('');
    setDesc('');
    onClose();
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${
          isDark
            ? 'bg-[#131620] border-white/12 text-zinc-100'
            : 'bg-white border-black/10 text-zinc-900'
        }`}
      >
        <div className="flex items-center justify-between pb-4 border-b border-current/10">
          <div className="flex items-center gap-2">
            <Music className="w-4 h-4 text-indigo-400" />
            <h3 className="font-semibold text-base">新建本地歌单</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-current/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-medium opacity-75 mb-1.5">
              歌单名称
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：周末午后黑胶试音集"
              className={`w-full px-3.5 py-2 rounded-xl text-xs border ${
                isDark
                  ? 'bg-white/5 border-white/12 text-white'
                  : 'bg-zinc-50 border-black/12 text-zinc-900'
              }`}
            />
          </div>

          <div>
            <label className="block text-xs font-medium opacity-75 mb-1.5">
              歌单简介
            </label>
            <input
              type="text"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="记录这份歌单的聆听心情..."
              className={`w-full px-3.5 py-2 rounded-xl text-xs border ${
                isDark
                  ? 'bg-white/5 border-white/12 text-white'
                  : 'bg-zinc-50 border-black/12 text-zinc-900'
              }`}
            />
          </div>

          <div>
            <label className="block text-xs font-medium opacity-75 mb-2">
              选择 CSS 生成式艺术封面
            </label>
            <div className="grid grid-cols-6 gap-2">
              {styles.map((st) => (
                <button
                  type="button"
                  key={st}
                  onClick={() => setCoverStyle(st)}
                  className={`p-1 rounded-xl border transition-all ${
                    coverStyle === st
                      ? 'border-indigo-500 ring-2 ring-indigo-500/40 scale-105'
                      : 'border-transparent opacity-70 hover:opacity-100'
                  }`}
                >
                  <CoverArt
                    styleType={st}
                    size="xs"
                    className="w-full aspect-square rounded-lg"
                  />
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className={`px-4 py-2 rounded-xl text-xs ${
                isDark ? 'bg-white/8 hover:bg-white/12' : 'bg-black/6 hover:bg-black/10'
              }`}
            >
              取消
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-400"
            >
              创建歌单
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
