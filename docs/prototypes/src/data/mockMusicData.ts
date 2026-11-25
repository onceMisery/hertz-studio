export interface LyricLine {
  time: number; // in seconds
  text: string;
  trans?: string;
}

export type CoverStyleType =
  | 'teleman'
  | 'polygram'
  | 'monochrome'
  | 'fairytale'
  | 'starry'
  | 'roshomon'
  | 'jingwei'
  | 'halfhalf'
  | 'island'
  | 'memories'
  | 'understand'
  | 'agent-podcast'
  | 'sakamoto'
  | 'daftpunk'
  | 'radiohead'
  | 'accusefive';

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // in seconds
  durationStr: string;
  quality: string;
  sampleRate: string;
  bitDepth: string;
  format: 'FLAC' | 'Hi-Res' | 'DSD' | 'ALAC' | 'MP3';
  source: 'local' | 'netease' | 'qq' | 'podcast';
  genre: '热门' | '新歌' | '摇滚' | '电子' | '民谣' | '爵士' | '古典' | 'ACG';
  liked: boolean;
  coverStyle: CoverStyleType;
  accentColor: string; // hex for ambient glow
  secondaryColor: string;
  year: number;
  filePath?: string;
  lyrics: LyricLine[];
  playCount: number;
  lastPlayed?: string;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  year: number;
  trackCount: number;
  coverStyle: CoverStyleType;
  accentColor: string;
  genre: string;
  qualityBadge: string;
  description: string;
}

export interface Artist {
  id: string;
  name: string;
  enName: string;
  genre: string;
  albumCount: number;
  trackCount: number;
  followers: string;
  bio: string;
  coverStyle: CoverStyleType;
  accentColor: string;
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  creator: string;
  coverStyle: CoverStyleType;
  accentColor: string;
  trackIds: string[];
  updatedAt: string;
  tags: string[];
}

export interface PodcastShow {
  id: string;
  title: string;
  host: string;
  region: string;
  category: string;
  rssUrl: string;
  subscribers: string;
  description: string;
  coverStyle: CoverStyleType;
  accentColor: string;
  subscribed: boolean;
  episodeTrackId: string;
}

export interface PoeticQuote {
  id: number;
  content: string;
  source: string;
  recommendedTrackId: string;
}

export const POETIC_QUOTES: PoeticQuote[] = [
  {
    id: 1,
    content: '醉后不知天在水，满船清梦压星河。',
    source: '唐温如 ·《题龙阳县青草湖》',
    recommendedTrackId: 'track-starry',
  },
  {
    id: 2,
    content: '相思似海深，旧事如天远。泪滴千千万万行，更使人、愁肠断。',
    source: '乐婉 ·《卜算子·答施》',
    recommendedTrackId: 'track-roshomon',
  },
  {
    id: 3,
    content: '今夕何夕，见此良人。子兮子兮，如此良人何。',
    source: '《诗经·唐风·绸缪》',
    recommendedTrackId: 'track-island',
  },
  {
    id: 4,
    content: '山中何事？松花酿酒，春水煎茶。',
    source: '张可久 ·《人月圆·山中书事》',
    recommendedTrackId: 'track-sakamoto',
  },
  {
    id: 5,
    content: '落霞与孤鹜齐飞，秋水共长天一色。',
    source: '王勃 ·《滕王阁序》',
    recommendedTrackId: 'track-jingwei',
  },
  {
    id: 6,
    content: '雁字回时，月满西楼，花自飘零水自流。一种相思，两处闲愁。此情无计可消除，才下眉头，却上心头。',
    source: '一剪梅·红藕香残玉簟秋',
    recommendedTrackId: 'track-teleman-1',
  },
  {
    id: 7,
    content: '庭院深深深几许，杨柳堆烟，帘幕无重数。玉勒雕鞍游冶处，楼高不见章台路。',
    source: '欧阳修 ·《蝶恋花》',
    recommendedTrackId: 'track-polygram',
  },
  {
    id: 8,
    content: '我有所念人，隔在远远乡。我有所感事，结在深深肠。',
    source: '白居易 ·《夜雨》',
    recommendedTrackId: 'track-memories',
  },
];

