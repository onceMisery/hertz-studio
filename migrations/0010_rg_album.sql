-- 响度归一化三档（关闭 / 按曲目 / 按专辑）：补齐专辑增益与峰值标签。
--
-- rg_gain / rg_peak 对应 REPLAYGAIN_TRACK_GAIN / _TRACK_PEAK，
-- rg_album_gain / rg_album_peak 对应 _ALBUM_*。峰值用于增益为正时的防削波
-- （有效增益不超过 -20·log10(peak)），缺失时只套 dB 值、由 DSP 链尾限幅兜底。
-- 「按专辑」档缺专辑标签时回落曲目值（与 folia 的回退规则一致）。
ALTER TABLE tracks ADD COLUMN rg_album_gain REAL;
ALTER TABLE tracks ADD COLUMN rg_peak REAL;
ALTER TABLE tracks ADD COLUMN rg_album_peak REAL;
