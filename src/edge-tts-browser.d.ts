declare module '@kingdanx/edge-tts-browser' {
  interface TTSOptions {
    voice?: string;
    pitch?: string;
    rate?: string;
    volume?: string;
    text?: string;
    fileType?: { tag: string; ext: string; mimeType?: string };
  }

  export default class EdgeTTSBrowser {
    static fileTypes: Record<string, { tag: string; ext: string }>;
    static getVoices(): Promise<Array<{ ShortName: string; FriendlyName: string; Locale: string; Gender: string }>>;
    constructor(options?: TTSOptions);
    tts: {
      text: string;
      voice: string;
      setVoiceParams(params: Partial<TTSOptions>): void;
    };
    ttsToFile(fileName?: string): Promise<Blob>;
  }
}