export const INITIAL_TRACKS: Track[] = [
  {
    id: 'track-teleman-1',
    title: 'Lady Low',
    artist: 'Teleman',
    album: 'Breakfast',
    duration: 232,
    durationStr: '3:52',
    quality: '无损 · 44.1kHz',
    sampleRate: '44.1kHz',
    bitDepth: '24-bit',
    format: 'FLAC',
    source: 'local',
    genre: '摇滚',
    liked: true,
    coverStyle: 'teleman',
    accentColor: '#3B82F6',
    secondaryColor: '#D97706',
    year: 2014,
    filePath: '/Users/Hertz/Music/FLAC/Teleman - Breakfast/04 - Lady Low.flac',
    playCount: 48,
    lastPlayed: '刚刚',
    lyrics: [
      { time: 0, text: 'Lady Low - Teleman', trans: '专辑：Breakfast (2014 · Moshi Moshi Records)' },
      { time: 12, text: 'Walking down the spiral stairs into the morning haze', trans: '沿着旋转阶梯走入晨雾之中' },
      { time: 26, text: 'Lady Low is waiting where the amber streetlight fades', trans: 'Lady Low 在琥珀色街灯渐暗处伫立等待' },
      { time: 42, text: 'All the little geometry of things we left unsaid', trans: '那些未曾言说之事，化作微妙的几何形状' },
      { time: 58, text: 'Spinning like a blue circle inside a quiet head', trans: '在静谧的脑海里如蓝色圆环般缓缓旋转' },
      { time: 78, text: 'Take your coffee slowly while the city starts to hum', trans: '当城市开始低吟，请慢些品尝手边的咖啡' },
      { time: 96, text: 'Every crooked melody is waiting for the drum', trans: '每一段蜿蜒的旋律都在等待鼓点的降临' },
      { time: 120, text: 'Oh Lady Low, where did the silver summer go?', trans: '噢 Lady Low，那个银色的夏天去向了何方？' },
      { time: 148, text: 'We drew our maps on paper napkins by the radio', trans: '我们在收音机旁的纸巾上描绘彼此的地图' },
      { time: 176, text: 'Hold the frequency steady through the midnight static rain', trans: '穿过午夜静电般的细雨，稳住这一段频率' },
      { time: 204, text: 'Until the morning light comes pouring through the windowpane', trans: '直到破晓的晨光再次倾泻在窗玻璃上' },
    ],
  },
  {
    id: 'track-agent-04',
    title: '04 | 逆向五步法（上）：工业级_Agent_框架源码如何拆解',
    artist: '未知艺术家',
    album: 'AI 工程实录 · 架构深潜',
    duration: 1321,
    durationStr: '22:01',
    quality: '无损 · 24.0kHz',
    sampleRate: '24.0kHz',
    bitDepth: '16-bit',
    format: 'FLAC',
    source: 'local',
    genre: '热门',
    liked: false,
    coverStyle: 'agent-podcast',
    accentColor: '#6366F1',
    secondaryColor: '#1E293B',
    year: 2026,
    filePath: '/Users/Hertz/Music/LocalAudio/04_逆向五步法_工业级_Agent_框架源码.flac',
    playCount: 12,
    lastPlayed: '15分钟前',
    lyrics: [
      { time: 0, text: '04 | 逆向五步法（上）：工业级 Agent 框架源码拆解', trans: '本地音频笔记 · 24.0kHz 无损录音' },
      { time: 18, text: '第一步：先不要陷入细节，从 Runtime 状态机入口开始追踪', trans: '架构视角：State Graph & Event Loop' },
      { time: 45, text: '第二步：拆解 Tool Calling 的 Schema 校验与错误回退重试机制', trans: '核心关注：确定性边界与容错设计' },
      { time: 90, text: '第三步：观察 Memory 上下文窗口是如何做滑动截断与摘要压缩的', trans: 'Token 预算管理与 KV Cache 命中率优化' },
      { time: 150, text: '第四步：多智能体 Handoff 协议中的消息总线与隔离沙箱设计', trans: '避免状态污染与死锁循环' },
      { time: 220, text: '第五步：用最小可运行内核复刻一遍核心调度循环，验证理解深度', trans: '知行合一 · 构建自己的工程直觉' },
    ],
  },
  {
    id: 'track-roshomon',
    title: '罗生门 (Follow)',
    artist: '梨冻紧, Wiz_H张子豪',
    album: '罗生门 (Follow)',
    duration: 243,
    durationStr: '4:03',
    quality: 'Hi-Res · 96kHz',
    sampleRate: '96.0kHz',
    bitDepth: '24-bit',
    format: 'Hi-Res',
    source: 'netease',
    genre: '热门',
    liked: true,
    coverStyle: 'roshomon',
    accentColor: '#94A3B8',
    secondaryColor: '#475569',
    year: 2020,
    playCount: 96,
    lastPlayed: '今天',
    lyrics: [
      { time: 0, text: '罗生门 (Follow) - 梨冻紧 / Wiz_H张子豪', trans: '词/曲：梨冻紧、Wiz_H张子豪' },
      { time: 14, text: 'Yes I do 看着你的背影消失在迷雾', trans: 'Follow you into the mist of memory' },
      { time: 29, text: '那时的我们在各自的罗生门里徘徊驻足', trans: 'Every memory has two different versions' },
      { time: 48, text: '冬天的大雪落在霓虹闪烁的街角处', trans: 'Snowflakes falling on the neon street corner' },
      { time: 68, text: '耳机的左声道还留着未说完的温度', trans: 'Left channel still carries the warmth of your voice' },
      { time: 95, text: '如果时间能够倒退回最初相遇的下午', trans: 'If time could rewind to that first afternoon' },
      { time: 130, text: '我们是否还会选择踏上同一条旅途', trans: 'Would we still choose to walk the same path?' },
    ],
  },
  {
    id: 'track-jingwei',
    title: '精卫',
    artist: '30年前，50年后',
    album: '丧失年轻，勿失年华',
    duration: 176,
    durationStr: '2:56',
    quality: '无损 · 48.0kHz',
    sampleRate: '48.0kHz',
    bitDepth: '24-bit',
    format: 'FLAC',
    source: 'netease',
    genre: '摇滚',
    liked: true,
    coverStyle: 'jingwei',
    accentColor: '#14B8A6',
    secondaryColor: '#EC4899',
    year: 2022,
    playCount: 64,
    lastPlayed: '今天',
    lyrics: [
      { time: 0, text: '精卫 - 30年前，50年后', trans: '专辑：丧失年轻，勿失年华' },
      { time: 15, text: '你与我先谈养心殿，后拜瀑淋山', trans: '穿过层叠的巨浪与岁月的回响' },
      { time: 34, text: '衔一粒微小的石子，投向无边的沧海', trans: '明知不可为而为之的孤勇与倔强' },
      { time: 58, text: '潮水退去又涌来，翅膀被海风吹散', trans: '在轰鸣的吉他音墙里重获新生' },
      { time: 88, text: '丧失年轻，勿失年华，直至海平线泛起微光', trans: 'Youth may fade, yet spirit burns bright' },
    ],
  },
  {
    id: 'track-halfhalf',
    title: '一半一半',
    artist: 'Top Barry, INDEcompany',
    album: '一半一半',
    duration: 235,
    durationStr: '3:55',
    quality: '无损 · 44.1kHz',
    sampleRate: '44.1kHz',
    bitDepth: '16-bit',
    format: 'FLAC',
    source: 'netease',
    genre: '新歌',
    liked: false,
    coverStyle: 'halfhalf',
    accentColor: '#0EA5E9',
    secondaryColor: '#E2E8F0',
    year: 2024,
    playCount: 31,
    lastPlayed: '昨天',
    lyrics: [
      { time: 0, text: '一半一半 - Top Barry / INDEcompany', trans: 'Album: 一半一半' },
      { time: 18, text: '一半是清醒的克制，一半是深夜的思念', trans: 'Half rational restraint, half midnight longing' },
      { time: 42, text: '晴空与云层将海岸线分成明暗两边', trans: 'Sky and clouds divide the coastline in two' },
      { time: 75, text: '把心事折成纸飞机，吹向有你的天际线', trans: 'Folding thoughts into paper planes toward your horizon' },
    ],
  },
  {
    id: 'track-island',
    title: '海屿你',
    artist: '马也_Crabbit',
    album: '海屿你',
    duration: 295,
    durationStr: '4:55',
    quality: 'Hi-Res · 96kHz',
    sampleRate: '96.0kHz',
    bitDepth: '24-bit',
    format: 'Hi-Res',
    source: 'netease',
    genre: '民谣',
    liked: true,
    coverStyle: 'island',
    accentColor: '#F59E0B',
    secondaryColor: '#3B82F6',
    year: 2021,
    playCount: 52,
    lastPlayed: '昨天',
    lyrics: [
      { time: 0, text: '海屿你 - 马也_Crabbit', trans: '山野千里，你是我藏在微风里的欢喜' },
      { time: 20, text: '直到飞鸟掠过晚霞染红的孤岛', trans: 'Until seabirds glide past the sunset-tinted island' },
      { time: 48, text: '海浪把你的名字写在细腻的沙滩上', trans: 'Waves write your name across the fine sand' },
      { time: 82, text: '万家灯火亮起时，晚风也为你停靠', trans: 'When ten thousand lights glow, the evening breeze docks for you' },
    ],
  },
  {
    id: 'track-memories',
    title: '把回忆拼好给你',
    artist: '王贰浪',
    album: '把回忆拼好给你',
    duration: 381,
    durationStr: '6:21',
    quality: '无损 · 44.1kHz',
    sampleRate: '44.1kHz',
    bitDepth: '24-bit',
    format: 'FLAC',
    source: 'netease',
    genre: '热门',
    liked: false,
    coverStyle: 'memories',
    accentColor: '#A855F7',
    secondaryColor: '#334155',
    year: 2019,
    playCount: 73,
    lastPlayed: '2天前',
    lyrics: [
      { time: 0, text: '把回忆拼好给你 - 王贰浪', trans: '我们将散落的碎片重新拾起' },
      { time: 24, text: '翻开旧抽屉里褪色的车票与明信片', trans: 'Opening faded tickets and postcards in the old drawer' },
      { time: 56, text: '每一块拼图都记录着当时的笑脸', trans: 'Every puzzle piece holds the smile from back then' },
      { time: 105, text: '把回忆完整拼好给你，哪怕故事已经走到终点', trans: 'Piecing all the memories back together for you' },
    ],
  },
  {
    id: 'track-understand',
    title: '开始懂了',
    artist: '孙燕姿',
    album: '我要的幸福',
    duration: 271,
    durationStr: '4:31',
    quality: 'Hi-Res · 192kHz',
    sampleRate: '192.0kHz',
    bitDepth: '24-bit',
    format: 'Hi-Res',
    source: 'netease',
    genre: '热门',
    liked: true,
    coverStyle: 'understand',
    accentColor: '#10B981',
    secondaryColor: '#84CC16',
    year: 2000,
    playCount: 118,
    lastPlayed: '3天前',
    lyrics: [
      { time: 0, text: '开始懂了 - 孙燕姿', trans: '词：姚若龙 · 曲：李偲菘 · 专辑：《我要的幸福》' },
      { time: 18, text: '我竟然没有调头，最残忍那一刻', trans: '静静看你走，一点都不像我' },
      { time: 40, text: '原来人会变得温柔，是透彻的懂了', trans: '爱情是流动的，不由人的' },
      { time: 68, text: '相信你只是怕伤害我，不是骗我', trans: '很爱过谁会舍得' },
      { time: 98, text: '把我的最好的爱给你，再微笑着大步往前走', trans: '阳光洒在肩头，风吹过绿茵的午后' },
    ],
  },
  {
    id: 'track-polygram',
    title: '漫步人生路 (24bit Audiophile Remaster)',
    artist: '邓丽君',
    album: '宝丽金88极品音色系列',
    duration: 225,
    durationStr: '3:45',
    quality: 'DSD64 · 2.8MHz',
    sampleRate: '88.2kHz',
    bitDepth: '24-bit',
    format: 'DSD',
    source: 'local',
    genre: '古典',
    liked: true,
    coverStyle: 'polygram',
    accentColor: '#EAB308',
    secondaryColor: '#9333EA',
    year: 1996,
    filePath: '/Users/Hertz/Music/Hi-Res/PolyGram_88/01_漫步人生路_DSD.dff',
    playCount: 85,
    lastPlayed: '昨天',
    lyrics: [
      { time: 0, text: '漫步人生路 - 邓丽君 (PolyGram Denon Mastersonic)', trans: '宝丽金88极品音色系列 · 劲爆音乐彻底震撼视听神经' },
      { time: 16, text: '在你身边路虽远未疲倦，伴你漫行一段接一段', trans: 'Walking beside you, though the road is long I never tire' },
      { time: 38, text: '越过高峰另一峰却又见，目标推远让理想永远在前面', trans: 'Beyond one peak another rises into view' },
      { time: 66, text: '路纵崎岖亦不怕受磨练，愿一生中苦痛快乐也体验', trans: 'Unfraid of rugged paths, embracing every joy and trial' },
    ],
  },
  {
    id: 'track-fairytale',
    title: '童话镇 Plus (Studio Acoustic)',
    artist: '暗杠, 陈一发儿',
    album: '童话镇Plus 独立民谣集',
    duration: 258,
    durationStr: '4:18',
    quality: '无损 · 48.0kHz',
    sampleRate: '48.0kHz',
    bitDepth: '24-bit',
    format: 'FLAC',
    source: 'local',
    genre: '民谣',
    liked: false,
    coverStyle: 'fairytale',
    accentColor: '#D97706',
    secondaryColor: '#78350F',
    year: 2017,
    filePath: '/Users/Hertz/Music/FLAC/IndieFolk/童话镇Plus.flac',
    playCount: 41,
    lastPlayed: '2天前',
    lyrics: [
      { time: 0, text: '童话镇 Plus - 独立木吉他录音室版', trans: '木吉他指弹与温暖人声模拟母带' },
      { time: 19, text: '听说白雪公主在逃跑，小红帽在担心大灰狼', trans: '听说疯帽喜欢爱丽丝，丑小鸭会变成白天鹅' },
      { time: 48, text: '总有一条蜿蜒在童话镇里七彩的河', trans: '沾染魔法的乖张气息，却又在爱里曲折' },
    ],
  },
  {
    id: 'track-starry',
    title: '万事 · 银河夜航船',
    artist: '棱镜乐队, 不才',
    album: '万事 · 城市星图',
    duration: 282,
    durationStr: '4:42',
    quality: 'Hi-Res · 96kHz',
    sampleRate: '96.0kHz',
    bitDepth: '24-bit',
    format: 'Hi-Res',
    source: 'local',
    genre: 'ACG',
    liked: true,
    coverStyle: 'starry',
    accentColor: '#F43F5E',
    secondaryColor: '#3B82F6',
    year: 2025,
    filePath: '/Users/Hertz/Music/Hi-Res/万事_城市星图.flac',
    playCount: 67,
    lastPlayed: '今天',
    lyrics: [
      { time: 0, text: '万事 · 银河夜航船', trans: '专辑：《万事 · 城市星图》24bit/96kHz' },
      { time: 18, text: '绚烂的烟火在靛蓝色的夜空里次第盛开', trans: 'Fireworks bloom across the indigo night sky' },
      { time: 45, text: '我们在星河倒映的岸边并肩仰望未来', trans: 'Standing side by side along the star-reflected shore' },
      { time: 80, text: '愿世间万事皆有回响，每次重逢都如初见般明亮', trans: 'May all things find their echo in this vast universe' },
    ],
  },
  {
    id: 'track-monochrome',
    title: 'Midnight Room (凌晨三点的房间)',
    artist: 'Sunset Rollercoaster 落日飞车',
    album: 'Monochrome Tapes',
    duration: 249,
    durationStr: '4:09',
    quality: '无损 · 44.1kHz',
    sampleRate: '44.1kHz',
    bitDepth: '24-bit',
    format: 'FLAC',
    source: 'local',
    genre: '爵士',
    liked: true,
    coverStyle: 'monochrome',
    accentColor: '#64748B',
    secondaryColor: '#1E293B',
    year: 2023,
    filePath: '/Users/Hertz/Music/FLAC/Monochrome_Tapes/02_Midnight_Room.flac',
    playCount: 54,
    lastPlayed: '今天',
    lyrics: [
      { time: 0, text: 'Midnight Room - 落日飞车', trans: 'Lo-Fi Bedroom Synth & Jazz Saxophone' },
      { time: 22, text: 'Black and white shadows across the bedroom floor', trans: '黑白光影斜映在静谧的卧室地板上' },
      { time: 52, text: 'Vinyl needle spinning softly by the half-closed door', trans: '唱针在半掩的门边轻柔地旋转' },
      { time: 90, text: 'Let the analog synthesizer carry us to dawn', trans: '让模拟合成器的温暖波形带我们驶向黎明' },
    ],
  },
  {
    id: 'track-sakamoto',
    title: 'Merry Christmas Mr. Lawrence',
    artist: 'Ryuichi Sakamoto 坂本龙一',
    album: '1996 (Audiophile Edition)',
    duration: 286,
    durationStr: '4:46',
    quality: 'DSD128 · 5.6MHz',
    sampleRate: '176.4kHz',
    bitDepth: '24-bit',
    format: 'DSD',
    source: 'local',
    genre: '古典',
    liked: true,
    coverStyle: 'sakamoto',
    accentColor: '#818CF8',
    secondaryColor: '#312E81',
    year: 1996,
    filePath: '/Users/Hertz/Music/Hi-Res/Sakamoto_1996/01_Merry_Christmas_Mr_Lawrence.dsf',
    playCount: 142,
    lastPlayed: '昨天',
    lyrics: [
      { time: 0, text: 'Merry Christmas Mr. Lawrence (Instrumental)', trans: '作曲 / 钢琴：坂本龙一 Ryuichi Sakamoto' },
      { time: 25, text: '【前奏】清冷而克制的五声音阶钢琴主题缓缓响起', trans: 'Crystalline piano notes echoing in an empty hall' },
      { time: 65, text: '【展开】大提琴与小提琴交织出温暖而苍凉的叙事', trans: 'Cello and violin interweave in poignant harmony' },
      { time: 130, text: '【高潮】情绪如暴风雪般层层推进，叩击心灵深处', trans: 'Crescendo of timeless acoustic emotion' },
    ],
  },
  {
    id: 'track-daftpunk',
    title: 'Instant Crush (feat. Julian Casablancas)',
    artist: 'Daft Punk',
    album: 'Random Access Memories',
    duration: 337,
    durationStr: '5:37',
    quality: 'Hi-Res · 88.2kHz',
    sampleRate: '88.2kHz',
    bitDepth: '24-bit',
    format: 'Hi-Res',
    source: 'qq',
    genre: '电子',
    liked: true,
    coverStyle: 'daftpunk',
    accentColor: '#F59E0B',
    secondaryColor: '#0EA5E9',
    year: 2013,
    playCount: 89,
    lastPlayed: '3天前',
    lyrics: [
      { time: 0, text: 'Instant Crush - Daft Punk & Julian Casablancas', trans: 'Album: Random Access Memories (Columbia Records)' },
      { time: 22, text: 'I didn’t want to be the one to forget', trans: '我并不想成为那个率先遗忘的人' },
      { time: 48, text: 'I thought of everything I’d never regret', trans: '我曾设想过所有不会令我懊悔的事' },
      { time: 80, text: 'And we will never be alone again, cause it doesn’t happen every day', trans: '我们不会再孤单一人，因为这样的共鸣并非每天都会发生' },
    ],
  },
];

