// The Plop: one glossy, three-tier blob per vendor or model that grows with its usage (plopModel.ts holds the
// geometry). It is an SVG with role="img" and an aria-label naming what it stands for; its labels sit under it as text
// at a fixed size, so they never shrink with the Plop. The idle, sleepy and growing loops and the wave are SVG
// animations; `animated` false (prefers-reduced-motion) draws the same Plop still. The puddle mood draws a melted
// figure instead (on the same floor, in the same box), with only a slow shine and ripple. Which mood, snack and emission show
// when is the page's business (plopAnimation.ts); this only draws one combination.
import { useId } from 'react'
import { stageOf } from '@shared/plops.ts'
import type { PlopEmit, PlopMood, PlopSnack } from '@shared/plops.ts'
import { cn } from '../../lib/cn.ts'
import { bodyAnimation, buildPlop } from './plopModel.ts'

export interface PlopProps {
  /** One base hex; every other color is derived from it. */
  color: string
  /** 0 to 1: the proportions (Drop, Sprout, Plop, Chonk, Mega), not the scale. */
  growth: number
  mood?: PlopMood
  snack?: PlopSnack
  emit?: PlopEmit
  /** Lines of text under the Plop: the first is the name (bold), the rest its figures. */
  lines?: readonly string[]
  /** Width in px (the Plop is square). */
  size?: number
  /** The app's dark theme: a deeper floor shadow and lighter z's. */
  dark?: boolean
  animated?: boolean
  /** The SVG's accessible name; default: the first line, the stage and the mood. */
  ariaLabel?: string
  testId?: string
  className?: string
}

/** The SVG's default accessible name ("Opus, Chonk Plop, happy, giving off oil"). No em dash: UI copy standard. */
export function plopAriaLabel(
  label: string | undefined,
  growth: number,
  mood: PlopMood,
  snack: PlopSnack,
  emit: PlopEmit,
): string {
  return (
    (label !== undefined && label !== '' ? `${label}, ` : '') +
    `${stageOf(growth)} Plop, ${mood}` +
    (snack !== 'none' ? `, eating ${snack}` : '') +
    (emit !== 'none' ? `, giving off ${emit}` : '')
  )
}

