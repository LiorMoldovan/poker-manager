// Inert stand-ins for the browser-only side modules geminiAI.ts pulls in
// (usage metering, eligibility, device-local key, training data, debug log).
// None of them shape the prompt text, so the lab neutralises them.

export const recordSuccess = () => {};
export const recordRateLimit = () => {};
export const readRateLimitHeaders = () => undefined;

export const isGeminiEnabledForCurrentGroup = () => true;
export const getLocalGeminiKey = () => '';

export const fetchTrainingAnswers = async () => [];

export const logChipCountAttempt = () => {};
