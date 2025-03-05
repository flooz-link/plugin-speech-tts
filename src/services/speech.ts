import { PassThrough } from 'stream';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import { IAgentRuntime, ISpeechService, ServiceType } from '@elizaos/core';
import { getWavHeader } from './audioUtils.js';
import { Service } from '@elizaos/core';
// import { validateNodeConfig } from '../environment.js';
import * as Echogarden from 'echogarden';
import { elizaLogger } from '@elizaos/core';

function prependWavHeader(
  readable: Readable,
  audioLength: number,
  sampleRate: number,
  channelCount: number = 1,
  bitsPerSample: number = 16,
): Readable {
  const wavHeader = getWavHeader(
    audioLength,
    sampleRate,
    channelCount,
    bitsPerSample,
  );
  let pushedHeader = false;
  const passThrough = new PassThrough();
  readable.on('data', function (data) {
    if (!pushedHeader) {
      passThrough.push(wavHeader);
      pushedHeader = true;
    }
    passThrough.push(data);
  });
  readable.on('end', function () {
    passThrough.end();
  });
  return passThrough;
}

async function getVoiceSettings(runtime: IAgentRuntime) {
  const hasElevenLabs = !!runtime.getSetting('ELEVENLABS_XI_API_KEY');
  const useVits = !hasElevenLabs;

  // Get voice settings from character card
  const vitsSettings = runtime.character.settings?.voice;
  const elevenlabsSettings = runtime.character.settings?.voice?.elevenlabs;

  elizaLogger.log('Voice settings:', {
    hasElevenLabs,
    useVits,
    vitsSettings,
    elevenlabsSettings,
  });

  return {
    elevenlabsVoiceId:
      elevenlabsSettings?.voiceId ||
      runtime.getSetting('ELEVENLABS_VOICE_ID') ||
      '21m00Tcm4TlvDq8ikWAM',
    elevenlabsModel:
      elevenlabsSettings?.model ||
      runtime.getSetting('ELEVENLABS_MODEL_ID') ||
      'eleven_multilingual_v2',
    elevenlabsStability:
      elevenlabsSettings?.stability ||
      runtime.getSetting('ELEVENLABS_VOICE_STABILITY') ||
      '0.5',
    elevenlabsStreamingLatency:
      runtime.getSetting('ELEVENLABS_OPTIMIZE_STREAMING_LATENCY') || '4',
    elevenlabsOutputFormat:
      runtime.getSetting('ELEVENLABS_OUTPUT_FORMAT') || 'pcm_16000',
    elevenlabsSimilarity:
      runtime.getSetting('ELEVENLABS_VOICE_SIMILARITY_BOOST') || '0.9',
    elevenlabsStyle: runtime.getSetting('ELEVENLABS_VOICE_STYLE') || '0.66',
    elevenlabsSpeakerBoost:
      runtime.getSetting('ELEVENLABS_VOICE_USE_SPEAKER_BOOST') || 'false',
    vitsVoice:
      vitsSettings?.model ||
      vitsSettings?.url ||
      runtime.getSetting('VITS_VOICE') ||
      'en_US-hfc_female-medium',
    elevenlabsUrl:
      runtime.getSetting('ELEVENLABS_XI_API_URL') ||
      'https://api.elevenlabs.io/v1',
    useVits,
  };
}

