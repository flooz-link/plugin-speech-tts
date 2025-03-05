import { ITranscriptionService } from '@elizaos/core';
import { z } from 'zod';

export const FileLocationResultSchema = z.object({
  fileLocation: z.string().min(1),
});

export type FileLocationResult = z.infer<typeof FileLocationResultSchema>;

export function isFileLocationResult(obj: unknown): obj is FileLocationResult {
  return FileLocationResultSchema.safeParse(obj).success;
}

export interface IStreamingTranscriptionService extends ITranscriptionService {
  /**
   * Transcribes audio locally with streaming capabilities using an AsyncGenerator
   * @param audioBuffer The audio buffer to transcribe
   * @returns An AsyncGenerator that yields partial transcription results and completes with the final result
   */
  transcribeLocallyStreaming(
    audioBuffer: ArrayBuffer,
  ): AsyncGenerator<string, string, undefined>;
}
