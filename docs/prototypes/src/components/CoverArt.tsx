import React from 'react';
import { CoverStyleType } from '../data/mockMusicData';

interface CoverArtProps {
  styleType: CoverStyleType;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'hero';
  className?: string;
  isPlaying?: boolean;
  showBadge?: boolean;
}

export const CoverArt: React.FC<CoverArtProps> = ({
  styleType,
  size = 'md',
  className = '',
  isPlaying = false,
}) => {
  const isLarge = size === 'lg' || size === 'xl' || size === 'hero';
  const isMini = size === 'xs' || size === 'sm';

  const renderArtwork = () => {
    switch (styleType) {
      case 'teleman':
        return (
          <div
            className="relative w-full h-full overflow-hidden select-none"
            style={{
              background:
                'radial-gradient(circle at 22% 18%, #EFE9D8 0%, #E2DAC4 52%, #D1C6AD 100%)',
            }}
          >
            {/* Subtle paper grain overlay */}
            <div
              className="absolute inset-0 opacity-25 pointer-events-none"
              style={{
                backgroundImage:
                  'radial-gradient(rgba(60,50,35,0.16) 1px, transparent 0)',
                backgroundSize: isMini ? '4px 4px' : '8px 8px',
              }}
            />
            {/* Top-left TELEMAN typography */}
            <div
              className={`absolute left-[7%] top-[4.5%] font-bold tracking-[0.06em] text-[#3F3B37] leading-none ${
                size === 'hero'
                  ? 'text-[30px]'
                  : size === 'xl'
                  ? 'text-[22px]'
                  : size === 'lg'
                  ? 'text-[15px]'
                  : size === 'md'
                  ? 'text-[10px]'
                  : 'text-[6px]'
              }`}
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              TELEMAN
            </div>

            {/* Large Cobalt Blue Circle */}
            <div
              className="absolute rounded-full shadow-inner transition-transform duration-700"
              style={{
                width: '41%',
                height: '41%',
                left: '12%',
                top: '26%',
                background:
                  'radial-gradient(circle at 35% 30%, #3482B5 0%, #266A98 65%, #1E577F 100%)',
                transform: isPlaying ? 'scale(1.03)' : 'scale(1)',
              }}
            />

            {/* Medium Mustard Ochre Circle */}
            <div
              className="absolute rounded-full shadow-inner transition-transform duration-700"
              style={{
                width: '23%',
                height: '23%',
                right: '11%',
                top: '23%',
                background:
                  'radial-gradient(circle at 35% 30%, #D2AF4F 0%, #C29C3B 70%, #AE892C 100%)',
                transform: isPlaying ? 'translateY(-2px)' : 'none',
              }}
            />

            {/* Small Crimson Red Circle */}
            <div
              className="absolute rounded-full shadow-inner transition-transform duration-700"
              style={{
                width: '14%',
                height: '14%',
                left: '56.5%',
                bottom: '16.5%',
                background:
                  'radial-gradient(circle at 35% 30%, #C83A4B 0%, #B22B3B 75%, #95202E 100%)',
                transform: isPlaying ? 'scale(1.08)' : 'scale(1)',
              }}
            />

            {/* Vertical BREAKFAST text on bottom right */}
            {!isMini && (
              <div
                className={`absolute right-[3.5%] bottom-[6%] font-bold tracking-[0.14em] text-[#FAF7F0]/90 leading-none ${
                  size === 'hero'
                    ? 'text-[13px]'
                    : size === 'xl'
                    ? 'text-[11px]'
                    : 'text-[7px]'
                }`}
                style={{
                  writingMode: 'vertical-rl',
                  textOrientation: 'mixed',
                }}
              >
                BREAKFAST
              </div>
            )}
          </div>
        );

      case 'polygram':
        return (
          <div
            className="relative w-full h-full overflow-hidden flex flex-col justify-between p-[8%]"
            style={{
              background:
                'linear-gradient(135deg, #2E1065 0%, #4C1D95 35%, #7C2D12 72%, #CA8A04 100%)',
            }}
          >
            <div
              className="absolute inset-0 opacity-40"
              style={{
                background:
                  'radial-gradient(circle at 50% 45%, rgba(250, 204, 21, 0.45) 0%, transparent 65%)',
              }}
            />
            <div className="relative z-10 flex items-center justify-between">
              <span
                className={`px-1.5 py-0.5 rounded bg-amber-300/20 border border-amber-300/40 text-amber-200 font-mono-tabular font-semibold ${
                  isLarge ? 'text-[10px]' : 'text-[6px]'
                }`}
              >
                24-BIT
              </span>
              {!isMini && (
                <span className="text-[8px] text-amber-200/80 tracking-widest uppercase">
                  Mastersonic
                </span>
              )}
            </div>
            <div className="relative z-10 text-center my-auto">
              <div
                className={`font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-amber-100 via-amber-300 to-amber-500 drop-shadow ${
                  size === 'hero'
                    ? 'text-3xl'
                    : isLarge
                    ? 'text-lg'
                    : isMini
                    ? 'text-[7px]'
                    : 'text-xs'
                }`}
              >
                PolyGram
              </div>
              {!isMini && (
                <div
                  className={`font-bold text-amber-200 mt-0.5 ${
                    isLarge ? 'text-base' : 'text-[9px]'
                  }`}
                >
                  宝丽金极品音色
                </div>
              )}
            </div>
            {!isMini && (
              <div className="relative z-10 h-1.5 w-full rounded-full bg-gradient-to-r from-amber-400/20 via-amber-300 to-amber-400/20" />
            )}
          </div>
        );

      case 'monochrome':
        return (
          <div
            className="relative w-full h-full overflow-hidden"
            style={{
              background:
                'linear-gradient(160deg, #090A0F 0%, #1E222B 48%, #374151 82%, #111827 100%)',
            }}
          >
            {/* Window blinds light bars */}
            <div
              className="absolute inset-0 opacity-25"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(-28deg, rgba(255,255,255,0.22) 0px, rgba(255,255,255,0.22) 4px, transparent 4px, transparent 14px)',
              }}
            />
            <div className="absolute bottom-[12%] left-[12%] right-[12%] h-[36%] rounded-t-lg bg-gradient-to-t from-black/80 to-zinc-700/30 border border-white/10 backdrop-blur-xs flex items-end p-2">
              {!isMini && (
                <span className="text-[9px] font-mono-tabular tracking-widest text-zinc-300 uppercase">
                  MONO · TAPES
                </span>
              )}
            </div>
          </div>
        );

      case 'fairytale':
        return (
          <div
            className="relative w-full h-full overflow-hidden flex flex-col justify-between p-[10%]"
            style={{
              background:
                'linear-gradient(145deg, #78350F 0%, #92400E 38%, #B45309 75%, #451A03 100%)',
            }}
          >
            <div
              className="absolute inset-[10%] rounded border-2 border-amber-200/30 bg-[#C29B61]/20 flex flex-col items-center justify-center p-2"
            >
              <div className="w-2/3 h-2/3 rounded-full border border-amber-100/40 flex items-center justify-center bg-amber-950/30">
                <div className="w-2.5 h-2.5 rounded-full bg-amber-200/80" />
              </div>
            </div>
            {!isMini && (
              <div className="relative z-10 mt-auto text-right">
                <span
                  className={`font-bold text-amber-100 bg-black/50 px-1.5 py-0.5 rounded ${
                    isLarge ? 'text-xs' : 'text-[8px]'
                  }`}
                >
                  童话镇Plus
                </span>
              </div>
            )}
          </div>
        );

      case 'starry':
        return (
          <div
            className="relative w-full h-full overflow-hidden flex items-center justify-center"
            style={{
              background:
                'radial-gradient(circle at 75% 22%, #FB7185 0%, #A855F7 32%, #2563EB 68%, #0F172A 100%)',
            }}
          >
            {/* Glowing nebula particles */}
            <div
              className="absolute w-[65%] h-[65%] rounded-full blur-md opacity-70"
              style={{
                background:
                  'conic-gradient(from 45deg, #F43F5E, #F59E0B, #38BDF8, #6366F1, #F43F5E)',
              }}
            />
            {!isMini && (
              <div
                className={`relative z-10 font-display-serif font-bold text-white drop-shadow-md tracking-widest ${
                  size === 'hero' ? 'text-3xl' : isLarge ? 'text-xl' : 'text-xs'
                }`}
                style={{ writingMode: 'vertical-rl' }}
              >
                万事
              </div>
            )}
          </div>
        );

      case 'roshomon':
        return (
          <div
            className="relative w-full h-full overflow-hidden flex items-center justify-center"
            style={{
              background:
                'linear-gradient(155deg, #E2E8F0 0%, #CBD5E1 48%, #94A3B8 85%, #64748B 100%)',
            }}
          >
            <div className="w-[56%] h-[56%] rounded-full border border-slate-600/30 bg-gradient-to-tr from-slate-400/40 to-white/70 backdrop-blur-xs flex items-center justify-center">
              <div className="w-1.5 h-1.5 rounded-full bg-slate-700" />
            </div>
          </div>
        );

      case 'jingwei':
        return (
          <div
            className="relative w-full h-full overflow-hidden"
            style={{
              background:
                'radial-gradient(circle at 30% 30%, #2DD4BF 0%, #0F766E 42%, #311042 82%, #090D16 100%)',
            }}
          >
            <div
              className="absolute inset-0 opacity-60"
              style={{
                background:
                  'linear-gradient(45deg, transparent 30%, rgba(236, 72, 153, 0.45) 50%, transparent 70%)',
              }}
            />
            {!isMini && (
              <div className="absolute bottom-2 left-2 right-2 text-center font-display-serif text-[10px] text-teal-100/90 tracking-widest">
                精卫
              </div>
            )}
          </div>
        );

      case 'halfhalf':
        return (
          <div
            className="relative w-full h-full overflow-hidden"
            style={{
              background:
                'linear-gradient(170deg, #0284C7 0%, #38BDF8 48%, #F8FAFC 52%, #E2E8F0 100%)',
            }}
          >
            <div className="absolute inset-x-0 top-[46%] h-[12%] bg-white/70 blur-xs" />
          </div>
        );

      case 'island':
        return (
          <div
            className="relative w-full h-full overflow-hidden"
            style={{
              background:
                'linear-gradient(180deg, #1E293B 0%, #475569 38%, #F59E0B 72%, #0F172A 100%)',
            }}
          >
            <div className="absolute top-[42%] left-[44%] w-2.5 h-2.5 rounded-full bg-rose-400 shadow-[0_0_12px_#FB7185]" />
          </div>
        );

      case 'memories':
        return (
          <div
            className="relative w-full h-full overflow-hidden flex items-center justify-center"
            style={{
              background:
                'linear-gradient(135deg, #0F172A 0%, #1E1B4B 55%, #4C1D95 100%)',
            }}
          >
            <div className="w-[62%] h-[62%] rotate-12 rounded-md bg-amber-50/90 shadow-md flex items-center justify-center">
              <div className="w-3 h-3 rounded-full bg-indigo-950" />
            </div>
          </div>
        );

      case 'understand':
        return (
          <div
            className="relative w-full h-full overflow-hidden"
            style={{
              background:
                'linear-gradient(135deg, #FEF08A 0%, #86EFAC 45%, #10B981 80%, #047857 100%)',
            }}
          >
            <div className="absolute bottom-0 inset-x-0 h-1/2 bg-gradient-to-t from-emerald-950/60 to-transparent" />
          </div>
        );

      case 'agent-podcast':
        return (
          <div
            className="relative w-full h-full overflow-hidden flex items-center justify-center"
            style={{
              background:
                'linear-gradient(135deg, #1E2336 0%, #272E47 50%, #171B2A 100%)',
            }}
          >
            <svg
              className="w-[46%] h-[46%] text-indigo-300/80"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
          </div>
        );

      case 'sakamoto':
        return (
          <div
            className="relative w-full h-full overflow-hidden flex flex-col justify-between p-[10%]"
            style={{
              background:
                'linear-gradient(145deg, #1E1B4B 0%, #312E81 48%, #4338CA 85%, #0F172A 100%)',
            }}
          >
            <div className="w-full h-[1px] bg-indigo-200/30 mt-auto mb-2" />
            {!isMini && (
              <div className="font-mono-tabular text-[10px] tracking-[0.2em] text-indigo-100/90">
                1996
              </div>
            )}
          </div>
        );

      case 'daftpunk':
      default:
        return (
          <div
            className="relative w-full h-full overflow-hidden flex items-center justify-center"
            style={{
              background:
                'radial-gradient(circle at 30% 25%, #F59E0B 0%, #7C2D12 40%, #090D16 88%)',
            }}
          >
            <div className="w-[54%] h-[54%] rounded-full border-2 border-amber-400/50 bg-gradient-to-b from-amber-300/30 to-sky-400/30 backdrop-blur-xs" />
          </div>
        );
    }
  };

  return (
    <div
      className={`relative overflow-hidden shrink-0 shadow-[0_8px_24px_rgba(0,0,0,0.35)] border border-white/10 ${className}`}
    >
      {renderArtwork()}
    </div>
  );
};
