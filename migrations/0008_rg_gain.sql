-- 响度归一化：扫描时读出的 ReplayGain 曲目增益（dB）。
--
-- 文件标签（REPLAYGAIN_TRACK_GAIN）是扫描值，跟文件走；无标签为 NULL，
-- 播放端按「响度归一化开关」决定是否应用，preamp/限幅在 DSP 链尾兜底。
ALTER TABLE tracks ADD COLUMN rg_gain REAL;
