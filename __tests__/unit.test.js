const { sanitizeMessages, calculateCost, hashPassword } = require('../server');

// ==================== UNIT TESTS ====================

describe('hashPassword', () => {
  test('returns consistent SHA-256 hash', () => {
    const hash1 = hashPassword('test123');
    const hash2 = hashPassword('test123');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  test('different passwords produce different hashes', () => {
    expect(hashPassword('abc')).not.toBe(hashPassword('xyz'));
  });
});

describe('calculateCost', () => {
  const settings = { profit_margin: 30, eur_rate: 0.92 };

  test('calculates cost for valid model', () => {
    const result = calculateCost(1000, 500, 'claude-haiku-3-5-20241022', settings);
    expect(result.baseCostUSD).toBeGreaterThan(0);
    expect(result.baseCostEUR).toBeGreaterThan(0);
    expect(result.chargedEUR).toBeGreaterThan(result.baseCostEUR);
  });

  test('returns zeros for unknown model', () => {
    const result = calculateCost(1000, 500, 'unknown-model', settings);
    expect(result.baseCostUSD).toBe(0);
    expect(result.baseCostEUR).toBe(0);
    expect(result.chargedEUR).toBe(0);
  });

  test('applies profit margin correctly', () => {
    const result = calculateCost(1_000_000, 0, 'claude-haiku-3-5-20241022', settings);
    // input: 1M tokens at $0.80/M = $0.80 USD
    const expectedUSD = 0.80;
    const expectedEUR = expectedUSD * 0.92;
    const expectedCharged = expectedEUR * 1.30;

    expect(result.baseCostUSD).toBeCloseTo(expectedUSD, 5);
    expect(result.baseCostEUR).toBeCloseTo(expectedEUR, 5);
    expect(result.chargedEUR).toBeCloseTo(expectedCharged, 5);
  });

  test('handles zero tokens', () => {
    const result = calculateCost(0, 0, 'claude-haiku-3-5-20241022', settings);
    expect(result.baseCostUSD).toBe(0);
    expect(result.chargedEUR).toBe(0);
  });

  test('uses default settings when missing', () => {
    const result = calculateCost(1_000_000, 0, 'claude-haiku-3-5-20241022', {});
    expect(result.baseCostEUR).toBeGreaterThan(0);
    expect(result.chargedEUR).toBeGreaterThan(0);
  });
});

describe('sanitizeMessages', () => {
  test('passes through valid alternating messages', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Build X' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect(result[2].role).toBe('user');
  });

  test('merges consecutive user messages', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'Build X' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('Hello');
    expect(result[0].content).toContain('Build X');
  });

  test('merges consecutive assistant messages (keeps last)', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'First reply' },
      { role: 'assistant', content: 'Better reply' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe('Better reply');
  });

  test('prepends user message if first message is assistant', () => {
    const msgs = [
      { role: 'assistant', content: 'I am ready' },
      { role: 'user', content: 'Build X' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result[0].role).toBe('user');
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test('handles content block arrays', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: '<html>code</html>' }] },
      { role: 'user', content: 'Change it' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(3);
    expect(result[1].content).toBe('<html>code</html>');
  });

  test('handles empty messages array', () => {
    const result = sanitizeMessages([]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  test('handles non-string content gracefully', () => {
    const msgs = [
      { role: 'user', content: 123 },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(1);
    expect(typeof result[0].content).toBe('string');
  });

  test('normalizes unknown roles to user', () => {
    const msgs = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
    ];
    const result = sanitizeMessages(msgs);
    // 'system' gets normalized to 'user', then merged with next 'user'
    expect(result[0].role).toBe('user');
  });
});
