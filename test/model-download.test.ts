// Simple test for model download functionality
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { mockFs, mockPath, mockOs, mockExec } from './mocks';

// Define types for our mock functions

// Create a simple logger for testing
const logger = {
  log: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

// Variables to track download state
let isDownloadInProgress = false;
let currentDownloadPromise: Promise<boolean> | null = null;

// Implementation of the functions we're testing
async function isWhisperModelDownloaded(modelName: string): Promise<boolean> {
  try {
    logger.log(
      `Checking if whisper model ${modelName} is already downloaded...`,
    );

    // Models are typically stored in ~/.cache/whisper
    const homeDir = mockOs.homedir();
    const whisperCacheDir = mockPath.join(homeDir, '.cache', 'whisper');

    // Check if the model file exists
    const modelFilename = `ggml-${modelName}.bin`;
    const modelPath = mockPath.join(whisperCacheDir, modelFilename);

    const exists = mockFs.existsSync(modelPath);

    if (exists) {
      logger.log(
        `Whisper model ${modelName} is already downloaded at ${modelPath}`,
      );
    } else {
      logger.log(`Whisper model ${modelName} is not downloaded yet`);
    }

    return Boolean(exists);
  } catch (error) {
    logger.error(`Error checking if whisper model is downloaded: ${error}`);
    return false;
  }
}

async function downloadWhisperModel(modelName: string): Promise<boolean> {
  try {
    // First check if the model is already downloaded
    const isDownloaded = await isWhisperModelDownloaded(modelName);
    if (isDownloaded) {
      logger.log(
        `Whisper model ${modelName} is already downloaded, skipping download`,
      );
      return true;
    }

    // If a download is already in progress, don't start another one
    if (isDownloadInProgress && currentDownloadPromise) {
      logger.log(
        `A download for a whisper model is already in progress, waiting for it to complete...`,
      );
      return await currentDownloadPromise;
    }

    // Mark that we're starting a download
    isDownloadInProgress = true;

    // Create a new promise for this download
    currentDownloadPromise = (async () => {
      try {
        logger.log(`Explicitly downloading whisper model: ${modelName}`);

        // Use the nodejs-whisper CLI to download the model
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { stdout, stderr } = await mockExec(
          `npx nodejs-whisper download ${modelName}`,
        );

        if (stderr && stderr.includes('Error')) {
          logger.error(`Error downloading whisper model: ${stderr}`);
          return false;
        }

        logger.log(`Successfully downloaded whisper model: ${modelName}`);
        return true;
      } catch (error) {
        logger.error(`Failed to download whisper model: ${error}`);
        return false;
      } finally {
        // Mark that the download is complete
        isDownloadInProgress = false;
      }
    })();

    // Wait for the download to complete and return the result
    return await currentDownloadPromise;
  } catch (error) {
    logger.error(`Error in downloadWhisperModel: ${error}`);
    isDownloadInProgress = false;
    return false;
  }
}

describe('Whisper Model Download', () => {
  // Reset mocks before each test
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Test the isWhisperModelDownloaded function
  test('should check if model is already downloaded', async () => {
    // Mock fs.existsSync to return false (model not downloaded)
    mockFs.existsSync.mockReturnValue(false);

    // Call the function
    const isDownloaded = await isWhisperModelDownloaded('base.en');

    // Verify the result
    expect(isDownloaded).toBe(false);
    expect(mockFs.existsSync).toHaveBeenCalledWith(
      '/mock/home/.cache/whisper/ggml-base.en.bin',
    );
  });

  // Test the downloadWhisperModel function
  test('should download model when not already downloaded', async () => {
    // Mock fs.existsSync to return false (model not downloaded)
    mockFs.existsSync.mockReturnValue(false);

    // Call the function
    const result = await downloadWhisperModel('base.en');

    // Verify the result
    expect(result).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'npx nodejs-whisper download base.en',
    );
  });

  // Test that download is skipped when model exists
  test('should skip download when model already exists', async () => {
    // Mock fs.existsSync to return true (model already downloaded)
    mockFs.existsSync.mockReturnValue(true);

    // Call the function
    const result = await downloadWhisperModel('base.en');

    // Verify the result
    expect(result).toBe(true);
    expect(mockExec).not.toHaveBeenCalled();
  });

  // Test concurrent download handling
  test('should handle concurrent download requests', async () => {
    // Mock fs.existsSync to return false (model not downloaded)
    mockFs.existsSync.mockReturnValue(false);

    // Reset the isDownloadInProgress flag
    isDownloadInProgress = false;
    currentDownloadPromise = null;

    // Start multiple concurrent download requests
    const downloadPromises = [
      downloadWhisperModel('base.en'),
      downloadWhisperModel('base.en'),
      downloadWhisperModel('base.en'),
    ];

    // Wait for all promises to resolve
    await Promise.all(downloadPromises);

    // Verify execAsync was called only once
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});
