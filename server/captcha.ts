import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Защита регистрации от ботов без сторонних сервисов: proof-of-work по схеме ALTCHA.
 * Сервер загадывает число n и отдаёт sha256(salt + n); браузер перебирает числа до совпадения (≈1 с).
 * Для человека незаметно, для массовой регистрации — дорого. Соль хранит время выдачи и подписана HMAC,
 * поэтому её нельзя подделать, использовать дважды или отправить быстрее, чем человек заполнит форму.
 */
export interface Challenge {
  algorithm: 'SHA-256';
  salt: string;
  challenge: string;
  maxnumber: number;
  signature: string;
}

export interface Solution {
  salt: string;
  number: number;
  challenge: string;
  signature: string;
}

export type Verdict = 'ok' | 'invalid' | 'expired' | 'too-fast' | 'used';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface PowOptions {
  secret?: string;
  /** Верхняя граница перебора: 100 000 ≈ 0,5–1,5 с на телефоне. */
  max?: number;
  /** Сколько действует задача. */
  ttlMs?: number;
  /** Быстрее этого форму не заполняют люди. */
  minMs?: number;
}

export class Pow {
  private secret: Buffer;
  private max: number;
  private ttlMs: number;
  private minMs: number;
  private used = new Map<string, number>();

  constructor(o: PowOptions = {}) {
    this.secret = o.secret ? Buffer.from(o.secret) : randomBytes(32);
    this.max = o.max ?? 100_000;
    this.ttlMs = o.ttlMs ?? 15 * 60_000;
    this.minMs = o.minMs ?? 3000;
  }

  private sign(salt: string, challenge: string) {
    return createHmac('sha256', this.secret).update(`${salt}:${challenge}`).digest('hex');
  }

  create(now = Date.now()): Challenge {
    const salt = `${randomBytes(12).toString('hex')}.${now}`;
    const challenge = sha256(salt + randomInt(this.max + 1));
    return { algorithm: 'SHA-256', salt, challenge, maxnumber: this.max, signature: this.sign(salt, challenge) };
  }

  verify(s: Partial<Solution> | undefined, now = Date.now()): Verdict {
    if (!s || typeof s.salt !== 'string' || typeof s.challenge !== 'string' || typeof s.signature !== 'string') return 'invalid';
    if (!Number.isInteger(s.number) || s.number! < 0 || s.number! > this.max) return 'invalid';
    const expected = Buffer.from(this.sign(s.salt, s.challenge));
    const got = Buffer.from(s.signature);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return 'invalid';
    if (sha256(s.salt + s.number) !== s.challenge) return 'invalid';
    const issued = Number(s.salt.split('.')[1]);
    if (!Number.isFinite(issued) || now - issued > this.ttlMs) return 'expired';
    if (now - issued < this.minMs) return 'too-fast';
    this.sweep(now);
    if (this.used.has(s.salt)) return 'used';
    this.used.set(s.salt, issued + this.ttlMs);
    return 'ok';
  }

  private sweep(now: number) {
    if (this.used.size < 1000) return;
    for (const [k, exp] of this.used) if (exp < now) this.used.delete(k);
  }
}

/** Перебор на сервере — для тестов. */
export function solve(c: Challenge): Solution {
  for (let n = 0; n <= c.maxnumber; n++)
    if (sha256(c.salt + n) === c.challenge) return { salt: c.salt, number: n, challenge: c.challenge, signature: c.signature };
  throw new Error('нет решения');
}
