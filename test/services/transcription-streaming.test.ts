import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { TranscriptionService } from '../../src/services/transcription';
import * as fs from 'fs';

// Get the current file path and directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock the nodewhisper function to return a predictable result
jest.mock('nodejs-whisper', () => ({
  nodewhisper: jest.fn().mockImplementation(() => {
    // Return a mock transcription result with timestamps
    return Promise.resolve(
      '[00:00.000 --> 00:01.000] This is the first part\n' +
      '[00:01.000 --> 00:02.000] of the transcription\n' +
      '[00:02.000 --> 00:03.000] result from the\n' +
      '[00:03.000 --> 00:04.000] audio file'
    );
  })
}));

// Mock child_process
jest.mock('child_process', () => {
  return {
    exec: jest.fn((cmd, cb) => {
      if (typeof cb === 'function') {
        cb(null, { stdout: 'mocked stdout', stderr: '' });
      }
      return { stdout: 'mocked stdout', stderr: '' };
    })
  };
});

// Mock fs
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    readFileSync: actualFs.readFileSync,
    readdirSync: actualFs.readdirSync,
    statSync: actualFs.statSync,
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(true),
    mkdirSync: jest.fn()
  };
});

describe('TranscriptionService - Streaming Functionality', () => {
  let transcriptionService: TranscriptionService;
  let testAudioBuffer: ArrayBuffer;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Create a new instance of the TranscriptionService
    transcriptionService = new TranscriptionService({
      rootDir: path.resolve(__dirname, '../../'),
      localModelName: 'base.en'
    });

    // Create a test audio buffer
    testAudioBuffer = new ArrayBuffer(1024);
    const view = new Uint8Array(testAudioBuffer);
    for (let i = 0; i < view.length; i++) {
      view[i] = i % 256;
    }

    // Mock the methods we need to control for testing
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.transcribeWithWhisper = jest.fn().mockImplementation((filePath) => {
      // Simulate the processing of the audio file with whisper
      const emitter = new EventEmitter();
      
      // Process in the next tick to simulate async behavior
      setTimeout(() => {
        // Emit partial transcription events
        emitter.emit('transcription', 'This is the first part');
        setTimeout(() => {
          emitter.emit('transcription', 'This is the first part of the transcription');
          setTimeout(() => {
            emitter.emit('transcription', 'This is the first part of the transcription result from the');
            setTimeout(() => {
              // Emit the complete event
              emitter.emit('complete', 'This is the first part of the transcription result from the audio file');
            }, 50);
          }, 50);
        }, 50);
      }, 10);
      
      return emitter;
    });
    
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.isWhisperModelPreloaded = true;
    
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.isWhisperModelDownloaded = jest.fn().mockResolvedValue(true);
    
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.preloadWhisperModel = jest.fn().mockResolvedValue(true);
    
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.convertAudio = jest.fn().mockImplementation((audioBuffer: ArrayBuffer) => {
      if (!audioBuffer || audioBuffer.byteLength === 0) {
        throw new Error('Invalid audio buffer');
      }
      return Promise.resolve(Buffer.from('mock audio data'));
    });
    
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.saveDebugAudio = jest.fn().mockResolvedValue(undefined);
    
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.ensureCacheDirectoryExists = jest.fn();
    
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.ensureDebugDirectoryExists = jest.fn();
  });

  test('should emit transcription events with partial results', async () => {
    // Create a promise that will resolve when all expected events are received
    const testPromise = new Promise<void>((resolve, reject) => {
      let receivedPartials = 0;
      let receivedComplete = false;
      let lastPartialText = '';

      // Start the streaming transcription
      const emitter = transcriptionService.transcribeLocallyStreaming(testAudioBuffer);

      // Listen for transcription events
      emitter.on('transcription', (text: string) => {
        try {
          // Verify that we're receiving partial results
          expect(text).toBeTruthy();
          // Each partial should be longer or equal to the previous one
          expect(text.length).toBeGreaterThanOrEqual(lastPartialText.length);
          lastPartialText = text;
          receivedPartials++;
        } catch (error) {
          reject(error);
        }
      });

      // Listen for the complete event
      emitter.on('complete', (finalText: string) => {
        try {
          // Verify the final transcription is not empty
          expect(finalText).toBeTruthy();
          // The final text should contain all the parts from our mock output
          expect(finalText).toContain('This is the first part');
          expect(finalText).toContain('of the transcription');
          expect(finalText).toContain('result from the');
          expect(finalText).toContain('audio file');

          receivedComplete = true;

          // Ensure we received at least one partial result
          expect(receivedPartials).toBeGreaterThan(0);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      // Listen for error events
      emitter.on('error', (error: Error) => {
        reject(error);
      });

      // Set a timeout to fail the test if it takes too long
      setTimeout(() => {
        if (!receivedComplete) {
          reject(new Error('Test timed out waiting for complete event'));
        }
      }, 5000);
    });

    // Wait for all events to be processed
    await testPromise;
  });

  test('should handle errors during audio conversion', async () => {
    // Mock the convertAudio method to throw an error
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.convertAudio = jest.fn().mockImplementation(() => {
      return Promise.reject(new Error('Failed to convert audio'));
    });

    // Create a promise that will resolve when the error event is received
    const testPromise = new Promise<void>((resolve, reject) => {
      // Start the streaming transcription
      const emitter = transcriptionService.transcribeLocallyStreaming(testAudioBuffer);

      // Listen for error events
      emitter.on('error', (error: Error) => {
        try {
          expect(error).toBeTruthy();
          expect(error.message).toContain('Failed to convert audio');
          resolve();
        } catch (testError) {
          reject(testError);
        }
      });

      // Set a timeout to fail the test if it takes too long
      setTimeout(() => {
        reject(new Error('Test timed out waiting for error event'));
      }, 5000);
    });

    // Wait for the error event to be processed
    await testPromise;
  });

  test('should handle invalid audio input', async () => {
    // Create an empty audio buffer to simulate invalid input
    const emptyAudioBuffer = new ArrayBuffer(0);

    // Create a promise that will resolve when the error event is received
    const testPromise = new Promise<void>((resolve, reject) => {
      // Start the streaming transcription with empty buffer
      const emitter = transcriptionService.transcribeLocallyStreaming(emptyAudioBuffer);

      // Listen for error events
      emitter.on('error', (error: Error) => {
        try {
          expect(error).toBeTruthy();
          expect(error.message).toContain('Invalid audio buffer');
          resolve();
        } catch (testError) {
          reject(testError);
        }
      });

      // Set a timeout to fail the test if it takes too long
      setTimeout(() => {
        reject(new Error('Test timed out waiting for error event'));
      }, 5000);
    });

    // Wait for the error event to be processed
    await testPromise;
  });
  
  test('should handle model download failure', async () => {
    // Mock the preloadWhisperModel method to simulate a download failure
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.isWhisperModelPreloaded = false;
    // @ts-ignore - Accessing private methods for testing
    transcriptionService.preloadWhisperModel = jest.fn().mockResolvedValue(false);

    // Create a promise that will resolve when the error event is received
    const testPromise = new Promise<void>((resolve, reject) => {
      // Start the streaming transcription
      const emitter = transcriptionService.transcribeLocallyStreaming(testAudioBuffer);

      // Listen for error events
      emitter.on('error', (error: Error) => {
        try {
          expect(error).toBeTruthy();
          expect(error.message).toContain('Failed to download whisper model');
          resolve();
        } catch (testError) {
          reject(testError);
        }
      });

      // Set a timeout to fail the test if it takes too long
      setTimeout(() => {
        reject(new Error('Test timed out waiting for error event'));
      }, 5000);
    });

    // Wait for the error event to be processed
    await testPromise;
  });
});