export const MOCK_ALBUMS: Album[] = [
  {
    id: 'alb-breakfast',
    title: 'Breakfast',
    artist: 'Teleman',
    year: 2014,
    trackCount: 10,
    coverStyle: 'teleman',
    accentColor: '#3B82F6',
    genre: 'Indietronica / Art Pop',
    qualityBadge: 'FLAC 24bit/44.1kHz',
    description: '英国伦敦独立乐队 Teleman 首张录音室专辑，由 Suede 前吉他手 Bernard Butler 担纲制作，极简包豪斯几何美学与精致合成器流行曲风完美交融。',
  },
  {
    id: 'alb-polygram',
    title: '宝丽金88极品音色系列',
    artist: '邓丽君 / 群星',
    year: 1996,
    trackCount: 18,
    coverStyle: 'polygram',
    accentColor: '#EAB308',
    genre: 'Cantopop / Audiophile',
    qualityBadge: 'DSD64 2.8MHz',
    description: '日本天龙 Denon Mastersonic 20-Bit 黄金母带重制系列，保留模拟磁带最醇厚的人声泛音与动态余量。',
  },
  {
    id: 'alb-monochrome',
    title: 'Monochrome Tapes',
    artist: 'Sunset Rollercoaster 落日飞车',
    year: 2023,
    trackCount: 8,
    coverStyle: 'monochrome',
    accentColor: '#64748B',
    genre: 'City Pop / Synth Jazz',
    qualityBadge: 'FLAC 24bit/48kHz',
    description: '收录于午夜卧室与巡演间隙的黑白模拟磁带小样，充满慵懒的萨克斯风与温暖的罗德斯电钢琴。',
  },
  {
    id: 'alb-starry',
    title: '万事 · 城市星图',
    artist: '棱镜乐队, 不才',
    year: 2025,
    trackCount: 11,
    coverStyle: 'starry',
    accentColor: '#F43F5E',
    genre: 'Indie Pop / Post-Rock',
    qualityBadge: 'Hi-Res 24bit/96kHz',
    description: '献给夜行者的浪漫声音星图，用宽广的混响声场勾勒城市天际线与漫天星河。',
  },
  {
    id: 'alb-sakamoto',
    title: '1996 (Audiophile Remaster)',
    artist: 'Ryuichi Sakamoto 坂本龙一',
    year: 1996,
    trackCount: 16,
    coverStyle: 'sakamoto',
    accentColor: '#818CF8',
    genre: 'Modern Classical',
    qualityBadge: 'DSD128 5.6MHz',
    description: '坂本龙一经典钢琴三重奏精选录音，极致纯净的木质琴腔共鸣与空气感。',
  },
  {
    id: 'alb-understand',
    title: '我要的幸福',
    artist: '孙燕姿',
    year: 2000,
    trackCount: 12,
    coverStyle: 'understand',
    accentColor: '#10B981',
    genre: 'Mandopop',
    qualityBadge: 'Hi-Res 24bit/192kHz',
    description: '华语流行音乐千禧年代表作，母带重制版带来极具穿透力的钢琴与弦乐层次。',
  },
  {
    id: 'alb-daftpunk',
    title: 'Random Access Memories',
    artist: 'Daft Punk',
    year: 2013,
    trackCount: 13,
    coverStyle: 'daftpunk',
    accentColor: '#F59E0B',
    genre: 'Electronic / Disco',
    qualityBadge: 'Hi-Res 24bit/88.2kHz',
    description: '格莱美年度最佳专辑，致敬70/80年代模拟录音室黄金岁月，动态范围堪称现代电子乐标杆。',
  },
  {
    id: 'alb-fairytale',
    title: '童话镇Plus 独立民谣集',
    artist: '暗杠, 陈一发儿',
    year: 2017,
    trackCount: 9,
    coverStyle: 'fairytale',
    accentColor: '#D97706',
    genre: 'Indie Folk',
    qualityBadge: 'FLAC 24bit/48kHz',
    description: '手绘质感封套与不插电原声吉他现场录音，还原近场监听般的温暖呼吸声。',
  },
];

