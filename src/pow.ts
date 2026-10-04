// Проверка «не робот» при регистрации: перебор числа, чей sha256 загадал сервер (см. server/captcha.ts).
// Идёт в фоне, пока человек заполняет форму, и обычно заканчивается раньше, чем он нажмёт «Создать аккаунт».

export interface PowChallenge {
  algorithm: 'SHA-256';
  salt: string;
  challenge: string;
  maxnumber: number;
  signature: string;
}

export interface PowSolution {
  salt: string;
  number: number;
  challenge: string;
  signature: string;
}

const hex = (buf: ArrayBuffer) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
};

export async function solvePow(c: PowChallenge, signal?: AbortSignal): Promise<PowSolution> {
  if (!globalThis.crypto?.subtle) throw new Error('Браузер не поддерживает проверку — обновите его');
  const enc = new TextEncoder();
  const BATCH = 400;
  for (let start = 0; start <= c.maxnumber; start += BATCH) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const end = Math.min(start + BATCH - 1, c.maxnumber);
    const jobs: Promise<ArrayBuffer>[] = [];
    for (let n = start; n <= end; n++) jobs.push(crypto.subtle.digest('SHA-256', enc.encode(c.salt + n)));
    const hashes = await Promise.all(jobs);
    for (let i = 0; i < hashes.length; i++)
      if (hex(hashes[i]) === c.challenge) return { salt: c.salt, number: start + i, challenge: c.challenge, signature: c.signature };
  }
  throw new Error('Проверка не удалась — обновите страницу');
}
