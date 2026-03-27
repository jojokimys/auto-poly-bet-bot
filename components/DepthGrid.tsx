'use client';

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

export interface DepthLevel {
  price: number;
  size: number;
  isMyOrder: boolean;
}

/**
 * Single-row depth grid: [far NO ... close NO] [MID] [close YES ... far YES]
 * Left = NO side (red). Right = YES side (green/blue).
 * Each square shows price + bet amount inside.
 */
export function DepthGrid({ mid, depthYes, depthNo, wallYes, wallNo, maxSpread }: {
  mid: number;
  depthYes: DepthLevel[];
  depthNo: DepthLevel[];
  wallYes: number;
  wallNo: number;
  maxSpread: number;
}) {
  if (mid <= 0) return <div className="h-10" />;

  const steps = Math.min(8, Math.ceil(maxSpread)); // max 8 per side = 16 total + MID

  // NO cells: reversed (far left → close to mid right)
  const noCells: DepthLevel[] = [];
  for (let i = 0; i < steps; i++) {
    noCells.push(i < depthNo.length ? depthNo[i] : { price: 0, size: 0, isMyOrder: false });
  }
  noCells.reverse(); // far first (left)

  // YES cells: normal order (close to mid left → far right)
  const yesCells: DepthLevel[] = [];
  for (let i = 0; i < steps; i++) {
    yesCells.push(i < depthYes.length ? depthYes[i] : { price: 0, size: 0, isMyOrder: false });
  }

  const maxSize = Math.max(1, ...depthYes.map((c) => c.size), ...depthNo.map((c) => c.size));

  return (
    <div className="flex items-center gap-[2px]">
      {/* Wall NO total */}
      <span className={`text-[9px] font-mono w-10 text-right ${
        wallNo > 5000 ? 'text-green-400' : wallNo > 2000 ? 'text-green-500' : wallNo > 500 ? 'text-yellow-400' : wallNo > 0 ? 'text-red-400' : 'text-gray-600'
      }`}>
        {wallNo > 0 ? `$${formatCompact(wallNo)}` : '—'}
      </span>

      {/* NO side (red) — far to close */}
      {noCells.map((cell, i) => (
        <Cell key={`n${i}`} cell={cell} maxSize={maxSize} isYes={false} maxSpread={maxSpread} distFromMid={steps - i} />
      ))}

      {/* MID marker */}
      <div className="w-14 h-9 rounded bg-gray-700/60 flex flex-col items-center justify-center border border-gray-600/50 flex-shrink-0">
        <span className="text-[9px] font-mono text-white/60 font-bold">MID</span>
        <span className="text-[11px] font-mono text-white">{mid.toFixed(2)}</span>
      </div>

      {/* YES side (blue) — close to far */}
      {yesCells.map((cell, i) => (
        <Cell key={`y${i}`} cell={cell} maxSize={maxSize} isYes={true} maxSpread={maxSpread} distFromMid={i + 1} />
      ))}

      {/* Wall YES total */}
      <span className={`text-[9px] font-mono w-10 text-left ${
        wallYes > 5000 ? 'text-green-400' : wallYes > 2000 ? 'text-green-500' : wallYes > 500 ? 'text-yellow-400' : wallYes > 0 ? 'text-red-400' : 'text-gray-600'
      }`}>
        {wallYes > 0 ? `$${formatCompact(wallYes)}` : '—'}
      </span>
    </div>
  );
}

function Cell({ cell, maxSize, isYes, maxSpread, distFromMid }: {
  cell: DepthLevel;
  maxSize: number;
  isYes: boolean;
  maxSpread: number;
  distFromMid: number;
}) {
  const inRewardZone = distFromMid <= maxSpread;
  const intensity = cell.size / maxSize;

  if (cell.price <= 0 && !cell.isMyOrder) {
    return (
      <div className="w-14 h-9 rounded-sm bg-gray-800/30 flex items-center justify-center">
        <span className="text-[8px] text-gray-700">{distFromMid}¢</span>
      </div>
    );
  }

  let bg: string;
  let border: string = '';
  if (cell.isMyOrder) {
    bg = isYes ? 'bg-blue-600/80' : 'bg-pink-600/80';
    border = 'ring-1 ring-white/50';
  } else if (!inRewardZone) {
    bg = 'bg-gray-700/40';
  } else if (intensity > 0.5) {
    bg = 'bg-green-600/60';
  } else if (intensity > 0.2) {
    bg = 'bg-yellow-600/50';
  } else if (intensity > 0) {
    bg = 'bg-red-600/40';
  } else {
    bg = 'bg-gray-800/40';
  }

  return (
    <div
      className={`w-14 h-9 rounded-sm ${bg} ${border} flex flex-col items-center justify-center cursor-help transition-colors duration-300`}
      title={`${isYes ? cell.price.toFixed(2) : (1 - cell.price).toFixed(2)} (raw: ${cell.price.toFixed(2)}) | $${cell.size.toFixed(0)} | ${distFromMid}¢ from mid${cell.isMyOrder ? ' (MY ORDER)' : ''}`}
    >
      <span className={`text-[10px] font-mono leading-tight ${cell.isMyOrder ? 'text-white font-bold' : 'text-white/70'}`}>
        {isYes ? cell.price.toFixed(2) : (1 - cell.price).toFixed(2)}
      </span>
      <span className={`text-[9px] font-mono leading-tight ${cell.isMyOrder ? 'text-white/90' : 'text-white/40'}`}>
        ${formatCompact(cell.size)}
      </span>
    </div>
  );
}

/**
 * Simple wall bar for scan page (no per-price depth data).
 * Single row: [NO wall] [cells] [MID] [cells] [YES wall]
 */
export function WallBar({ label, mid, wallSize, maxSpread }: {
  label: string;
  mid: number;
  wallSize: number;
  maxSpread: number;
}) {
  if (mid <= 0) return <div className="h-5" />;

  const isYes = label === 'Y';
  const steps = Math.min(10, Math.ceil(maxSpread));

  return (
    <div className="flex items-center gap-0.5 h-5">
      <span className={`text-[10px] font-bold w-3 ${isYes ? 'text-blue-400' : 'text-red-400'}`}>{label}</span>

      <div className="flex gap-[1px] flex-row-reverse">
        {Array.from({ length: 10 }, (_, i) => {
          const inRange = i < steps;
          const bg = !inRange
            ? 'bg-gray-800/20'
            : wallSize > 5000 ? 'bg-green-500' : wallSize > 2000 ? 'bg-yellow-500' : wallSize > 500 ? 'bg-orange-500' : wallSize > 0 ? 'bg-red-500' : 'bg-gray-800';
          const opacity = !inRange ? 0.1 : Math.min(0.8, wallSize / 10000 + 0.15);

          return (
            <div
              key={i}
              className={`w-5 h-4 rounded-sm ${bg} cursor-help`}
              style={{ opacity }}
              title={`${(i + 1)}¢ from mid | Wall: $${wallSize.toFixed(0)}`}
            />
          );
        })}
      </div>

      <span className="text-[8px] text-white/30 font-mono">{mid.toFixed(2)}</span>

      <span className={`text-[10px] font-mono w-12 text-right font-semibold ${
        wallSize > 5000 ? 'text-green-400' : wallSize > 2000 ? 'text-green-500' : wallSize > 500 ? 'text-yellow-400' : wallSize > 0 ? 'text-red-400' : 'text-gray-600'
      }`}>
        {wallSize > 0 ? `$${formatCompact(wallSize)}` : 'no wall'}
      </span>
    </div>
  );
}