async function textToSpeech(runtime: IAgentRuntime, text: string) {
  // await validateNodeConfig(runtime);
  const {
    elevenlabsVoiceId,
    elevenlabsModel,
    elevenlabsUrl,
    elevenlabsStreamingLatency,
    elevenlabsOutputFormat,
    elevenlabsSimilarity,
    elevenlabsStability,
    elevenlabsStyle,
    elevenlabsSpeakerBoost,
  } = await getVoiceSettings(runtime);

  try {
    elizaLogger.log('sending request to Eleven Labs API');
    elizaLogger.log('Eleven Labs voice ID:', elevenlabsVoiceId);
    elizaLogger.log('Eleven Labs model ID:', elevenlabsModel);
    elizaLogger.log(
      'Eleven Labs streaming latency:',
      elevenlabsStreamingLatency,
    );
    elizaLogger.log('Eleven Labs output format:', elevenlabsOutputFormat);
    elizaLogger.log('Eleven Labs similarity boost:', elevenlabsSimilarity);
    elizaLogger.log('Eleven Labs stability:', elevenlabsStability);
    elizaLogger.log('Eleven Labs style:', elevenlabsStyle);
    elizaLogger.log('Eleven Labs speaker boost:', elevenlabsSpeakerBoost);

    const response = await fetch(
      `${elevenlabsUrl}/text-to-speech/${elevenlabsVoiceId}/stream?optimize_streaming_latency=${elevenlabsStreamingLatency}&output_format=${elevenlabsOutputFormat}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': runtime.getSetting('ELEVENLABS_XI_API_KEY'),
        },
        body: JSON.stringify({
          model_id: elevenlabsModel,
          text: text,
          voice_settings: {
            similarity_boost: elevenlabsSimilarity,
            stability: elevenlabsStability,
            style: elevenlabsStyle,
            use_speaker_boost: elevenlabsSpeakerBoost,
          },
        }),
      },
    );

    const status = response.status;
    if (status != 200) {
      const errorBodyString = await response.text();
      const errorBody = JSON.parse(errorBodyString);

      // Check for quota exceeded error
      if (status === 401 && errorBody.detail?.status === 'quota_exceeded') {
        elizaLogger.log('ElevenLabs quota exceeded, falling back to VITS');
        throw new Error('QUOTA_EXCEEDED');
      }

      throw new Error(
        `Received status ${status} from Eleven Labs API: ${errorBodyString}`,
      );
    }

    if (response) {
      const webStream = ReadableStream.from(response.body as ReadableStream);
      const reader = webStream.getReader();

      const readable = new Readable({
        read() {
          reader.read().then(({ done, value }) => {
            if (done) {
              this.push(null);
            } else {
              this.push(value);
            }
          });
        },
      });

      if (elevenlabsOutputFormat.startsWith('pcm_')) {
        const sampleRate = parseInt(elevenlabsOutputFormat.substring(4));
        const withHeader = prependWavHeader(
          readable,
          1024 * 1024 * 100,
          sampleRate,
          1,
          16,
        );
        return withHeader;
      } else {
        return readable;
      }
    } else {
      return new Readable({
        read() {},
      });
    }
  } catch (error) {
    if (error.message === 'QUOTA_EXCEEDED') {
      // Fall back to VITS
      const { vitsVoice } = await getVoiceSettings(runtime);
      const { audio } = await Echogarden.synthesize(text, {
        engine: 'vits',
        voice: vitsVoice,
      });

      let wavStream: Readable;
      if (audio instanceof Buffer) {
        elizaLogger.log('audio is a buffer');
        wavStream = Readable.from(audio);
      } else if ('audioChannels' in audio && 'sampleRate' in audio) {
        elizaLogger.log('audio is a RawAudio');
        const floatBuffer = Buffer.from(audio.audioChannels[0].buffer);
        elizaLogger.log('buffer length: ', floatBuffer.length);

        // Get the sample rate from the RawAudio object
        const sampleRate = audio.sampleRate;

        // Create a Float32Array view of the floatBuffer
        const floatArray = new Float32Array(floatBuffer.buffer);

        // Convert 32-bit float audio to 16-bit PCM
        const pcmBuffer = new Int16Array(floatArray.length);
        for (let i = 0; i < floatArray.length; i++) {
          pcmBuffer[i] = Math.round(floatArray[i] * 32767);
        }

        // Prepend WAV header to the buffer
        const wavHeaderBuffer = getWavHeader(
          pcmBuffer.length * 2,
          sampleRate,
          1,
          16,
        );
        const wavBuffer = Buffer.concat([
          wavHeaderBuffer,
          Buffer.from(pcmBuffer.buffer),
        ]);

        wavStream = Readable.from(wavBuffer);
      } else {
        throw new Error('Unsupported audio format');
      }
      return wavStream;
    }
    throw error; // Re-throw other errors
  }
}

async function processVitsAudio(audio: any): Promise<Readable> {
  let wavStream: Readable;
  if (audio instanceof Buffer) {
    elizaLogger.log('audio is a buffer');
    wavStream = Readable.from(audio);
  } else if ('audioChannels' in audio && 'sampleRate' in audio) {
    elizaLogger.log('audio is a RawAudio');
    const floatBuffer = Buffer.from(audio.audioChannels[0].buffer);
    elizaLogger.log('buffer length: ', floatBuffer.length);

    const sampleRate = audio.sampleRate;
    const floatArray = new Float32Array(floatBuffer.buffer);
    const pcmBuffer = new Int16Array(floatArray.length);

    for (let i = 0; i < floatArray.length; i++) {
      pcmBuffer[i] = Math.round(floatArray[i] * 32767);
    }

    const wavHeaderBuffer = getWavHeader(
      pcmBuffer.length * 2,
      sampleRate,
      1,
      16,
    );
    const wavBuffer = Buffer.concat([
      wavHeaderBuffer,
      Buffer.from(pcmBuffer.buffer),
    ]);
    wavStream = Readable.from(wavBuffer);
  } else {
    throw new Error('Unsupported audio format');
  }
  return wavStream;
}

async function generateVitsAudio(
  runtime: IAgentRuntime,
  text: string,
): Promise<Readable> {
  const { vitsVoice } = await getVoiceSettings(runtime);
  const { audio } = await Echogarden.synthesize(text, {
    engine: 'vits',
    voice: vitsVoice,
  });
  return processVitsAudio(audio);
}

export class SpeechService extends Service implements ISpeechService {
  static serviceType: ServiceType = ServiceType.SPEECH_GENERATION;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async initialize(_runtime: IAgentRuntime): Promise<void> {}

  getInstance(): ISpeechService {
    return SpeechService.getInstance();
  }

  async generate(runtime: IAgentRuntime, text: string): Promise<Readable> {
    try {
      elizaLogger.log('Generating speech for text:', text);
      const { useVits } = await getVoiceSettings(runtime);

      if (useVits || !runtime.getSetting('ELEVENLABS_XI_API_KEY')) {
        return await generateVitsAudio(runtime, text);
      }

      return await textToSpeech(runtime, text);
    } catch (error) {
      console.error('Speech generation error:', error);
      return await generateVitsAudio(runtime, text);
    }
  }
}
