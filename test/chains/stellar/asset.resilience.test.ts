import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @stellar/stellar-sdk BEFORE importing the module under test
// ---------------------------------------------------------------------------

/** ScVal stub whose `u32`, `sym` and `str` all report the same value. */
const mockScVal = (value: unknown) => ({
  u32: () => value,
  get sym() {
    return value;
  },
  get str() {
    return value;
  },
});

const mockRetval = (value: unknown) => ({ result: { retval: mockScVal(value) } });

/** i128 stub. `hi` is only attached when supplied, so the hi-absent path is real. */
const mockI128 = (lo: unknown, hi?: unknown) => ({
  result: {
    retval: {
      i128: hi === undefined ? { lo: () => lo } : { lo: () => lo, hi: () => hi },
    },
  },
});

const mockSimulateTransaction = vi.fn();

vi.mock('@stellar/stellar-sdk', () => ({
  rpc: { Server: vi.fn(() => ({ simulateTransaction: mockSimulateTransaction })) },
  Account: vi.fn(),
  Contract: vi.fn(() => ({ call: vi.fn() })),
  TransactionBuilder: vi.fn(() => ({
    addOperation: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    build: vi.fn(),
  })),
}));

import {
  getAssetMetadata,
  getAssetMetadataResult,
  getAssetBalance,
  clearAssetMetadataCache,
} from '../../../src/chains/stellar/asset';

const CONTRACT = 'CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL';
const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Calls arrive in field order: name, symbol, decimals. */
const queue = (name: unknown, symbol: unknown, decimals: unknown) => {
  mockSimulateTransaction
    .mockResolvedValueOnce(name)
    .mockResolvedValueOnce(symbol)
    .mockResolvedValueOnce(decimals);
};

