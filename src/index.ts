import {
  SpeechService,
  TranscriptionService,
  TranscriptionOptions,
} from './services/index.js';

const speechTTS = {
  name: 'default',
  description: 'Default plugin, with basic actions and evaluators',
  services: [new SpeechService() as any, new TranscriptionService() as any],
  actions: [],
};

// Explicitly re-export the services so they're available in the built package
export { SpeechService, TranscriptionService, TranscriptionOptions };

export default speechTTS;
