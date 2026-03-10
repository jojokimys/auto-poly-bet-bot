import { NextResponse } from 'next/server';
import { startRunner, stopRunner, getRunnerState } from '@/lib/edge/cycle-runner';

/**
 * GET /api/edge/cycle — Runner status + cumulative performance
 */
export async function GET() {
  return NextResponse.json(getRunnerState());
}

/**
 * POST /api/edge/cycle — Start/stop the cycle runner
 *
 * Body:
 *   { action: "start", profileId: string, config?: Partial<EngineConfig> }
 *   { action: "stop" }
 */
export async function POST(req: Request) {
  const body = await req.json();

  if (body.action === 'start') {
    if (!body.profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }
    await startRunner(body.profileId, body.config);
    return NextResponse.json({ status: 'started', state: getRunnerState() });
  }

  if (body.action === 'stop') {
    stopRunner();
    return NextResponse.json({ status: 'stopped', state: getRunnerState() });
  }

  return NextResponse.json({ error: 'Unknown action. Use "start" or "stop".' }, { status: 400 });
}