describe('SEP-41 metadata resilience', () => {
  beforeEach(() => {
    clearAssetMetadataCache();
    mockSimulateTransaction.mockReset();
  });

  describe('complete', () => {
    it('reports every field and caches the result', async () => {
      queue(mockRetval('Test Asset'), mockRetval('TST'), mockRetval(7));
      const first = await getAssetMetadataResult(CONTRACT, 'testnet');

      expect(first.status).toBe('complete');
      expect(first.metadata).toEqual({ name: 'Test Asset', symbol: 'TST', decimals: 7 });
      expect(first.failures).toEqual([]);

      const second = await getAssetMetadataResult(CONTRACT, 'testnet');
      expect(second.status).toBe('complete');
      // Served from cache, so no further RPC calls.
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(3);
    });
  });

  describe('partial', () => {
    it('keeps the fields that answered when a method is missing', async () => {
      // A contract with no `name`: simulation succeeds but returns no retval.
      queue({}, mockRetval('TST'), mockRetval(7));
      const result = await getAssetMetadataResult(CONTRACT, 'testnet');

      expect(result.status).toBe('partial');
      expect(result.metadata).toEqual({ symbol: 'TST', decimals: 7 });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ field: 'name', reason: 'missing' });
    });

    it('does not cache a partial read', async () => {
      queue({}, mockRetval('TST'), mockRetval(7));
      await getAssetMetadataResult(CONTRACT, 'testnet');

      queue(mockRetval('Now Present'), mockRetval('TST'), mockRetval(7));
      const retry = await getAssetMetadataResult(CONTRACT, 'testnet');

      expect(retry.status).toBe('complete');
      expect(retry.metadata).toEqual({ name: 'Now Present', symbol: 'TST', decimals: 7 });
      // Six calls total proves the partial read was re-fetched, not served stale.
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(6);
    });
  });

  describe('unsupported', () => {
    it('reports unsupported when no field can be read', async () => {
      mockSimulateTransaction.mockResolvedValue({ error: 'no such function' });
      const result = await getAssetMetadataResult(CONTRACT, 'testnet');

      expect(result.status).toBe('unsupported');
      expect(result.metadata).toEqual({});
      expect(result.failures.map((f) => f.field)).toEqual(['name', 'symbol', 'decimals']);
      expect(result.failures.every((f) => f.reason === 'missing')).toBe(true);
    });

    it('classifies an unrecognised RPC failure as rpc-error, not missing', async () => {
      mockSimulateTransaction.mockRejectedValue(new Error('socket hang up'));
      const result = await getAssetMetadataResult(CONTRACT, 'testnet');

      expect(result.status).toBe('unsupported');
      expect(result.failures.every((f) => f.reason === 'rpc-error')).toBe(true);
    });

    it('does not cache an unsupported verdict', async () => {
      mockSimulateTransaction.mockResolvedValue({ error: 'no such function' });
      await getAssetMetadataResult(CONTRACT, 'testnet');
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(3);

      mockSimulateTransaction.mockReset();
      queue(mockRetval('Recovered'), mockRetval('RCV'), mockRetval(2));
      const retry = await getAssetMetadataResult(CONTRACT, 'testnet');
      expect(retry.status).toBe('complete');
    });
  });

  describe('value validation', () => {
    it.each([
      ['a non-integer', 7.5],
      ['a negative', -1],
      ['above the SEP-41 maximum', 19],
      ['a non-numeric ScVal', 'not a number'],
    ])('rejects %s decimals as invalid rather than caching it', async (_label, bad) => {
      queue(mockRetval('Test'), mockRetval('TST'), mockRetval(bad));
      const result = await getAssetMetadataResult(CONTRACT, 'testnet');

      expect(result.status).toBe('partial');
      expect(result.metadata.decimals).toBeUndefined();
      expect(result.failures[0]).toMatchObject({ field: 'decimals', reason: 'invalid' });
      // The crucial part: no NaN escapes onto the metadata object.
      expect(Number.isNaN(result.metadata.decimals as number)).toBe(false);
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['a number', 42],
    ])('rejects %s as a symbol', async (_label, bad) => {
      queue(mockRetval('Test'), mockRetval(bad), mockRetval(7));
      const result = await getAssetMetadataResult(CONTRACT, 'testnet');

      expect(result.status).toBe('partial');
      expect(result.metadata.symbol).toBeUndefined();
      expect(result.failures[0]).toMatchObject({ field: 'symbol', reason: 'invalid' });
    });

    it('accepts the boundary decimals values 0 and 18', async () => {
      queue(mockRetval('Zero'), mockRetval('ZRO'), mockRetval(0));
      expect((await getAssetMetadataResult(CONTRACT, 'testnet')).status).toBe('complete');

      clearAssetMetadataCache();
      queue(mockRetval('Max'), mockRetval('MAX'), mockRetval(18));
      const max = await getAssetMetadataResult(CONTRACT, 'testnet');
      expect(max.status).toBe('complete');
      expect(max.metadata.decimals).toBe(18);
    });
  });

  describe('getAssetMetadata keeps its old contract', () => {
    it('still throws, with the first failure in field order', async () => {
      mockSimulateTransaction.mockResolvedValue({ error: 'Contract panic' });
      await expect(getAssetMetadata(CONTRACT, 'testnet')).rejects.toThrow(
        'SEP-41 contract call "name" failed: Contract panic',
      );
    });

    it('still returns plain metadata on the happy path', async () => {
      queue(mockRetval('Test Asset'), mockRetval('TST'), mockRetval(7));
      await expect(getAssetMetadata(CONTRACT, 'testnet')).resolves.toEqual({
        name: 'Test Asset',
        symbol: 'TST',
        decimals: 7,
      });
    });
  });

  describe('balance decoding', () => {
    it('reads the low half when the RPC supplies no high half', async () => {
      mockSimulateTransaction.mockResolvedValue(mockI128('5000000'));
      await expect(getAssetBalance(CONTRACT, ADDRESS, 'testnet')).resolves.toBe(5_000_000n);
    });

    it('includes the high half instead of truncating to 64 bits', async () => {
      // 2^64 + 1. The previous decoder reported 1n for this.
      mockSimulateTransaction.mockResolvedValue(mockI128('1', '1'));
      await expect(getAssetBalance(CONTRACT, ADDRESS, 'testnet')).resolves.toBe((1n << 64n) + 1n);
    });

    it('treats the low half as unsigned', async () => {
      // XDR reports the bottom 64 bits as a signed int64, so -1 means all ones.
      mockSimulateTransaction.mockResolvedValue(mockI128('-1', '0'));
      await expect(getAssetBalance(CONTRACT, ADDRESS, 'testnet')).resolves.toBe((1n << 64n) - 1n);
    });

    it('throws on an undecodable response rather than reporting a zero balance', async () => {
      mockSimulateTransaction.mockResolvedValue({ result: { retval: { u32: () => 5 } } });
      await expect(getAssetBalance(CONTRACT, ADDRESS, 'testnet')).rejects.toThrow('not an i128');
    });

    it('throws on a non-integer balance component', async () => {
      mockSimulateTransaction.mockResolvedValue(mockI128('not-a-number'));
      await expect(getAssetBalance(CONTRACT, ADDRESS, 'testnet')).rejects.toThrow(
        'non-integer balance component',
      );
    });
  });
});
