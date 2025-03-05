// Mock implementations for tests
import { jest } from '@jest/globals';

// Define the type for exec result
interface ExecResult {
  stdout: string;
  stderr: string;
}

export const mockFs = {
  existsSync: jest.fn(),
};

export const mockPath = {
  join: jest.fn((...args: string[]) => args.join('/')),
};

export const mockOs = {
  homedir: jest.fn(() => '/mock/home'),
};

// Create a typed mock for exec
export const mockExec = jest.fn<(cmd: string) => Promise<ExecResult>>();
mockExec.mockResolvedValue({
  stdout: 'Model downloaded successfully',
  stderr: '',
});

export const mockPromisify = jest.fn(() => mockExec);
