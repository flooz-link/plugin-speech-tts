import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

export const elizaLogger = {
  log: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
};

export interface IAgentRuntime {
  getSetting(key: string): string | undefined;
}

export interface ITranscriptionService {
  initialize(runtime: IAgentRuntime): Promise<void>;
  transcribe(audioBuffer: ArrayBuffer): Promise<string | null>;
  transcribeLocallyStreaming(audioBuffer: ArrayBuffer): EventEmitter;
}

export const settings = {
  get: jest.fn().mockImplementation((key: string) => {
    if (key === 'transcription.provider') {
      return 'local';
    }
    if (key === 'transcription.localModelName') {
      return 'base.en';
    }
    return undefined;
  }),
};

export enum TranscriptionProvider {
  Local = 'local',
  Deepgram = 'deepgram',
  OpenAI = 'openai',
}

export class Service {
  constructor() {}
}

export enum ServiceType {
  TRANSCRIPTION = 'TRANSCRIPTION',
}
