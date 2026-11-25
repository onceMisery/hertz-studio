// Lightweight Web Audio API Ambient Chord / UI Feedback Engine
class SoundEngine {
  private ctx: AudioContext | null = null;
  private isSynthEnabled: boolean = false;
  private intervalId: number | null = null;
  private volume: number = 0.7;

  private initContext() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
  }

  public setSynthEnabled(enabled: boolean, isPlaying: boolean) {
    this.isSynthEnabled = enabled;
    if (enabled && isPlaying) {
      this.startAmbientLoop();
    } else {
      this.stopAmbientLoop();
    }
  }

  public getSynthEnabled() {
    return this.isSynthEnabled;
  }

  public playChime(freq = 523.25) {
    if (!this.isSynthEnabled) return;
    try {
      this.initContext();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.06 * this.volume, now + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 1.45);
    } catch {
      // Ignore autoplay restrictions
    }
  }

  public startAmbientLoop() {
    this.stopAmbientLoop();
    if (!this.isSynthEnabled) return;
    const notes = [261.63, 329.63, 392.0, 493.88, 587.33, 440.0, 349.23, 392.0];
    let idx = 0;
    this.playChime(notes[0]);
    this.intervalId = window.setInterval(() => {
      idx = (idx + 1) % notes.length;
      this.playChime(notes[idx]);
    }, 1800);
  }

  public stopAmbientLoop() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export const soundEngine = new SoundEngine();
