export const elizaLogger = {
  log: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

export class Service {
  constructor() {}
}

export const ServiceType = {
  TRANSCRIPTION: 'TRANSCRIPTION',
};

export const TranscriptionProvider = {
  Local: 'local',
  Deepgram: 'deepgram',
  OpenAI: 'openai',
};

export const settings = {
  get: jest.fn(),
};

export const IAgentRuntime = jest.fn();
export const ITranscriptionService = jest.fn();