export function Plop({
  color,
  growth,
  mood = 'idle',
  snack = 'none',
  emit = 'none',
  lines = [],
  size = 200,
  dark = false,
  animated = true,
  ariaLabel,
  testId,
  className,
}: PlopProps): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const gid = `plop-${uid}-grad`
  const m = buildPlop(color, growth, mood, snack, emit)
  const { sn, em, pal } = m
  const anim = bodyAnimation(mood, snack, emit)
  const anOn = animated
  const mouthAnim = animated && sn.chomp
  const mouthD = sn.chomp ? sn.mouthStatic : m.mouth
  const cordAnim = animated && sn.cordA.length > 0
  const cordPlain = !animated && sn.cordA.length > 0
  const animOn = animated && (mood !== 'happy' || snack === 'water' || emit === 'gas')
  const waveOn = animated && mood === 'happy'
  const eyesOpen = !m.sleepy && !sn.happyEyes
  const happyEyes = !m.sleepy && sn.happyEyes
  const { ox, oy } = m.armR
  const waveValues = `0 ${ox} ${oy};-16 ${ox} ${oy};6 ${ox} ${oy};0 ${ox} ${oy}`
  const shadowFill = dark ? 'rgba(0, 0, 0, 0.45)' : 'rgba(40, 24, 60, 0.14)'
  const zFill = dark ? '#C9C2D6' : pal.stroke
  const [name, ...figures] = lines
  return (
    <div
      data-testid={testId}
      data-mood={mood}
      data-emit={emit}
      data-snack={snack}
      data-stage={stageOf(growth)}
      className={cn('flex flex-col items-center gap-0.5', className)}
      style={{ width: size }}
    >
      <svg
        // A new mood or snack restarts the SVG's clock, so a snack starts at its first bite and growing plays from
        // its start; the box keeps its size either way.
        key={`${mood}|${snack}`}
        viewBox="0 0 200 200"
        width={size}
        height={size}
        role="img"
        aria-label={ariaLabel ?? plopAriaLabel(name, growth, mood, snack, emit)}
        className="block shrink-0 overflow-visible"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={pal.crown} />
            <stop offset="0.55" stopColor={pal.mid} />
            <stop offset="1" stopColor={pal.deep} />
          </linearGradient>
        </defs>
        <ellipse cx={m.shadow.cx} cy={m.shadow.cy} rx={m.shadow.rx} ry={m.shadow.ry} fill={shadowFill} />
        {m.pz.map((pz, i) => (
          <g key={`puddle-body${i}`} data-plop-part="puddle">
            <path
              d={pz.body}
              style={{ fill: `url(#${gid}) ${pal.mid}` }}
              stroke={pal.stroke}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d={pz.curl} fill="none" stroke={pal.stroke} strokeWidth={2.4} strokeLinecap="round" />
            <path
              d={pz.accent}
              fill="none"
              stroke={pal.stroke}
              strokeWidth={2}
              strokeLinecap="round"
              opacity={0.3}
            />
            <g opacity={0.85}>
              {anOn && (
                <animate attributeName="opacity" values="0.85;0.45;0.85" dur="4s" repeatCount="indefinite" />
              )}
              <ellipse
                cx={pz.hl.cx}
                cy={pz.hl.cy}
                rx={pz.hl.rx}
                ry={pz.hl.ry}
                transform={pz.hl.tf}
                fill="#FFFFFF"
              />
              <ellipse cx={pz.hl2.cx} cy={pz.hl2.cy} rx={pz.hl2.rx} ry={pz.hl2.ry} fill="#FFFFFF" />
              <circle cx={pz.dot.cx} cy={pz.dot.cy} r={pz.dot.r} fill="#FFFFFF" />
            </g>
            {pz.blush.map((b, j) => (
              <ellipse
                key={`pb${j}`}
                cx={b.cx}
                cy={b.cy}
                rx={b.rx}
                ry={b.ry}
                fill={pal.blush}
                opacity={0.5}
              />
            ))}
            {pz.lids.map((l, j) => (
              <path
                key={`pl${j}`}
                d={l.d}
                fill="none"
                stroke={pal.ink}
                strokeWidth={2.2}
                strokeLinecap="round"
              />
            ))}
            <path
              d={pz.mouth}
              fill="none"
              stroke={pal.ink}
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* The slow ripple: animated only; still (reduced motion) it stays hidden, so the puddle holds one pose. */}
            <g transform={`translate(${pz.ring.x} ${pz.ring.y})`}>
              <g opacity={0}>
                {anOn && (
                  <>
                    <animateTransform
                      attributeName="transform"
                      type="scale"
                      values="0.2;0.2;1"
                      keyTimes="0;0.4;1"
                      dur="4.5s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0;0;0.7;0"
                      keyTimes="0;0.4;0.5;1"
                      dur="4.5s"
                      repeatCount="indefinite"
                    />
                  </>
                )}
                <ellipse
                  cx={0}
                  cy={0}
                  rx={pz.ring.rx}
                  ry={pz.ring.ry}
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth={1.3}
                />
              </g>
            </g>
          </g>
        ))}
        {!m.isPuddle && (
          <>
            {m.burst.map((b, i) => (
              <line
                key={`burst${i}`}
                x1={b.x1}
                y1={b.y1}
                x2={b.x2}
                y2={b.y2}
                stroke={pal.mid}
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            ))}
            <g transform="translate(100 180)">
              <g>
                {animOn && (
                  <animateTransform
                    attributeName="transform"
                    type="scale"
                    values={anim.values}
                    keyTimes={anim.keys}
                    dur={anim.dur}
                    repeatCount="indefinite"
                  />
                )}
                <g transform="translate(-100 -180)">
                  <line
                    x1={m.armL.x1}
                    y1={m.armL.y1}
                    x2={m.armL.x2}
                    y2={m.armL.y2}
                    stroke={pal.stroke}
                    strokeWidth={m.armOut}
                    strokeLinecap="round"
                  />
                  <line
                    x1={m.armL.x1}
                    y1={m.armL.y1}
                    x2={m.armL.x2}
                    y2={m.armL.y2}
                    stroke={pal.arm}
                    strokeWidth={m.armW}
                    strokeLinecap="round"
                  />
                  <g>
                    {waveOn && (
                      <animateTransform
                        attributeName="transform"
                        type="rotate"
                        values={waveValues}
                        dur="0.9s"
                        repeatCount="indefinite"
                      />
                    )}
                    <line
                      x1={m.armR.x1}
                      y1={m.armR.y1}
                      x2={m.armR.x2}
                      y2={m.armR.y2}
                      stroke={pal.stroke}
                      strokeWidth={m.armOut}
                      strokeLinecap="round"
                    />
                    <line
                      x1={m.armR.x1}
                      y1={m.armR.y1}
                      x2={m.armR.x2}
                      y2={m.armR.y2}
                      stroke={pal.arm}
                      strokeWidth={m.armW}
                      strokeLinecap="round"
                    />
                    {m.waveMarks.map((w, i) => (
                      <path
                        key={`wave${i}`}
                        d={w.d}
                        fill="none"
                        stroke={pal.stroke}
                        strokeWidth={2}
                        strokeLinecap="round"
                        opacity={0.6}
                      />
                    ))}
                  </g>
                  {em.puddle.map((pd, i) => (
                    <g key={`puddle${i}`}>
                      <ellipse
                        cx={pd.cx}
                        cy={pd.cy}
                        rx={pd.rx}
                        ry={pd.ry}
                        fill="#2B2633"
                        stroke="#17141C"
                        strokeWidth={1.2}
                      />
                      <path
                        d={pd.sheen1}
                        fill="none"
                        stroke="#8E6CFF"
                        strokeWidth={1.1}
                        strokeLinecap="round"
                        opacity={0.8}
                      />
                      <path
                        d={pd.sheen2}
                        fill="none"
                        stroke="#39C9B8"
                        strokeWidth={1.1}
                        strokeLinecap="round"
                        opacity={0.8}
                      />
                      <ellipse cx={pd.hx} cy={pd.hy} rx={pd.hrx} ry={pd.hry} fill="#FFFFFF" opacity={0.55} />
                    </g>
                  ))}
                  {em.pipe.map((pp, i) => (
                    <g key={`pipe${i}`}>
                      <line
                        x1={pp.x1}
                        y1={pp.y1}
                        x2={pp.x2}
                        y2={pp.y2}
                        stroke="#3B414D"
                        strokeWidth={9.5}
                        strokeLinecap="round"
                      />
                      <line
                        x1={pp.x1}
                        y1={pp.y1}
                        x2={pp.x2}
                        y2={pp.y2}
                        stroke="#9AA3B2"
                        strokeWidth={6}
                        strokeLinecap="round"
                      />
                      <circle cx={pp.ex} cy={pp.ey} r={pp.er} fill="#2A2E37" />
                    </g>
                  ))}
                  <path
                    d={m.body}
                    style={{ fill: `url(#${gid}) ${pal.mid}` }}
                    stroke={pal.stroke}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {em.streak.map((sr, i) => (
                    <g key={`streak${i}`}>
                      <path d={sr.d} fill="none" stroke="#2B2633" strokeWidth={2.6} strokeLinecap="round" />
                      <circle cx={sr.bx} cy={sr.by} r={sr.br} fill="#2B2633" />
                    </g>
                  ))}
                  {sn.flash.map((fl, i) => (
                    <g key={`flash${i}`} opacity={0}>
                      {anOn && (
                        <animate
                          attributeName="opacity"
                          values={fl.oValues}
                          keyTimes={fl.oKeys}
                          dur={sn.dur}
                          repeatCount="indefinite"
                        />
                      )}
                      <path d={m.body} fill={fl.fill} />
                    </g>
                  ))}
                  {sn.bubbles.map((bb, i) => (
                    <g key={`bubble${i}`} opacity={0.8}>
                      {anOn && (
                        <>
                          <animateTransform
                            attributeName="transform"
                            type="translate"
                            values={bb.tValues}
                            dur="2.4s"
                            begin={bb.begin}
                            repeatCount="indefinite"
                          />
                          <animate
                            attributeName="opacity"
                            values={bb.oValues}
                            keyTimes={bb.oKeys}
                            dur="2.4s"
                            begin={bb.begin}
                            repeatCount="indefinite"
                          />
                        </>
                      )}
                      <circle
                        cx={bb.cx}
                        cy={bb.cy}
                        r={bb.r}
                        fill="rgba(255, 255, 255, 0.3)"
                        stroke="#FFFFFF"
                        strokeWidth={1.2}
                      />
                    </g>
                  ))}
                  {m.accents.map((a, i) => (
                    <path
                      key={`accent${i}`}
                      d={a.d}
                      fill="none"
                      stroke={pal.stroke}
                      strokeWidth={2}
                      strokeLinecap="round"
                      opacity={0.35}
                    />
                  ))}
                  {m.highlights.map((h, i) => (
                    <g key={`hl${i}`}>
                      <ellipse
                        cx={h.cx}
                        cy={h.cy}
                        rx={h.rx}
                        ry={h.ry}
                        transform={h.tf}
                        fill="#FFFFFF"
                        opacity={0.85}
                      />
                      <circle cx={h.dot.cx} cy={h.dot.cy} r={h.dot.r} fill="#FFFFFF" opacity={0.85} />
                    </g>
                  ))}
                  {m.feet.map((f, i) => (
                    <ellipse
                      key={`foot${i}`}
                      cx={f.cx}
                      cy={f.cy}
                      rx={f.rx}
                      ry={f.ry}
                      fill={pal.foot}
                      stroke={pal.stroke}
                      strokeWidth={2.5}
                      strokeLinejoin="round"
                    />
                  ))}
                  {m.blush.map((b, i) => (
                    <ellipse
                      key={`blush${i}`}
                      cx={b.cx}
                      cy={b.cy}
                      rx={b.rx}
                      ry={b.ry}
                      fill={pal.blush}
                      opacity={0.6}
                    />
                  ))}
                  {m.sleepy &&
                    m.eyes.map((e, i) => (
                      <path
                        key={`lid${i}`}
                        d={e.lid}
                        fill="none"
                        stroke={pal.ink}
                        strokeWidth={2.4}
                        strokeLinecap="round"
                      />
                    ))}
                  {eyesOpen &&
                    m.eyes.map((e, i) => (
                      <g key={`eye${i}`}>
                        <ellipse cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} fill={pal.ink} />
                        <circle cx={e.c1.cx} cy={e.c1.cy} r={e.c1.r} fill="#FFFFFF" />
                        <circle cx={e.c2.cx} cy={e.c2.cy} r={e.c2.r} fill="#FFFFFF" />
                      </g>
                    ))}
                  {happyEyes &&
                    m.eyes.map((e, i) => (
                      <path
                        key={`hlid${i}`}
                        d={e.hlid}
                        fill="none"
                        stroke={pal.ink}
                        strokeWidth={2.6}
                        strokeLinecap="round"
                      />
                    ))}
                  {mouthAnim ? (
                    <>
                      <path
                        d={mouthD}
                        fill={pal.mouth}
                        stroke={pal.mouth}
                        strokeWidth={1.2}
                        strokeLinejoin="round"
                      >
                        <animate
                          attributeName="d"
                          values={sn.mouthValues}
                          keyTimes={sn.mouthKeys}
                          dur={sn.dur}
                          repeatCount="indefinite"
                        />
                      </path>
                      <g>
                        <animate
                          attributeName="opacity"
                          values={sn.tongueValues}
                          keyTimes={sn.mouthKeys}
                          dur={sn.dur}
                          repeatCount="indefinite"
                        />
                        <ellipse
                          cx={m.tongue.cx}
                          cy={m.tongue.cy}
                          rx={m.tongue.rx}
                          ry={m.tongue.ry}
                          fill={pal.tongue}
                        />
                      </g>
                    </>
                  ) : (
                    <>
                      <path
                        d={mouthD}
                        fill={pal.mouth}
                        stroke={pal.mouth}
                        strokeWidth={1.2}
                        strokeLinejoin="round"
                      />
                      <ellipse
                        cx={m.tongue.cx}
                        cy={m.tongue.cy}
                        rx={m.tongue.rx}
                        ry={m.tongue.ry}
                        fill={pal.tongue}
                      />
                    </>
                  )}
                  {cordAnim && (
                    <>
                      <path
                        d={sn.cordA}
                        fill="none"
                        stroke="#2A2E37"
                        strokeWidth={5.4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <animate
                          attributeName="d"
                          values={sn.cordValues}
                          keyTimes={sn.mouthKeys}
                          dur={sn.dur}
                          repeatCount="indefinite"
                        />
                      </path>
                      <path
                        d={sn.cordA}
                        fill="none"
                        stroke="#59606F"
                        strokeWidth={2.8}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <animate
                          attributeName="d"
                          values={sn.cordValues}
                          keyTimes={sn.mouthKeys}
                          dur={sn.dur}
                          repeatCount="indefinite"
                        />
                      </path>
                    </>
                  )}
                  {cordPlain && (
                    <>
                      <path
                        d={sn.cordA}
                        fill="none"
                        stroke="#2A2E37"
                        strokeWidth={5.4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d={sn.cordA}
                        fill="none"
                        stroke="#59606F"
                        strokeWidth={2.8}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </>
                  )}
                  <g>
                    {cordAnim && (
                      <animateTransform
                        attributeName="transform"
                        type="translate"
                        values={sn.teethValues}
                        keyTimes={sn.mouthKeys}
                        dur={sn.dur}
                        repeatCount="indefinite"
                      />
                    )}
                    {sn.teeth.map((tt, i) => (
                      <rect
                        key={`tooth${i}`}
                        x={tt.x}
                        y={tt.y}
                        width={tt.w}
                        height={tt.h}
                        rx={0.9}
                        fill="#FFFFFF"
                        stroke={pal.mouth}
                        strokeWidth={0.9}
                      />
                    ))}
                  </g>
                  {sn.fly.map((fy, i) => (
                    <g key={`fly${i}`} transform={`translate(${fy.x} ${fy.y})`}>
                      <g transform={`translate(${fy.start})`}>
                        {anOn && (
                          <animateTransform
                            attributeName="transform"
                            type="translate"
                            values={fy.tValues}
                            keyTimes={fy.tKeys}
                            dur={sn.dur}
                            repeatCount="indefinite"
                          />
                        )}
                        <g>
                          {anOn && (
                            <>
                              <animateTransform
                                attributeName="transform"
                                type="scale"
                                values={fy.sValues}
                                keyTimes={fy.sKeys}
                                dur={sn.dur}
                                repeatCount="indefinite"
                              />
                              <animate
                                attributeName="opacity"
                                values={fy.oValues}
                                keyTimes={fy.oKeys}
                                dur={sn.dur}
                                repeatCount="indefinite"
                              />
                            </>
                          )}
                          <path
                            d={fy.d}
                            fill={fy.fill}
                            stroke={fy.stroke}
                            strokeWidth={1.6}
                            strokeLinejoin="round"
                          />
                          <path
                            d={fy.shine}
                            fill="none"
                            stroke="#FFFFFF"
                            strokeWidth={1.4}
                            strokeLinecap="round"
                            opacity={0.9}
                          />
                        </g>
                      </g>
                    </g>
                  ))}
                  {sn.crumbs.map((cr, i) => (
                    <g key={`crumb${i}`} opacity={0}>
                      {anOn && (
                        <>
                          <animateTransform
                            attributeName="transform"
                            type="translate"
                            values={cr.tValues}
                            keyTimes={cr.tKeys}
                            dur={sn.dur}
                            repeatCount="indefinite"
                          />
                          <animate
                            attributeName="opacity"
                            values="0;0;1;0"
                            keyTimes="0;0.52;0.6;1"
                            dur={sn.dur}
                            repeatCount="indefinite"
                          />
                        </>
                      )}
                      <path d={cr.d} fill="#FFE27A" stroke="#8A5B00" strokeWidth={0.8} />
                    </g>
                  ))}
                  {sn.sparks.map((sk, i) => (
                    <g key={`spark${i}`} opacity={1}>
                      {anOn && (
                        <animate
                          attributeName="opacity"
                          values={sk.oValues}
                          keyTimes={sk.oKeys}
                          dur={sn.dur}
                          repeatCount="indefinite"
                        />
                      )}
                      <path
                        d={sk.d}
                        fill="none"
                        stroke="#8A5B00"
                        strokeWidth={4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d={sk.d}
                        fill="none"
                        stroke="#FFD43B"
                        strokeWidth={2.2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  ))}
                  {sn.drops.map((dr, i) => (
                    <g key={`drop${i}`} transform={`translate(${dr.x} ${dr.y})`}>
                      <g transform={`translate(${dr.start})`}>
                        {anOn && (
                          <animateTransform
                            attributeName="transform"
                            type="translate"
                            values={dr.tValues}
                            keyTimes={dr.tKeys}
                            dur={sn.dur}
                            begin={dr.begin}
                            repeatCount="indefinite"
                          />
                        )}
                        <g>
                          {anOn && (
                            <>
                              <animateTransform
                                attributeName="transform"
                                type="scale"
                                values={dr.sValues}
                                keyTimes={dr.sKeys}
                                dur={sn.dur}
                                begin={dr.begin}
                                repeatCount="indefinite"
                              />
                              <animate
                                attributeName="opacity"
                                values={dr.oValues}
                                keyTimes={dr.oKeys}
                                dur={sn.dur}
                                begin={dr.begin}
                                repeatCount="indefinite"
                              />
                            </>
                          )}
                          <path
                            d={dr.d}
                            fill="#8FD3FF"
                            stroke="#2E7CC4"
                            strokeWidth={1.4}
                            strokeLinejoin="round"
                          />
                        </g>
                      </g>
                      <g opacity={0}>
                        {anOn && (
                          <>
                            <animateTransform
                              attributeName="transform"
                              type="scale"
                              values={dr.rsValues}
                              keyTimes={dr.rsKeys}
                              dur={sn.dur}
                              begin={dr.begin}
                              repeatCount="indefinite"
                            />
                            <animate
                              attributeName="opacity"
                              values={dr.roValues}
                              keyTimes={dr.roKeys}
                              dur={sn.dur}
                              begin={dr.begin}
                              repeatCount="indefinite"
                            />
                          </>
                        )}
                        <ellipse
                          cx={0}
                          cy={0}
                          rx={dr.rx}
                          ry={dr.ry}
                          fill="none"
                          stroke="#5BB6F5"
                          strokeWidth={1.5}
                        />
                      </g>
                    </g>
                  ))}
                  {em.drips.map((od, i) => (
                    <g key={`drip${i}`} transform={`translate(${od.x} ${od.y})`}>
                      <g transform={od.stTr}>
                        {anOn && (
                          <>
                            <animateTransform
                              attributeName="transform"
                              type="translate"
                              values={od.tValues}
                              keyTimes={od.tKeys}
                              dur="1.8s"
                              repeatCount="indefinite"
                            />
                            <animate
                              attributeName="opacity"
                              values={od.oValues}
                              keyTimes={od.oKeys}
                              dur="1.8s"
                              repeatCount="indefinite"
                            />
                          </>
                        )}
                        <path
                          d={od.d}
                          transform={od.sc}
                          fill="#2B2633"
                          stroke="#17141C"
                          strokeWidth={1.4}
                          strokeLinejoin="round"
                        />
                      </g>
                      <g transform={`translate(0 ${od.ringY})`}>
                        <g opacity={0}>
                          {anOn && (
                            <>
                              <animateTransform
                                attributeName="transform"
                                type="scale"
                                values={od.rsValues}
                                keyTimes={od.rsKeys}
                                dur="1.8s"
                                repeatCount="indefinite"
                              />
                              <animate
                                attributeName="opacity"
                                values={od.roValues}
                                keyTimes={od.roKeys}
                                dur="1.8s"
                                repeatCount="indefinite"
                              />
                            </>
                          )}
                          <ellipse
                            cx={0}
                            cy={0}
                            rx={od.rx}
                            ry={od.ry}
                            fill="none"
                            stroke="#4A4352"
                            strokeWidth={1.3}
                          />
                        </g>
                      </g>
                    </g>
                  ))}
                  {em.puffs.map((pf, i) => (
                    <g key={`puff${i}`} transform={`translate(${pf.x} ${pf.y})`}>
                      <g transform={pf.stTr}>
                        {anOn && (
                          <animateTransform
                            attributeName="transform"
                            type="translate"
                            values={pf.tValues}
                            dur={pf.dur}
                            begin={pf.begin}
                            repeatCount="indefinite"
                          />
                        )}
                        <g transform={pf.stSc} opacity={pf.stOp}>
                          {anOn && (
                            <>
                              <animateTransform
                                attributeName="transform"
                                type="scale"
                                values={pf.sValues}
                                dur={pf.dur}
                                begin={pf.begin}
                                repeatCount="indefinite"
                              />
                              <animate
                                attributeName="opacity"
                                values={pf.oValues}
                                keyTimes={pf.oKeys}
                                dur={pf.dur}
                                begin={pf.begin}
                                repeatCount="indefinite"
                              />
                            </>
                          )}
                          <path
                            d={pf.d}
                            fill={pf.fill}
                            stroke={pf.stroke}
                            strokeWidth={1.5}
                            strokeLinejoin="round"
                          />
                        </g>
                      </g>
                    </g>
                  ))}
                  {em.wisps.map((ws, i) => (
                    <g key={`wisp${i}`} transform={`translate(${ws.x} ${ws.y})`}>
                      <g opacity={0.7}>
                        {anOn && (
                          <>
                            <animateTransform
                              attributeName="transform"
                              type="translate"
                              values={ws.tValues}
                              dur="2s"
                              begin={ws.begin}
                              repeatCount="indefinite"
                            />
                            <animate
                              attributeName="opacity"
                              values={ws.oValues}
                              keyTimes={ws.oKeys}
                              dur="2s"
                              begin={ws.begin}
                              repeatCount="indefinite"
                            />
                          </>
                        )}
                        <path d={ws.d} fill="none" stroke="#9DA8B6" strokeWidth={2.6} strokeLinecap="round" />
                      </g>
                    </g>
                  ))}
                  {em.sweat.map((sw, i) => (
                    <g key={`sweat${i}`}>
                      {anOn && (
                        <animateTransform
                          attributeName="transform"
                          type="translate"
                          values={sw.tValues}
                          keyTimes={sw.tKeys}
                          dur="2.4s"
                          repeatCount="indefinite"
                        />
                      )}
                      <path
                        d={sw.d}
                        transform={sw.tf}
                        fill="#BFE6FF"
                        stroke="#3A86C8"
                        strokeWidth={2.6}
                        strokeLinejoin="round"
                      />
                    </g>
                  ))}
                </g>
              </g>
            </g>
            {sn.pile.map((pi, i) => (
              <g key={`pile${i}`} transform={`translate(${pi.x} ${pi.y})`}>
                <path
                  d={pi.item.d}
                  fill={pi.item.fill}
                  stroke={pi.item.stroke}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                />
                <path
                  d={pi.item.shine}
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth={1.2}
                  strokeLinecap="round"
                />
              </g>
            ))}
            {m.sparkles.map((s, i) => (
              <path
                key={`sparkle${i}`}
                d={s.d}
                fill={s.fill}
                stroke={pal.stroke}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            ))}
            {m.zzz.map((z, i) => (
              <text
                key={`z${i}`}
                x={z.x}
                y={z.y}
                fill={zFill}
                style={{ fontFamily: 'inherit', fontWeight: 900, fontSize: z.size }}
              >
                z
              </text>
            ))}
          </>
        )}
      </svg>
      {name !== undefined && (
        <div className="flex w-full max-w-full flex-col items-center text-center">
          <div
            data-plop-line="name"
            title={name}
            className="h-5 w-full truncate text-[15px] leading-5 font-bold text-foreground"
          >
            {name}
          </div>
          {figures.map((f, i) => (
            <div
              key={i}
              data-plop-line="figure"
              title={f}
              className="h-[18px] w-full truncate text-[13px] leading-[18px] font-semibold text-muted-foreground tabular-nums"
            >
              {f}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