export const MOCK_ARTISTS: Artist[] = [
  {
    id: 'art-teleman',
    name: 'Teleman',
    enName: 'London Indietronica Quartet',
    genre: 'Indietronica / Britpop',
    albumCount: 4,
    trackCount: 42,
    followers: '12.8万',
    bio: '来自英国伦敦的四人独立电子摇滚乐队，以复古模拟合成器音色、包豪斯视觉美学与清澈叙事感人声闻名。',
    coverStyle: 'teleman',
    accentColor: '#3B82F6',
  },
  {
    id: 'art-sakamoto',
    name: 'Ryuichi Sakamoto 坂本龙一',
    enName: 'Composer & Pianist',
    genre: 'Modern Classical / Ambient',
    albumCount: 28,
    trackCount: 310,
    followers: '98.4万',
    bio: '世界级音乐家、电影配乐大师，作品横跨先锋电子、现代古典与环境音乐，“艺术千秋，人生朝露”。',
    coverStyle: 'sakamoto',
    accentColor: '#818CF8',
  },
  {
    id: 'art-stefanie',
    name: '孙燕姿',
    enName: 'Stefanie Sun',
    genre: 'Mandopop',
    albumCount: 14,
    trackCount: 156,
    followers: '245.0万',
    bio: '华语乐坛极具辨识度的标志性女歌手，声线清亮洒脱，演绎无数世代共同的青春记忆。',
    coverStyle: 'understand',
    accentColor: '#10B981',
  },
  {
    id: 'art-teresa',
    name: '邓丽君',
    enName: 'Teresa Teng',
    genre: 'Classic / Audiophile',
    albumCount: 35,
    trackCount: 420,
    followers: '310.5万',
    bio: '亚洲传奇歌唱家，宝丽金母带录音至今仍是Hi-Fi发烧友测试人声结像与中频密度的试音金曲。',
    coverStyle: 'polygram',
    accentColor: '#EAB308',
  },
  {
    id: 'art-daftpunk',
    name: 'Daft Punk',
    enName: 'French Touch Duo',
    genre: 'Electronic / Synth',
    albumCount: 6,
    trackCount: 74,
    followers: '186.2万',
    bio: '法国传奇电子音乐组合，将模拟合成器、放克贝斯与未来主义声码器推向艺术巅峰。',
    coverStyle: 'daftpunk',
    accentColor: '#F59E0B',
  },
  {
    id: 'art-sunset',
    name: 'Sunset Rollercoaster 落日飞车',
    enName: 'Romantic Synth Pop Band',
    genre: 'City Pop / Jazz Rock',
    albumCount: 5,
    trackCount: 48,
    followers: '64.3万',
    bio: '以浪漫迷幻的合成器浪潮与爵士律动著称，现场演出如同一场永不落幕的海边黄昏电影。',
    coverStyle: 'monochrome',
    accentColor: '#64748B',
  },
];

