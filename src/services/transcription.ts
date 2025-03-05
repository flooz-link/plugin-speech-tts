import {
  elizaLogger,
  IAgentRuntime,
  ITranscriptionService,
  settings,
  TranscriptionProvider,
} from '@elizaos/core';
import { Service, ServiceType } from '@elizaos/core';
import { exec } from 'child_process';
import { File } from 'formdata-node';
import fs from 'fs';
import { nodewhisper } from 'nodejs-whisper';
import OpenAI from 'openai'; // todo, can probably move this to model provider or whateer
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { createClient, DeepgramClient } from '@deepgram/sdk';
import { TranscriptionOptions } from './transcriptionOptions';
import { EventEmitter } from 'events';

// const __dirname = path.dirname(new URL(import.meta.url).pathname); #compatibility issues with windows
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

export class TranscriptionService
  extends Service
  implements ITranscriptionService
{
  private runtime: IAgentRuntime | null = null;
  static serviceType: ServiceType = ServiceType.TRANSCRIPTION;
  private CONTENT_CACHE_DIR: string;
  private DEBUG_AUDIO_DIR: string;
  private TARGET_SAMPLE_RATE = 16000; // Common sample rate for speech recognition
  private isCudaAvailable: boolean = false;

  /**
   * CHANGED: We now use TranscriptionProvider instead of separate flags/strings.
   * This allows us to handle character settings, env variables, and fallback logic.
   */
  private transcriptionProvider: TranscriptionProvider | null = null;

  private deepgram: DeepgramClient | null = null;
  private openai: OpenAI | null = null;

  /**
   * We keep the queue and processing logic as is.
   */
  private queue: {
    audioBuffer: ArrayBuffer;
    resolve: (result: string | null) => void;
  }[] = [];
  private processing: boolean = false;

  private transcriptionOptions: TranscriptionOptions;

  private isWhisperModelPreloaded: boolean = false;

  // Track if a download is currently in progress
  private isDownloadInProgress: boolean = false;

  // Promise to track the current download process
  private currentDownloadPromise: Promise<boolean> | null = null;

  /**
   * CHANGED: initialize() now checks:
   * 1) character.settings.transcription (if available and keys exist),
   * 2) then the .env TRANSCRIPTION_PROVIDER,
   * 3) then old fallback logic (Deepgram -> OpenAI -> local).
   */
  async initialize(_runtime: IAgentRuntime): Promise<void> {
    this.runtime = _runtime;

    const openaiBaseURL = this.runtime.getSetting('OPENAI_API_URL');

    elizaLogger.log('OPENAI_API_URL', openaiBaseURL);

    // Initialize the model preload flag
    this.isWhisperModelPreloaded = false;

    // Check if the model is already downloaded
    const modelName = this.transcriptionOptions?.localModelName ?? 'base.en';
    const isAlreadyDownloaded = await this.isWhisperModelDownloaded(modelName);
    if (isAlreadyDownloaded) {
      this.isWhisperModelPreloaded = true;
      elizaLogger.log(
        `Whisper model ${modelName} is already downloaded and ready to use`,
      );
    }

    // 1) Check character settings
    let chosenProvider: TranscriptionProvider | null = null;
    const charSetting = this.runtime.character?.settings?.transcription;

    if (charSetting === TranscriptionProvider.Deepgram) {
      const deepgramKey = this.runtime.getSetting('DEEPGRAM_API_KEY');
      if (deepgramKey) {
        this.deepgram = createClient(deepgramKey);
        chosenProvider = TranscriptionProvider.Deepgram;
      }
    } else if (charSetting === TranscriptionProvider.OpenAI) {
      const openaiKey = this.runtime.getSetting('OPENAI_API_KEY');
      if (openaiKey) {
        this.openai = new OpenAI({ apiKey: openaiKey, baseURL: openaiBaseURL });
        chosenProvider = TranscriptionProvider.OpenAI;
      }
    } else if (charSetting === TranscriptionProvider.Local) {
      chosenProvider = TranscriptionProvider.Local;

      // If local transcription is chosen, preload the model
      const modelName = this.transcriptionOptions?.localModelName ?? 'base.en';
      this.preloadWhisperModel(modelName);
    }

    // 2) If not chosen from character, check .env
    if (!chosenProvider) {
      const envProvider = this.runtime.getSetting('TRANSCRIPTION_PROVIDER');
      if (envProvider) {
        switch (envProvider.toLowerCase()) {
          case 'deepgram':
            {
              const dgKey = this.runtime.getSetting('DEEPGRAM_API_KEY');
              if (dgKey) {
                this.deepgram = createClient(dgKey);
                chosenProvider = TranscriptionProvider.Deepgram;
              }
            }
            break;
          case 'openai':
            {
              const openaiKey = this.runtime.getSetting('OPENAI_API_KEY');
              if (openaiKey) {
                this.openai = new OpenAI({
                  apiKey: openaiKey,
                  baseURL: openaiBaseURL,
                });
                chosenProvider = TranscriptionProvider.OpenAI;
              }
            }
            break;
          case 'local':
            chosenProvider = TranscriptionProvider.Local;
            break;
        }
      }
    }

    // 3) If still none, fallback to old logic: Deepgram -> OpenAI -> local
    if (!chosenProvider) {
      const deepgramKey = this.runtime.getSetting('DEEPGRAM_API_KEY');
      if (deepgramKey) {
        this.deepgram = createClient(deepgramKey);
        chosenProvider = TranscriptionProvider.Deepgram;
      } else {
        const openaiKey = this.runtime.getSetting('OPENAI_API_KEY');
        if (openaiKey) {
          this.openai = new OpenAI({
            apiKey: openaiKey,
            baseURL: openaiBaseURL,
          });
          chosenProvider = TranscriptionProvider.OpenAI;
        } else {
          chosenProvider = TranscriptionProvider.Local;

          // If local transcription is the fallback, preload the model
          const modelName =
            this.transcriptionOptions?.localModelName ?? 'base.en';
          this.preloadWhisperModel(modelName);
        }
      }
    }

    this.transcriptionProvider = chosenProvider;

    // Leave detectCuda as is.
    this.detectCuda();
  }

  constructor(transcriptionOptions?: TranscriptionOptions) {
    super();
    this.transcriptionOptions = {
      rootDir:
        transcriptionOptions?.rootDir ?? path.resolve(__dirname, '../../'),
      localModelName: transcriptionOptions?.localModelName ?? 'base.en',
    };
    const rootDir = this.transcriptionOptions?.rootDir;
    this.CONTENT_CACHE_DIR = path.join(rootDir, 'content_cache');
    this.DEBUG_AUDIO_DIR = path.join(rootDir, 'debug_audio');
    this.ensureCacheDirectoryExists();
    this.ensureDebugDirectoryExists();

    // TODO: It'd be nice to handle this more gracefully, but we can do local transcription for now
    // TODO: remove the runtime from here, use it when called
    // if (runtime.getSetting("OPENAI_API_KEY")) {
    //     this.openai = new OpenAI({
    //         apiKey: runtime.getSetting("OPENAI_API_KEY"),
    //     });
    // } else {
    //     this.detectCuda();
    // }
  }

  private ensureCacheDirectoryExists() {
    if (!fs.existsSync(this.CONTENT_CACHE_DIR)) {
      fs.mkdirSync(this.CONTENT_CACHE_DIR, { recursive: true });
    }
  }

  private ensureDebugDirectoryExists() {
    if (!fs.existsSync(this.DEBUG_AUDIO_DIR)) {
      fs.mkdirSync(this.DEBUG_AUDIO_DIR, { recursive: true });
    }
  }

  private detectCuda() {
    const platform = os.platform();
    if (platform === 'linux') {
      try {
        fs.accessSync('/usr/local/cuda/bin/nvcc', fs.constants.X_OK);
        this.isCudaAvailable = true;
        elizaLogger.log(
          'CUDA detected. Transcription will use CUDA acceleration.',
        );
        // eslint-disable-next-line
            } catch (_error) {
        elizaLogger.log('CUDA not detected. Transcription will run on CPU.');
      }
    } else if (platform === 'win32') {
      const cudaPath = path.join(
        settings.CUDA_PATH ||
          'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v11.0',
        'bin',
        'nvcc.exe',
      );
      if (fs.existsSync(cudaPath)) {
        this.isCudaAvailable = true;
        elizaLogger.log(
          'CUDA detected. Transcription will use CUDA acceleration.',
        );
      } else {
        elizaLogger.log('CUDA not detected. Transcription will run on CPU.');
      }
    } else {
      elizaLogger.log(
        'CUDA not supported on this platform. Transcription will run on CPU.',
      );
    }
  }

  private async convertAudio(inputBuffer: ArrayBuffer): Promise<Buffer> {
    const inputPath = path.join(
      this.CONTENT_CACHE_DIR,
      `input_${Date.now()}.wav`,
    );
    const outputPath = path.join(
      this.CONTENT_CACHE_DIR,
      `output_${Date.now()}.wav`,
    );

    fs.writeFileSync(inputPath, Buffer.from(inputBuffer));

    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of json "${inputPath}"`,
      );
      const probeResult = JSON.parse(stdout);
      const stream = probeResult.streams[0];

      elizaLogger.log('Input audio info:', stream);

      let ffmpegCommand = `ffmpeg -i "${inputPath}" -ar ${this.TARGET_SAMPLE_RATE} -ac 1`;

      if (stream.codec_name === 'pcm_f32le') {
        ffmpegCommand += ' -acodec pcm_s16le';
      }

      ffmpegCommand += ` "${outputPath}"`;

      elizaLogger.log('FFmpeg command:', ffmpegCommand);

      await execAsync(ffmpegCommand);

      const convertedBuffer = fs.readFileSync(outputPath);
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
      return convertedBuffer;
    } catch (error) {
      elizaLogger.error('Error converting audio:', error);
      throw error;
    }
  }

  private async saveDebugAudio(audioBuffer: ArrayBuffer, prefix: string) {
    this.ensureDebugDirectoryExists();

    const filename = `${prefix}_${Date.now()}.wav`;
    const filePath = path.join(this.DEBUG_AUDIO_DIR, filename);

    fs.writeFileSync(filePath, Buffer.from(audioBuffer));
    elizaLogger.log(`Debug audio saved: ${filePath}`);
  }

  public async transcribeAttachment(
    audioBuffer: ArrayBuffer,
  ): Promise<string | null> {
    return await this.transcribe(audioBuffer);
  }

  /**
   * If the audio buffer is too short, return null. Otherwise push to queue.
   */
  public async transcribe(audioBuffer: ArrayBuffer): Promise<string | null> {
    // if the audio buffer is less than .2 seconds, just return null
    if (audioBuffer.byteLength < 0.2 * 16000) {
      return null;
    }
    return new Promise((resolve) => {
      this.queue.push({ audioBuffer, resolve });
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  public async transcribeAttachmentLocally(
    audioBuffer: ArrayBuffer,
  ): Promise<string | null> {
    return this.transcribeLocally(audioBuffer);
  }

  /**
   * CHANGED: processQueue() uses the final transcriptionProvider enum set in initialize().
   */
  private async processQueue(): Promise<void> {
    // Exit if already processing or if the queue is empty
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const { audioBuffer, resolve } = this.queue.shift()!;
      let result: string | null = null;

      switch (this.transcriptionProvider) {
        case TranscriptionProvider.Deepgram:
          result = await this.transcribeWithDeepgram(audioBuffer);
          break;
        case TranscriptionProvider.OpenAI:
          result = await this.transcribeWithOpenAI(audioBuffer);
          break;
        default:
          result = await this.transcribeLocally(audioBuffer);
      }

      resolve(result);
    }

    this.processing = false;
  }

  /**
   * Original logic from main is now handled by the final fallback in initialize().
   * We'll keep transcribeUsingDefaultLogic() if needed by other code references,
   * but it's no longer invoked in the new flow.
   */
  private async transcribeUsingDefaultLogic(
    audioBuffer: ArrayBuffer,
  ): Promise<string | null> {
    if (this.deepgram) {
      return await this.transcribeWithDeepgram(audioBuffer);
    } else if (this.openai) {
      return await this.transcribeWithOpenAI(audioBuffer);
    }
    return await this.transcribeLocally(audioBuffer);
  }

  private async transcribeWithDeepgram(
    audioBuffer: ArrayBuffer,
  ): Promise<string | null> {
    const buffer = Buffer.from(audioBuffer);
    const response = await this.deepgram.listen.prerecorded.transcribeFile(
      buffer,
      {
        model: 'nova-2',
        language: 'en-US',
        smart_format: true,
      },
    );
    const result =
      response.result.results.channels[0].alternatives[0].transcript;
    return result;
  }

  private async transcribeWithOpenAI(
    audioBuffer: ArrayBuffer,
  ): Promise<string | null> {
    elizaLogger.log('Transcribing audio with OpenAI...');

    try {
      await this.saveDebugAudio(audioBuffer, 'openai_input_original');

      const arrayBuffer = new Uint8Array(audioBuffer).buffer;
      const convertedBuffer = Buffer.from(
        await this.convertAudio(arrayBuffer),
      ).buffer;

      await this.saveDebugAudio(convertedBuffer, 'openai_input_converted');

      const file = new File([convertedBuffer], 'audio.wav', {
        type: 'audio/wav',
      });

      const result = await this.openai!.audio.transcriptions.create({
        model: 'whisper-1',
        language: 'en',
        response_format: 'text',
        file: file,
      });

      const trimmedResult = (result as any).trim();
      elizaLogger.log(`OpenAI speech to text result: "${trimmedResult}"`);

      return trimmedResult;
    } catch (error) {
      elizaLogger.error('Error in OpenAI speech-to-text conversion:', error);
      if (error.response) {
        elizaLogger.error('Response data:', error.response.data);
        elizaLogger.error('Response status:', error.response.status);
        elizaLogger.error('Response headers:', error.response.headers);
      } else if (error.request) {
        elizaLogger.error('No response received:', error.request);
      } else {
        elizaLogger.error('Error setting up request:', error.message);
      }
      return null;
    }
  }

  /**
   * Transcribes audio locally with streaming results.
   * This method processes the audio and emits transcription results as they become available.
   * @param audioBuffer The audio buffer to transcribe
   * @returns An AsyncGenerator that yields partial transcription results and completes with the final result
   */
  public async *transcribeLocallyStreaming(
    audioBuffer: ArrayBuffer,
  ): AsyncGenerator<string, string, undefined> {
    try {
      elizaLogger.log('Transcribing audio locally with streaming...');

      // Get the model name to use
      const modelName = this.transcriptionOptions?.localModelName ?? 'base.en';

      // Check if the model is already preloaded, if not, wait for it to complete
      if (!this.isWhisperModelPreloaded) {
        elizaLogger.log(
          `Whisper model not yet preloaded, waiting for download to complete...`,
        );

        try {
          // This will either start a new download or wait for an existing one
          const downloadResult = await this.preloadWhisperModel(modelName);

          if (!downloadResult) {
            elizaLogger.error(
              `Failed to download whisper model ${modelName}, will try fallback approach`,
            );
            throw new Error(`Failed to download whisper model ${modelName}`);
          }
        } catch (downloadError) {
          elizaLogger.error(
            `Error during whisper model download: ${downloadError}`,
          );
          throw downloadError;
        }
      }

      await this.saveDebugAudio(audioBuffer, 'local_streaming_input_original');

      const arrayBuffer = new Uint8Array(audioBuffer).buffer;
      const convertedBuffer = Buffer.from(
        await this.convertAudio(arrayBuffer),
      ).buffer;

      await this.saveDebugAudio(
        convertedBuffer,
        'local_streaming_input_converted',
      );

      const tempWavFile = path.join(
        this.CONTENT_CACHE_DIR,
        `temp_streaming_${Date.now()}.wav`,
      );

      // Convert the ArrayBuffer to a Uint8Array which fs.writeFileSync can handle
      const uint8Array = new Uint8Array(convertedBuffer);
      fs.writeFileSync(tempWavFile, uint8Array);

      elizaLogger.debug(
        `Temporary WAV file created for streaming: ${tempWavFile}`,
      );

      // Create a buffer to accumulate transcription results
      let accumulatedText = '';

      // Use nodewhisper with word timestamps to enable streaming-like behavior
      const output = await nodewhisper(tempWavFile, {
        modelName: modelName,
        autoDownloadModelName: modelName,
        removeWavFileAfterTranscription: false,
        withCuda: this.isCudaAvailable,
        whisperOptions: {
          outputInText: true,
          outputInVtt: false,
          outputInSrt: false,
          outputInCsv: false,
          translateToEnglish: false,
          wordTimestamps: true, // Enable word timestamps for streaming
          timestamps_length: 10, // Smaller segments for more frequent updates
          splitOnWord: true, // Split on word boundaries
        },
      });

      // Process the output to simulate streaming
      const lines = output.split('\n');
      let currentSegment = '';

      for (const line of lines) {
        // Check if this is a timestamp line (starts with '[')
        if (line.trim().startsWith('[')) {
          // If we have accumulated text in the current segment, emit it
          if (currentSegment.trim()) {
            accumulatedText += ' ' + currentSegment.trim();
            yield accumulatedText.trim(); // Yield the accumulated text so far
            currentSegment = '';
          }

          // Extract the text part after the timestamp
          const endIndex = line.indexOf(']');
          if (endIndex !== -1) {
            currentSegment = line.substring(endIndex + 1).trim();
          }
        } else if (line.trim()) {
          // Append non-empty lines to the current segment
          currentSegment += ' ' + line.trim();
        }
      }

      // Yield any remaining text
      if (currentSegment.trim()) {
        accumulatedText += ' ' + currentSegment.trim();
        yield accumulatedText.trim();
      }

      // Clean up the temporary file
      fs.unlinkSync(tempWavFile);

      // Return the final transcription
      if (accumulatedText.trim()) {
        return accumulatedText.trim();
      } else {
        throw new Error('Transcription produced empty result');
      }
    } catch (error) {
      elizaLogger.error(
        'Error in local streaming speech-to-text conversion:',
        error,
      );
      throw error;
    }
  }

  /**
   * Checks if a whisper model is already downloaded.
   * @param modelName The name of the model to check
   * @returns True if the model is already downloaded, false otherwise
   */
  private async isWhisperModelDownloaded(modelName: string): Promise<boolean> {
    try {
      elizaLogger.log(
        `Checking if whisper model ${modelName} is already downloaded...`,
      );

      // Models are typically stored in ~/.cache/whisper
      const homeDir = os.homedir();
      const whisperCacheDir = path.join(homeDir, '.cache', 'whisper');

      // Check if the model file exists
      const modelFilename = `ggml-${modelName}.bin`;
      const modelPath = path.join(whisperCacheDir, modelFilename);

      const exists = fs.existsSync(modelPath);

      if (exists) {
        elizaLogger.log(
          `Whisper model ${modelName} is already downloaded at ${modelPath}`,
        );
      } else {
        elizaLogger.log(`Whisper model ${modelName} is not downloaded yet`);
      }

      return exists;
    } catch (error) {
      elizaLogger.error(
        `Error checking if whisper model is downloaded: ${error}`,
      );
      return false;
    }
  }

  /**
   * Downloads the whisper model explicitly before transcription.
   * This ensures the model is available when transcription is needed.
   */
  private async downloadWhisperModel(modelName: string): Promise<boolean> {
    try {
      // First check if the model is already downloaded
      const isDownloaded = await this.isWhisperModelDownloaded(modelName);
      if (isDownloaded) {
        elizaLogger.log(
          `Whisper model ${modelName} is already downloaded, skipping download`,
        );
        return true;
      }

      // If a download is already in progress, don't start another one
      if (this.isDownloadInProgress && this.currentDownloadPromise) {
        elizaLogger.log(
          `A download for a whisper model is already in progress, waiting for it to complete...`,
        );
        return await this.currentDownloadPromise;
      }

      // Mark that we're starting a download
      this.isDownloadInProgress = true;

      // Create a new promise for this download
      this.currentDownloadPromise = (async () => {
        try {
          elizaLogger.log(`Explicitly downloading whisper model: ${modelName}`);

          // Use the nodejs-whisper CLI to download the model
          const { stderr } = await execAsync(
            `npx nodejs-whisper download ${modelName}`,
          );

          if (stderr && stderr.includes('Error')) {
            elizaLogger.error(`Error downloading whisper model: ${stderr}`);
            return false;
          }

          elizaLogger.log(
            `Successfully downloaded whisper model: ${modelName}`,
          );
          return true;
        } catch (error) {
          elizaLogger.error(`Failed to download whisper model: ${error}`);
          return false;
        } finally {
          // Mark that the download is complete
          this.isDownloadInProgress = false;
        }
      })();

      // Wait for the download to complete and return the result
      return await this.currentDownloadPromise;
    } catch (error) {
      elizaLogger.error(`Error in downloadWhisperModel: ${error}`);
      this.isDownloadInProgress = false;
      return false;
    }
  }

  /**
   * Public method to preload the whisper model.
   * This can be called separately to ensure the model is downloaded before any transcription is needed.
   */
  public async preloadWhisperModel(
    modelName: string = 'base.en',
  ): Promise<boolean> {
    elizaLogger.log(`Preloading whisper model: ${modelName}`);
    const result = await this.downloadWhisperModel(modelName);

    // Set the flag to indicate model is preloaded
    if (result) {
      this.isWhisperModelPreloaded = true;
      elizaLogger.log(`Whisper model ${modelName} is now preloaded`);
    }

    return result;
  }

  /**
   * Local transcription with nodejs-whisper. We keep it as it was,
   * just making sure to handle CUDA if available.
   */
  public async transcribeLocally(
    audioBuffer: ArrayBuffer,
  ): Promise<string | null> {
    try {
      elizaLogger.log('Transcribing audio locally...');

      // Get the model name to use
      const modelName = this.transcriptionOptions?.localModelName ?? 'base.en';

      // Check if the model is already preloaded, if not, wait for it to complete
      if (!this.isWhisperModelPreloaded) {
        elizaLogger.log(
          `Whisper model not yet preloaded, waiting for download to complete...`,
        );

        try {
          // This will either start a new download or wait for an existing one
          const downloadResult = await this.preloadWhisperModel(modelName);

          if (!downloadResult) {
            elizaLogger.error(
              `Failed to download whisper model ${modelName}, will try fallback approach`,
            );
            // We'll continue with autoDownloadModelName as a fallback
          }
        } catch (downloadError) {
          elizaLogger.error(
            `Error during whisper model download: ${downloadError}`,
          );
          // Continue with fallback approach
        }
      }

      await this.saveDebugAudio(audioBuffer, 'local_input_original');

      const arrayBuffer = new Uint8Array(audioBuffer).buffer;
      const convertedBuffer = Buffer.from(
        await this.convertAudio(arrayBuffer),
      ).buffer;

      await this.saveDebugAudio(convertedBuffer, 'local_input_converted');

      const tempWavFile = path.join(
        this.CONTENT_CACHE_DIR,
        `temp_${Date.now()}.wav`,
      );

      // Convert the ArrayBuffer to a Uint8Array which fs.writeFileSync can handle
      const uint8Array = new Uint8Array(convertedBuffer);
      fs.writeFileSync(tempWavFile, uint8Array);

      elizaLogger.debug(`Temporary WAV file created: ${tempWavFile}`);

      let output = await nodewhisper(tempWavFile, {
        modelName: modelName,
        autoDownloadModelName: modelName, // Keep this as fallback
        removeWavFileAfterTranscription: false,
        withCuda: this.isCudaAvailable,
        whisperOptions: {
          outputInText: true,
          outputInVtt: false,
          outputInSrt: false,
          outputInCsv: false,
          translateToEnglish: false,
          wordTimestamps: false,
          timestamps_length: 60,
          // splitOnWord: true,
        },
      });

      output = output
        .split('\n')
        .map((line) => {
          if (line.trim().startsWith('[')) {
            const endIndex = line.indexOf(']');
            return line.substring(endIndex + 1);
          }
          return line;
        })
        .join('\n');

      fs.unlinkSync(tempWavFile);

      if (!output || output.length < 5) {
        elizaLogger.log('Output is null or too short, returning null');
        return null;
      }
      return output;
    } catch (error) {
      elizaLogger.error('Error in local speech-to-text conversion:', error);
      return null;
    }
  }
}
