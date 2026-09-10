import { PcmFramePipeline, type PcmFrame } from './PcmFramePipeline';

export interface MicrophoneRecorder {
  start(onFrame: (frame: PcmFrame) => void): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export class BrowserMicrophone implements MicrophoneRecorder {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private mutedOutput: GainNode | null = null;
  private pipeline = new PcmFramePipeline();
  private lifecycleGeneration = 0;

  async start(onFrame: (frame: PcmFrame) => void): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access requires HTTPS or localhost.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (generation !== this.lifecycleGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    try {
      this.context = new AudioContext();
      const publicBaseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
      await this.context.audioWorklet.addModule(new URL('audio-worklets/microphone-processor.js', publicBaseUrl));
      if (generation !== this.lifecycleGeneration) {
        await this.stop();
        return;
      }
      if (this.context.state === 'suspended') await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, 'tellus-microphone-processor');
      this.mutedOutput = this.context.createGain();
      this.mutedOutput.gain.value = 0;
      this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.context) return;
        for (const frame of this.pipeline.push(event.data, this.context.sampleRate)) onFrame(frame);
      };
      this.source.connect(this.node);
      this.node.connect(this.mutedOutput);
      this.mutedOutput.connect(this.context.destination);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async pause(): Promise<void> {
    if (this.context?.state === 'running') await this.context.suspend();
    this.pipeline.reset();
  }

  async resume(): Promise<void> {
    if (!this.context || !this.stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
      throw new Error('Unable to restart the microphone stream.');
    }
    await this.context.resume();
  }

  async stop(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.mutedOutput?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') await this.context.close().catch(() => {});
    this.context = null;
    this.node = null;
    this.source = null;
    this.stream = null;
    this.mutedOutput = null;
    this.pipeline.reset();
  }
}
