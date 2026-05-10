import { spawn, execSync, type ChildProcess } from "node:child_process";

/**
 * WakeDetector — listens for a wake word using openWakeWord (Python).
 *
 * ## Installation
 * ```bash
 * pip install openwakeword pyaudio
 * ```
 * Requires Python 3.9+ and a working microphone.
 * On Windows, install PyAudio via `pip install pyaudio`.
 * On Linux, install portaudio first: `sudo apt install portaudio19-dev`.
 *
 * If openWakeWord is not installed, the detector falls back to a stub that never fires.
 */
export class WakeDetector {
  private proc: ChildProcess | null = null;
  private available: boolean;

  constructor() {
    this.available = this.checkAvailable();
  }

  private checkAvailable(): boolean {
    try {
      execSync("python3 -c \"import openwakeword\"", { stdio: "ignore" });
      return true;
    } catch {
      try {
        execSync("python -c \"import openwakeword\"", { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    }
  }

  start(onWake: () => void): void {
    if (!this.available) return; // stub: never fires
    const script = `
import openwakeword, pyaudio, numpy as np, sys
openwakeword.utils.download_models()
model = openwakeword.Model()
pa = pyaudio.PyAudio()
stream = pa.open(rate=16000, channels=1, format=pyaudio.paInt16, input=True, frames_per_buffer=1280)
while True:
    audio = np.frombuffer(stream.read(1280), dtype=np.int16)
    model.predict(audio)
    for k, v in model.prediction_buffer.items():
        if v[-1] > 0.5:
            print("WAKE", flush=True)
            model.reset()
`;
    const py = this.getPython();
    this.proc = spawn(py, ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("WAKE")) onWake();
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  private getPython(): string {
    try { execSync("python3 --version", { stdio: "ignore" }); return "python3"; } catch { return "python"; }
  }
}
