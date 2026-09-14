// Network/browser dependencies of tts.ts. The TTS test only exercises the
// text-normalization pipeline, so these are never called — they exist so the
// bundle resolves.
export const proxyGeminiGenerateWithSignal = async (): Promise<Response> => {
  throw new Error('stub');
};
export const proxyElevenLabsTTS = async (): Promise<Response> => {
  throw new Error('stub');
};
export const proxyElevenLabsUsage = async (): Promise<Response> => {
  throw new Error('stub');
};
export const isElevenLabsEnabledForCurrentGroup = (): boolean => false;