export const INITIAL_PLAYLISTS: Playlist[] = [
  {
    id: 'pl-audiophile',
    name: 'Hi-Res 母带试音室 · 24bit 精选',
    description: '专为桌面解码耳放与近场监听音箱挑选的高动态无损曲目，涵盖弦乐、人声结像与深潜低频测试。',
    creator: 'HertzStudio 官方调音台',
    coverStyle: 'polygram',
    accentColor: '#EAB308',
    trackIds: ['track-teleman-1', 'track-polygram', 'track-sakamoto', 'track-daftpunk', 'track-understand'],
    updatedAt: '2026-11-25',
    tags: ['Hi-Res', '试音碟', '24bit/96kHz'],
  },
  {
    id: 'pl-midnight',
    name: '深夜代码与沉浸心流 (Deep Focus)',
    description: '适合深夜编程、架构拆解与长文阅读的低干扰器乐与英伦独立电子歌单。',
    creator: 'Hertz 工程师',
    coverStyle: 'teleman',
    accentColor: '#3B82F6',
    trackIds: ['track-teleman-1', 'track-monochrome', 'track-sakamoto', 'track-agent-04', 'track-halfhalf'],
    updatedAt: '2026-11-24',
    tags: ['心流', 'Coding', 'Indietronica'],
  },
  {
    id: 'pl-nightdrive',
    name: '霓虹夜航 · 华语独立与流行',
    description: '穿梭在城市高架桥上的晚风旋律，从《罗生门》到《海屿你》。',
    creator: 'HertzStudio',
    coverStyle: 'starry',
    accentColor: '#F43F5E',
    trackIds: ['track-roshomon', 'track-jingwei', 'track-island', 'track-memories', 'track-starry', 'track-fairytale'],
    updatedAt: '2026-11-23',
    tags: ['夜行', '流行', '氛围感'],
  },
];

