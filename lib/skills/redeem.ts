import 'server-only';

import { spawn } from 'child_process';
import path from 'path';
import { prisma } from '@/lib/db/prisma';

export interface RedeemResult {
  profileId: string;
  profileName: string;
  success: boolean;
  claimed: number;
  failed: number;
  message: string;
  stdout: string;
  stderr: string;
}

const REDEEM_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Spawn `scripts/redeem.ts` as a child process via `npx tsx`.
 * Playwright requires a real browser (headless: false + chrome channel),
 * so this cannot run inside the Next.js server-only context directly.
 */
export async function executeRedeem(
  profileId: string,
  profileName?: string,
): Promise<RedeemResult> {
  const name = profileName ?? 'default';
  const scriptPath = path.resolve(process.cwd(), 'scripts', 'redeem.ts');

  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn('npx', ['tsx', scriptPath, '--profile', name], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: REDEEM_TIMEOUT_MS,
    });

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    child.on('error', (err) => {
      stderr += err.message;
      resolve({ stdout, stderr, code: 1 });
    });
  });

  // Parse counts from stdout — new format:
  // "완료 — Claim: 성공 X, 실패 Y | Sell(≥99.5¢): 성공 A, 실패 B"
  const claimSuccessMatch = result.stdout.match(/Claim: 성공 (\d+)/);
  const claimFailMatch = result.stdout.match(/Claim:.*실패 (\d+)/);
  const sellSuccessMatch = result.stdout.match(/Sell.*: 성공 (\d+)/);
  const sellFailMatch = result.stdout.match(/Sell.*: .*실패 (\d+)/);

  const claimCount = claimSuccessMatch ? parseInt(claimSuccessMatch[1], 10) : 0;
  const sellCount = sellSuccessMatch ? parseInt(sellSuccessMatch[1], 10) : 0;
  const claimed = claimCount + sellCount;
  const failed =
    (claimFailMatch ? parseInt(claimFailMatch[1], 10) : 0) +
    (sellFailMatch ? parseInt(sellFailMatch[1], 10) : 0);
  const success = result.code === 0;

  const message = success
    ? claimed > 0
      ? `Claim: ${claimCount}, Sell(≥99.5¢): ${sellCount}, Failed: ${failed}`
      : 'No claimable or sellable positions found'
    : `Redeem process exited with code ${result.code}`;

  // Log to DB
  await prisma.botLog.create({
    data: {
      profileId,
      level: claimed > 0 ? 'trade' : success ? 'info' : 'error',
      event: 'redeem',
      message: `[${name}] ${message}`,
      data: JSON.stringify({
        claimed,
        failed,
        exitCode: result.code,
        stdout: result.stdout.slice(-500),
        stderr: result.stderr.slice(-500),
      }),
    },
  }).catch(() => {});

  return {
    profileId,
    profileName: name,
    success,
    claimed,
    failed,
    message,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
