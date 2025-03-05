import { Readable } from 'node:stream';
import { Service, ISpeechService, ServiceType, IAgentRuntime, ITranscriptionService } from '@elizaos/core';

declare class SpeechService extends Service implements ISpeechService {
    static serviceType: ServiceType;
    initialize(_runtime: IAgentRuntime): Promise<void>;
    getInstance(): ISpeechService;
    generate(runtime: IAgentRuntime, text: string): Promise<Readable>;
}

interface TranscriptionOptions {
    rootDir?: string;
    localModelName?: string;
}

declare class TranscriptionService extends Service implements ITranscriptionService {
    private runtime;
    static serviceType: ServiceType;
    private CONTENT_CACHE_DIR;
    private DEBUG_AUDIO_DIR;
    private TARGET_SAMPLE_RATE;
    private isCudaAvailable;
    /**
     * CHANGED: We now use TranscriptionProvider instead of separate flags/strings.
     * This allows us to handle character settings, env variables, and fallback logic.
     */
    private transcriptionProvider;
    private deepgram;
    private openai;
    /**
     * We keep the queue and processing logic as is.
     */
    private queue;
    private processing;
    private transcriptionOptions;
    private isWhisperModelPreloaded;
    private isDownloadInProgress;
    private currentDownloadPromise;
    /**
     * CHANGED: initialize() now checks:
     * 1) character.settings.transcription (if available and keys exist),
     * 2) then the .env TRANSCRIPTION_PROVIDER,
     * 3) then old fallback logic (Deepgram -> OpenAI -> local).
     */
    initialize(_runtime: IAgentRuntime): Promise<void>;
    constructor(transcriptionOptions?: TranscriptionOptions);
    private ensureCacheDirectoryExists;
    private ensureDebugDirectoryExists;
    private detectCuda;
    private convertAudio;
    private saveDebugAudio;
    transcribeAttachment(audioBuffer: ArrayBuffer): Promise<string | null>;
    /**
     * If the audio buffer is too short, return null. Otherwise push to queue.
     */
    transcribe(audioBuffer: ArrayBuffer): Promise<string | null>;
    transcribeAttachmentLocally(audioBuffer: ArrayBuffer): Promise<string | null>;
    /**
     * CHANGED: processQueue() uses the final transcriptionProvider enum set in initialize().
     */
    private processQueue;
    /**
     * Original logic from main is now handled by the final fallback in initialize().
     * We'll keep transcribeUsingDefaultLogic() if needed by other code references,
     * but it's no longer invoked in the new flow.
     */
    private transcribeUsingDefaultLogic;
    private transcribeWithDeepgram;
    private transcribeWithOpenAI;
    /**
     * Transcribes audio locally with streaming results.
     * This method processes the audio and emits transcription results as they become available.
     * @param audioBuffer The audio buffer to transcribe
     * @returns An AsyncGenerator that yields partial transcription results and completes with the final result
     */
    transcribeLocallyStreaming(audioBuffer: ArrayBuffer): AsyncGenerator<string, string, undefined>;
    /**
     * Checks if a whisper model is already downloaded.
     * @param modelName The name of the model to check
     * @returns True if the model is already downloaded, false otherwise
     */
    private isWhisperModelDownloaded;
    /**
     * Downloads the whisper model explicitly before transcription.
     * This ensures the model is available when transcription is needed.
     */
    private downloadWhisperModel;
    /**
     * Public method to preload the whisper model.
     * This can be called separately to ensure the model is downloaded before any transcription is needed.
     */
    preloadWhisperModel(modelName?: string): Promise<boolean>;
    /**
     * Local transcription with nodejs-whisper. We keep it as it was,
     * just making sure to handle CUDA if available.
     */
    transcribeLocally(audioBuffer: ArrayBuffer): Promise<string | null>;
}

interface IStreamingTranscriptionService extends ITranscriptionService {
    /**
     * Transcribes audio locally with streaming capabilities using an AsyncGenerator
     * @param audioBuffer The audio buffer to transcribe
     * @returns An AsyncGenerator that yields partial transcription results and completes with the final result
     */
    transcribeLocallyStreaming(audioBuffer: ArrayBuffer): AsyncGenerator<string, string, undefined>;
}

declare const speechTTS: {
    name: string;
    description: string;
    services: any[];
    actions: any[];
};

export { type IStreamingTranscriptionService, SpeechService, type TranscriptionOptions, TranscriptionService, speechTTS as default };