export const INITIAL_PODCASTS: PodcastShow[] = [
  {
    id: 'pod-storyfm',
    title: '故事FM',
    host: '爱哲 · 真实故事电台',
    region: '中国大陆',
    category: '社会与纪实',
    rssUrl: 'https://storyfm.cn/feed/episodes',
    subscribers: '142万',
    description: '用你的声音，讲述你的故事。收集当代人最真实的人生切片与声音档案。',
    coverStyle: 'fairytale',
    accentColor: '#EF4444',
    subscribed: true,
    episodeTrackId: 'track-agent-04',
  },
  {
    id: 'pod-left-right',
    title: '忽左忽右',
    host: '程衍樑 / 杨一 · JustPod',
    region: '中国大陆',
    category: '历史与文化',
    rssUrl: 'https://justpodmedia.com/rss/leftright.xml',
    subscribers: '89万',
    description: '试图在立场先行的时代，寻找知识、思想与文化沙龙的公共讨论空间。',
    coverStyle: 'teleman',
    accentColor: '#F59E0B',
    subscribed: true,
    episodeTrackId: 'track-agent-04',
  },
  {
    id: 'pod-etw',
    title: '声东击西',
    host: '徐涛 · 科技与人文交叉口',
    region: '中国大陆',
    category: '科技与世界',
    rssUrl: 'https://etw.fm/rss',
    subscribers: '76万',
    description: '邀请驻外记者、学者与创造者，从意想不到的角度观察技术变革与全球文化。',
    coverStyle: 'island',
    accentColor: '#3B82F6',
    subscribed: false,
    episodeTrackId: 'track-agent-04',
  },
  {
    id: 'pod-agent',
    title: '架构深潜 · AI 工程实录',
    host: 'Hertz Tech Lab',
    region: '中国大陆',
    category: '软件工程',
    rssUrl: 'https://hertzstudio.dev/podcast/rss.xml',
    subscribers: '34万',
    description: '深入拆解工业级 Agent 框架源码、音频 DSP 引擎与现代桌面软件工程架构。',
    coverStyle: 'agent-podcast',
    accentColor: '#6366F1',
    subscribed: true,
    episodeTrackId: 'track-agent-04',
  },
];

