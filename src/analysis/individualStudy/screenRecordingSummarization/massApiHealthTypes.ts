/** Mirrors GET /api/health fields used by the screen-recording analysis UI. */

export type MassApiCapabilities = {
  ffmpeg?: boolean;
  tesseract?: boolean;
  pythonVenv?: boolean;
  timelineScriptPresent?: boolean;
  ocrScriptPresent?: boolean;
  confusionScriptPresent?: boolean;
  ocrReady?: boolean;
  timelineReady?: boolean;
  confusionReady?: boolean;
};

export type MassApiHealthSnapshot = {
  loaded: boolean;
  hasGeminiServerKey: boolean;
  hasOpenAiKey: boolean;
  capabilities: MassApiCapabilities;
};

export const INITIAL_MASS_API_HEALTH: MassApiHealthSnapshot = {
  loaded: false,
  hasGeminiServerKey: false,
  hasOpenAiKey: false,
  capabilities: {},
};
