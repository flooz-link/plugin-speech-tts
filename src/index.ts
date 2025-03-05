import { SpeechService, TranscriptionService } from './services/index.js';

const speechTTS = {
  name: 'default',
  description: 'Default plugin, with basic actions and evaluators',
  services: [new SpeechService() as any, new TranscriptionService() as any],
  actions: [],
};

export default speechTTS;