export interface ReadingArticle {
  id: string;
  title: string;
  subtitle: string;
  author: string;
  readTime: string;
  tag: string;
  coverStyle: CoverStyleType;
  excerpt: string;
  content: string[];
  relatedTrackId: string;
}

export const READING_ARTICLES: ReadingArticle[] = [
  {
    id: 'read-1',
    title: '从包豪斯几何到英伦合成器：重听 Teleman《Breakfast》',
    subtitle: '为什么十年前的独立流行唱片依然是桌面聆听的最佳伴侣？',
    author: '林深 · 唱片内页志',
    readTime: '6 分钟阅读',
    tag: '唱片内页 Liner Notes',
    coverStyle: 'teleman',
    excerpt: '当《Lady Low》第一个带着轻微磁带饱和感的鼓点响起时，封面上那三个纯粹的蓝、黄、红几何圆仿佛开始在空气中缓慢公转……',
    content: [
      '2014年夏天发行的《Breakfast》，由前 Suede 传奇吉他手 Bernard Butler 操刀制作。他刻意拿掉了厚重的失真吉他音墙，转而使用温暖的模拟风琴、干脆利落的箱琴切音以及极具空间留白的贝斯线条。',
      '专辑封面致敬了早期企鹅出版社（Penguin Books）与包豪斯色彩构成：温暖的米色颗粒纸底上，钴蓝、芥末黄与绯红三个圆点保持着微妙的引力平衡。',
      '在 HertzStudio 桌面端开启“封面氛围光”后，从封面提取的钴蓝与暖金微光会随节拍自然晕染在深色磨砂工作台上。',
    ],
    relatedTrackId: 'track-teleman-1',
  },
  {
    id: 'read-2',
    title: '24-bit/96kHz 与独占模式：桌面高解析音频链路指南',
    subtitle: '绕过操作系统混音器 SRC 重采样，释放无损曲库的真实动态',
    author: 'Hertz 声学实验室',
    readTime: '8 分钟阅读',
    tag: 'Hi-Fi 声学专栏',
    coverStyle: 'polygram',
    excerpt: '很多时候，阻碍一副好耳机发挥实力的不是音源文件本身，而是系统默认音频栈中的强制采样率转换（SRC）……',
    content: [
      '当你在本地曲库播放一首 44.1kHz 或 96kHz 的 FLAC 无损曲目时，通用的系统混音器往往会将其统一重采样至 48kHz。这种非整数倍的插值运算会引入微妙的相位失真与高频毛刺。',
      '在 HertzStudio 的「设置 -> 播放」中开启 WASAPI 独占模式或 CoreAudio 整数模式，即可将原始 PCM 比特流直接送往外置 DAC 解码器。',
    ],
    relatedTrackId: 'track-polygram',
  },
  {
    id: 'read-3',
    title: '坂本龙一《1996》：在琴键与呼吸之间的永恒留白',
    subtitle: '室内乐三重奏录音中的近场麦克风摆位美学',
    author: '周行 · 古典印象',
    readTime: '5 分钟阅读',
    tag: '录音艺术',
    coverStyle: 'sakamoto',
    excerpt: '在《1996》这张专辑中，你不仅能听到钢琴琴槌敲击琴弦的瞬间泛音，甚至能听见小提琴弓毛擦过松香与演奏者克制的呼吸声……',
    content: [
      '真正的顶级录音从不追求过度涂抹的顺滑，而是诚实地保留乐器在物理空间中的振动纹理。',
      '戴上开放式耳机，在夜晚将音量调至舒适的 -18dB，闭上眼睛即可看见舞台上三位乐手的位置结像。',
    ],
    relatedTrackId: 'track-sakamoto',
  },
];
