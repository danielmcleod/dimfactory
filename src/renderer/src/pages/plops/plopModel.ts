// The Plop mascot's geometry and animation values, pure (Plop.tsx draws them). viewBox 0 0 200 200, the floor at
// y = 180, centred on x = 100. The silhouette is one closed Catmull-Rom spline through the tiers' bulges and soft
// waists plus a curled tip; growth (0 to 1) drives the proportions, not the scale: feet from 0.375, the Mega extras (a
// fourth tier and a sparkle) from 0.875. Moods change the geometry itself (squash and stretch), so the 2.5 px stroke
// stays even. Snacks are an eating loop and emissions a byproduct; both layer over any mood but the puddle, which is a
// figure of its own (melted flat on the same floor, growth setting its width) and takes neither.
import { plopPalette } from '@shared/plops.ts'
import type { PlopEmit, PlopMood, PlopPalette, PlopSnack } from '@shared/plops.ts'

type Pt = [number, number]

const r = (n: number): number => Math.round(n * 100) / 100
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export interface Line {
  x1: number
  y1: number
  x2: number
  y2: number
}
export interface Arm extends Line {
  /** The shoulder: the wave rotates around it. */
  ox: number
  oy: number
}
export interface Ellipse {
  cx: number
  cy: number
  rx: number
  ry: number
}
export interface Highlight extends Ellipse {
  dot: { cx: number; cy: number; r: number }
  tf: string
}
export interface Eye extends Ellipse {
  c1: { cx: number; cy: number; r: number }
  c2: { cx: number; cy: number; r: number }
  hlid: string
  lid: string
}
export interface Item {
  d: string
  fill: string
  stroke: string
  shine: string
}

export interface Snack {
  on: boolean
  chomp: boolean
  mouthStatic: string
  mouthValues: string
  mouthKeys: string
  tongueValues: string
  dur: string
  happyEyes: boolean
  fly: {
    x: number
    y: number
    d: string
    fill: string
    stroke: string
    shine: string
    start: string
    tValues: string
    tKeys: string
    sValues: string
    sKeys: string
    oValues: string
    oKeys: string
  }[]
  crumbs: { d: string; tValues: string; tKeys: string }[]
  pile: { x: number; y: number; item: Item }[]
  sparks: { d: string; oValues: string; oKeys: string }[]
  flash: { fill: string; oValues: string; oKeys: string }[]
  drops: {
    x: number
    y: number
    d: string
    begin: string
    start: string
    tValues: string
    tKeys: string
    sValues: string
    sKeys: string
    oValues: string
    oKeys: string
    rx: number
    ry: number
    rsValues: string
    rsKeys: string
    roValues: string
    roKeys: string
  }[]
  bubbles: {
    cx: number
    cy: number
    r: number
    begin: string
    tValues: string
    oValues: string
    oKeys: string
  }[]
  teeth: { x: number; y: number; w: number; h: number }[]
  teethValues: string
  cordA: string
  cordValues: string
}

export interface Puff {
  x: number
  y: number
  d: string
  fill: string
  stroke: string
  dur: string
  begin: string
  stTr: string
  stSc: string
  stOp: number
  tValues: string
  sValues: string
  oValues: string
  oKeys: string
}

export interface Emission {
  on: boolean
  pipe: (Line & { ex: number; ey: number; er: number })[]
  puddle: (Ellipse & { sheen1: string; sheen2: string; hx: number; hy: number; hrx: number; hry: number })[]
  streak: { d: string; bx: number; by: number; br: number }[]
  drips: {
    x: number
    y: number
    d: string
    sc: string
    stTr: string
    tValues: string
    tKeys: string
    oValues: string
    oKeys: string
    rx: number
    ry: number
    ringY: number
    rsValues: string
    rsKeys: string
    roValues: string
    roKeys: string
  }[]
  puffs: Puff[]
  wisps: { x: number; y: number; d: string; begin: string; tValues: string; oValues: string; oKeys: string }[]
  sweat: { tf: string; d: string; tValues: string; tKeys: string }[]
}

/** The puddle mood's whole figure: a melted body on the floor, its sleepy face, a flopped tip and a slow ripple. */
export interface Puddle {
  body: string
  accent: string
  curl: string
  hl: Ellipse & { tf: string }
  hl2: Ellipse
  dot: { cx: number; cy: number; r: number }
  lids: { d: string }[]
  blush: Ellipse[]
  mouth: string
  /** The ripple's centre and size (it scales up from 0.2 and fades). */
  ring: { x: number; y: number; rx: number; ry: number }
}

export interface PlopShape {
  /** The puddle (mood `puddle`): drawn instead of the body, arms, face, snacks and emissions. */
  pz: Puddle[]
  isPuddle: boolean
  pal: PlopPalette
  body: string
  accents: { d: string }[]
  highlights: Highlight[]
  eyes: Eye[]
  blush: Ellipse[]
  mouth: string
  tongue: Ellipse
  armL: Arm
  armR: Arm
  armW: number
  armOut: number
  feet: Ellipse[]
  sparkles: { d: string; fill: string }[]
  burst: Line[]
  waveMarks: { d: string }[]
  zzz: { x: number; y: number; size: string }[]
  shadow: Ellipse
  sleepy: boolean
  g: number
  sn: Snack
  em: Emission
}

interface Tier {
  w: number
  h: number
  bot: number
  top: number
  mid: number
}

/** The whole Plop for one set of props. */
export function buildPlop(
  color: string,
  growth: number,
  mood: PlopMood,
  snack: PlopSnack,
  emit: PlopEmit,
): PlopShape {
  const g = Math.max(0, Math.min(1, Number.isFinite(growth) ? growth : 0))
  const pal = plopPalette(color)

  let sx = 1
  let sy = 1
  if (mood === 'sleepy') {
    sx = 1.05
    sy = 0.93
  }
  if (mood === 'growing') {
    sx = 0.93
    sy = 1.08
  }
  const cx = 100
  const B = 180
  const mega = g >= 0.875
  let Ht = (62 + 100 * Math.pow(g, 0.9)) * sy
  const W = (46 + 128 * Math.pow(g, 1.1)) * sx
  if (Ht > 168) Ht = 168
  let tipH = Ht * lerp(0.17, 0.13, g)
  const bodyH = Ht - tipH
  const fr = [lerp(0.35, 0.43, g), lerp(0.35, 0.33, g), lerp(0.3, 0.24, g)] as const
  const w1 = W / 2
  const w2 = w1 * lerp(0.9, 0.79, g)
  const w3 = w1 * lerp(0.7, 0.55, g)
  const sizes: { w: number; h: number }[] = [
    { w: w1, h: bodyH * fr[0] },
    { w: w2, h: bodyH * fr[1] },
    { w: w3, h: bodyH * fr[2] },
  ]
  if (mega) {
    const t4 = bodyH * 0.12
    sizes[2]!.h -= t4 * 0.4
    sizes[0]!.h -= t4 * 0.6
    sizes.push({ w: w3 * 0.62, h: t4 + tipH * 0.25 })
    tipH *= 0.75
  }
  let y = B
  const tiers: Tier[] = sizes.map((t) => {
    const tier = { w: t.w, h: t.h, bot: y, top: y - t.h, mid: y - t.h * 0.5 }
    y = tier.top
    return tier
  })
  const T = y - tipH
  const droop = mood === 'sleepy' ? 1 : 0
  const t0 = tiers[0]!
  const t1 = tiers[1]!
  const t2 = tiers[2]!

  const Rp: Pt[] = []
  Rp.push([cx + w1 * 0.5, B])
  Rp.push([cx + w1 * 0.93, B - t0.h * 0.18])
  Rp.push([cx + w1, B - t0.h * 0.52])
  for (let i = 1; i < tiers.length; i++) {
    const lo = tiers[i - 1]!
    const tt = tiers[i]!
    Rp.push([cx + Math.min(lo.w, tt.w) * 0.955, lo.top + Math.min(2, lo.h * 0.04)])
    Rp.push([cx + tt.w, tt.mid + tt.h * 0.02])
  }
  const top = tiers[tiers.length - 1]!
  const tw = top.w
  const tipPts: Pt[] = [
    [cx + tw * 0.62, top.top + top.h * 0.12],
    [cx + tw * 0.42 + tipH * (0.22 + 0.25 * droop), T + tipH * (0.52 + 0.25 * droop)],
    [cx + tw * 0.14 + tipH * 0.12, T + tipH * (0.02 + 0.3 * droop)],
    [cx - tw * 0.2, T + tipH * (0.38 + 0.2 * droop)],
    [cx - tw * 0.62, top.top + top.h * 0.14],
  ]
  const Lp: Pt[] = Rp.map((p): Pt => [2 * cx - p[0], p[1]]).reverse()
  const pts: Pt[] = [[cx, B], ...Rp, ...tipPts, ...Lp]
  const crPath = (P: Pt[]): string => {
    const n = P.length
    let d = `M${r(P[0]![0])} ${r(P[0]![1])}`
    for (let k = 0; k < n; k++) {
      const p0 = P[(k - 1 + n) % n]!
      const p1 = P[k]!
      const p2 = P[(k + 1) % n]!
      const p3 = P[(k + 2) % n]!
      const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
      const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
      if (p1[1] >= B - 0.01 && p2[1] >= B - 0.01) {
        c1[1] = B
        c2[1] = B
      }
      if (p1[1] >= B - 0.01) c1[1] = Math.min(c1[1], B)
      if (p2[1] >= B - 0.01) c2[1] = Math.min(c2[1], B)
      d += ` C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(p2[0])} ${r(p2[1])}`
    }
    return `${d} Z`
  }
  const body = crPath(pts)

  const accents: { d: string }[] = []
  for (let j = 1; j < tiers.length; j++) {
    const a = tiers[j]!
    const b = tiers[j - 1]!
    const aw = Math.min(a.w, b.w) * 0.78
    const yy = b.top + 1
    accents.push({
      d: `M${r(cx - aw)} ${r(yy - 1)} Q${r(cx)} ${r(yy + a.h * 0.32)} ${r(cx + aw)} ${r(yy - 1)}`,
    })
  }
  accents.push({
    d:
      `M${r(cx - tw * 0.3)} ${r(top.top + top.h * 0.05)} Q${r(cx + tw * 0.1)} ${r(T + tipH * 0.75)} ` +
      `${r(cx + tw * 0.34 + tipH * 0.12)} ${r(T + tipH * (0.5 + 0.25 * droop))}`,
  })

  const highlights: Highlight[] = tiers.map((t, k) => {
    let hx = cx - t.w * 0.52
    let hy = t.mid - t.h * 0.2
    let rx = Math.max(2.4, t.w * 0.2)
    const ry = Math.max(1.6, t.h * 0.12)
    if (k === 1) {
      hx = cx - t.w * 0.66
      hy = t.mid - t.h * 0.26
      rx *= 0.7
    }
    return {
      cx: r(hx),
      cy: r(hy),
      rx: r(rx),
      ry: r(ry),
      dot: { cx: r(hx + rx * 1.15), cy: r(hy - ry * 0.55), r: r(Math.max(1, ry * 0.42)) },
      tf: `rotate(-28 ${r(hx)} ${r(hy)})`,
    }
  })
  highlights.push({
    cx: r(cx - tw * 0.08),
    cy: r(T + tipH * 0.55),
    rx: r(Math.max(1.6, tipH * 0.16)),
    ry: r(Math.max(1.1, tipH * 0.1)),
    dot: { cx: 0, cy: 0, r: 0 },
    tf: `rotate(-30 ${r(cx - tw * 0.08)} ${r(T + tipH * 0.55)})`,
  })

  const ft = t1
  const faceY = ft.mid + ft.h * (0.08 + 0.1 * droop)
  const erx = 4.4 + 2.4 * g
  const ery = 6 + 3.4 * g
  const ex = Math.min(ft.w * 0.42, 8.5 + 15 * g)
  const ey = faceY - ery * 0.35
  const eyes: Eye[] = [-1, 1].map((s) => {
    const X = cx + s * ex
    return {
      cx: r(X),
      cy: r(ey),
      rx: r(erx),
      ry: r(ery),
      c1: { cx: r(X - erx * 0.28), cy: r(ey - ery * 0.36), r: r(ery * 0.3) },
      c2: { cx: r(X + erx * 0.34), cy: r(ey + ery * 0.32), r: r(ery * 0.14) },
      hlid: `M${r(X - erx * 1.05)} ${r(ey + ery * 0.3)} Q${r(X)} ${r(ey - ery * 0.75)} ${r(X + erx * 1.05)} ${r(ey + ery * 0.3)}`,
      lid: `M${r(X - erx * 1.05)} ${r(ey + ery * 0.1)} Q${r(X)} ${r(ey + ery * 0.75)} ${r(X + erx * 1.05)} ${r(ey + ery * 0.1)}`,
    }
  })
  const blush: Ellipse[] = [-1, 1].map((s) => ({
    cx: r(cx + s * (ex + erx + 2.5 + 2 * g)),
    cy: r(ey + ery * 0.85),
    rx: r(3.8 + 2.6 * g),
    ry: r(2.3 + 1.3 * g),
  }))
  const mw = (mood === 'happy' ? 6.2 : 5.4) + 4.4 * g
  const mh = mw * (mood === 'sleepy' ? 0.55 : 0.9)
  const my = ey + ery + 1.6 + g
  const mouthPath = (wf: number, hf: number): string => {
    const w = mw * wf
    const h = mh * hf
    return (
      `M${r(cx - w)} ${r(my)}` +
      ` C${r(cx - w * 0.75)} ${r(my + h * 1.3)} ${r(cx + w * 0.75)} ${r(my + h * 1.3)} ${r(cx + w)} ${r(my)}` +
      ` Q${r(cx)} ${r(my + h * 0.22)} ${r(cx - w)} ${r(my)} Z`
    )
  }
  const mouth = mouthPath(1, 1)
  const tongue: Ellipse = { cx: r(cx + mw * 0.08), cy: r(my + mh * 0.74), rx: r(mw * 0.42), ry: r(mh * 0.2) }

  const armLen = 8 + 10 * g
  const armW = 8 + 5 * g
  const arm = (s: number, up: boolean): Arm => {
    const sxp = cx + s * (t0.w * 0.88)
    const syp = B - t0.h * 0.52
    const ang = up ? -62 : 38
    const rad = (ang * Math.PI) / 180
    const len = armLen * (up ? 1.35 : 1)
    return {
      x1: r(sxp - s * 3),
      y1: r(syp),
      x2: r(sxp + s * Math.cos(rad) * len),
      y2: r(syp + Math.sin(rad) * len),
      ox: r(sxp),
      oy: r(syp),
    }
  }
  const waving = mood === 'happy'
  const armL = arm(-1, false)
  const armR = arm(1, waving)

  const feet: Ellipse[] =
    g >= 0.375
      ? [-1, 1].map((s) => {
          const frx = 6 + 7 * g
          const fry = 3.6 + 3 * g
          return { cx: r(cx + s * w1 * 0.42), cy: r(B - fry + 0.5), rx: r(frx), ry: r(fry) }
        })
      : []

  const star = (x: number, yv: number, s: number): string => {
    const k = s * 0.28
    return (
      `M${r(x)} ${r(yv - s)} Q${r(x + k)} ${r(yv - k)} ${r(x + s)} ${r(yv)}` +
      ` Q${r(x + k)} ${r(yv + k)} ${r(x)} ${r(yv + s)} Q${r(x - k)} ${r(yv + k)} ${r(x - s)} ${r(yv)}` +
      ` Q${r(x - k)} ${r(yv - k)} ${r(x)} ${r(yv - s)} Z`
    )
  }
  const sparkles: { d: string; fill: string }[] = []
  if (mega)
    sparkles.push(
      { d: star(cx + tw * 0.9 + 8, T + 4, 7), fill: '#FFE27A' },
      { d: star(cx - tw * 0.95 - 6, T + 16, 4), fill: '#FFFFFF' },
    )
  if (mood === 'growing') {
    const top2 = Math.max(12, T - 4)
    const side = w1 + 10
    sparkles.push(
      { d: star(cx - side, B - Ht * 0.55, 8), fill: '#FFE27A' },
      { d: star(cx + side + 2, B - Ht * 0.72, 9), fill: '#FFE27A' },
      { d: star(cx + tw + 18, top2 + 2, 5), fill: '#FFFFFF' },
      { d: star(cx - tw - 16, top2 + 10, 5.5), fill: pal.crown },
      { d: star(cx + side - 2, B - Ht * 0.28, 4.5), fill: pal.crown },
    )
  }
  const burst: Line[] =
    mood === 'growing'
      ? [0, 1, 2, 3, 4, 5].map((k) => {
          const ang = ((-90 + (k - 2.5) * 34) * Math.PI) / 180
          const r1 = Ht * 0.62
          const rr = r1 + 9
          const oy = B - Ht * 0.48
          return {
            x1: r(cx + Math.cos(ang) * r1 * 1.05),
            y1: r(oy + Math.sin(ang) * r1),
            x2: r(cx + Math.cos(ang) * rr * 1.05),
            y2: r(oy + Math.sin(ang) * rr),
          }
        })
      : []
  const waveMarks = waving
    ? [
        { d: `M${r(armR.x2 + 6)} ${r(armR.y2 - 9)} q4 4 2 9` },
        { d: `M${r(armR.x2 + 11)} ${r(armR.y2 - 13)} q6 6 3 14` },
      ]
    : []
  const zzz =
    mood === 'sleepy'
      ? [
          { x: r(cx + tw + 6), y: r(T + 8), size: '12px' },
          { x: r(cx + tw + 18), y: r(T - 4), size: '9px' },
        ]
      : []

  // ---- snacks (eating loops) ----
  const ss = 0.85 + 0.55 * g
  const mN = mouth
  const mW = mouthPath(1.12, 1.75)
  const mC = mouthPath(0.78, 0.1)
  const mHf = mouthPath(0.95, 0.65)
  const mx0 = cx
  const my0 = my + mh * 0.45
  const pts2 = (list: Pt[]): string => list.map((p) => `${r(p[0])} ${r(p[1])}`).join(';')
  const ingot = (s: number, fill: string, strokeC: string): Item => ({
    d: `M${r(-7 * s)} ${r(3 * s)} L${r(7 * s)} ${r(3 * s)} L${r(4.6 * s)} ${r(-3.6 * s)} L${r(-4.6 * s)} ${r(-3.6 * s)} Z`,
    fill,
    stroke: strokeC,
    shine: `M${r(-3 * s)} ${r(-1.6 * s)} L${r(1.8 * s)} ${r(-1.6 * s)}`,
  })
  const zig = (x: number, yv: number, s: number, flip: boolean): string => {
    const f = flip ? -1 : 1
    return `M${r(x)} ${r(yv)} l${r(f * 4.8 * s)} ${r(-5.4 * s)} l${r(-f * 1.8 * s)} ${r(4.5 * s)} l${r(f * 5.4 * s)} ${r(-3.6 * s)}`
  }
  const boltD = ((s: number): string => {
    const P: Pt[] = [
      [2.5, -13],
      [-6, 1.5],
      [-0.5, 1.5],
      [-3, 13],
      [6.5, -2.5],
      [1, -2.5],
      [4, -13],
    ]
    return `M${P.map((p) => `${r(p[0] * s)} ${r(p[1] * s)}`).join(' L')} Z`
  })(ss)
  const dropD = ((s: number): string =>
    `M0 ${r(-7 * s)} C${r(2.6 * s)} ${r(-3.4 * s)} ${r(5 * s)} ${r(-0.6 * s)} ${r(5 * s)} ${r(2.4 * s)}` +
    ` A${r(5 * s)} ${r(5 * s)} 0 0 1 ${r(-5 * s)} ${r(2.4 * s)}` +
    ` C${r(-5 * s)} ${r(-0.6 * s)} ${r(-2.6 * s)} ${r(-3.4 * s)} 0 ${r(-7 * s)} Z`)(ss)
  const sn: Snack = {
    on: snack !== 'none',
    chomp: snack === 'metal' || snack === 'cord' || snack === 'bolt',
    mouthStatic: mN,
    mouthValues: `${mN};${mN}`,
    mouthKeys: '0;1',
    tongueValues: '1;1',
    dur: '2s',
    happyEyes: snack === 'metal',
    fly: [],
    crumbs: [],
    pile: [],
    sparks: [],
    flash: [],
    drops: [],
    bubbles: [],
    teeth: [],
    teethValues: '0 0;0 0',
    cordA: '',
    cordValues: '',
  }
  if (snack === 'metal') {
    const gold = ingot(ss, '#FFCF4A', '#8A5B00')
    const px = Math.min(cx + w1 + 10, 184)
    sn.dur = '2.4s'
    sn.mouthStatic = mW
    sn.mouthValues = [mN, mW, mW, mC, mHf, mC, mHf, mC, mN].join(';')
    sn.mouthKeys = '0;0.2;0.46;0.52;0.62;0.71;0.8;0.88;1'
    sn.tongueValues = '1;1;1;0;1;0;1;0;1'
    sn.fly = [
      {
        x: r(mx0),
        y: r(my0),
        d: gold.d,
        fill: gold.fill,
        stroke: gold.stroke,
        shine: gold.shine,
        start: `${r(18 * ss)} ${r(-9 * ss)}`,
        tValues: pts2([
          [44 * ss, -30 * ss],
          [44 * ss, -30 * ss],
          [20 * ss, -12 * ss],
          [0, 0],
          [0, 0],
        ]),
        tKeys: '0;0.08;0.3;0.48;1',
        sValues: '1;1;0.35;0.35',
        sKeys: '0;0.44;0.52;1',
        oValues: '0;1;1;0;0',
        oKeys: '0;0.08;0.48;0.52;1',
      },
    ]
    sn.crumbs = (
      [
        [-1, -0.6],
        [1, -0.9],
        [1.3, 0.3],
      ] as Pt[]
    ).map((c) => {
      const bx = mx0 + c[0] * (mw + 3)
      const by = my0 + c[1] * 4
      return {
        d:
          `M${r(bx)} ${r(by - 2.2)} L${r(bx + 0.7)} ${r(by - 0.7)} L${r(bx + 2.2)} ${r(by)} L${r(bx + 0.7)} ${r(by + 0.7)}` +
          ` L${r(bx)} ${r(by + 2.2)} L${r(bx - 0.7)} ${r(by + 0.7)} L${r(bx - 2.2)} ${r(by)} L${r(bx - 0.7)} ${r(by - 0.7)} Z`,
        tValues: `0 0;0 0;${r(c[0] * 5)} ${r(-4)};${r(c[0] * 7)} ${r(-6)}`,
        tKeys: '0;0.52;0.7;1',
      }
    })
    const s2 = ss * 0.9
    sn.pile = [
      { x: r(px), y: r(B - 3 * s2), item: ingot(s2, '#FFCF4A', '#8A5B00') },
      { x: r(px - 7 * s2), y: r(B - 2.6 * s2), item: ingot(s2 * 0.75, '#DDE3EC', '#5E6878') },
      { x: r(px + 2 * s2), y: r(B - 8.6 * s2), item: ingot(s2 * 0.7, '#C9A2FF', '#5B3A9E') },
    ]
  }
  if (snack === 'cord') {
    // A live cable held across the mouth: it runs off both sides along the floor (no plug in view).
    const mY = my + mh * 0.3
    const hw = mw * 1.2
    const fl = B - 2.5
    const fw = t1.w
    const ex2 = Math.max(fw + 7, hw + 10)
    const cable = (sag: number, dr: number): string => {
      const L = (x: number): number => r(cx - x)
      const Rr = (x: number): number => r(cx + x)
      return (
        `M-10 ${r(fl)}` +
        ` C${L(Math.min(w1 + 26, 104))} ${r(fl)} ${L(ex2 + 6)} ${r(mY + 26 + dr)} ${L(ex2)} ${r(mY + 7 + dr * 0.4)}` +
        ` C${L(ex2 - 6)} ${r(mY + 1)} ${L(hw + 7)} ${r(mY - 0.5)} ${L(hw)} ${r(mY)}` +
        ` Q${r(cx)} ${r(mY + sag)} ${Rr(hw)} ${r(mY)}` +
        ` C${Rr(hw + 7)} ${r(mY - 0.5)} ${Rr(ex2 - 6)} ${r(mY + 1)} ${Rr(ex2)} ${r(mY + 7 + dr * 0.4)}` +
        ` C${Rr(ex2 + 6)} ${r(mY + 26 + dr)} ${Rr(Math.min(w1 + 26, 104))} ${r(fl)} 210 ${r(fl)}`
      )
    }
    const cA = cable(1, 0)
    const cB = cable(2.6, 5)
    const mOpen = mouthPath(1.1, 1.15)
    const mBite = mouthPath(1.02, 0.55)
    sn.dur = '1.6s'
    sn.mouthStatic = mOpen
    sn.mouthValues = [mOpen, mBite, mOpen, mBite, mOpen].join(';')
    sn.mouthKeys = '0;0.25;0.5;0.75;1'
    sn.tongueValues = '1;0;1;0;1'
    sn.cordA = cA
    sn.cordValues = [cA, cB, cA, cB, cA].join(';')
    // Two little teeth biting down on the middle of the cable.
    const tw2 = Math.max(2.8, mw * 0.3)
    const th = Math.max(3.4, mh * 0.62)
    sn.teeth = [-1, 1].map((s) => ({
      x: r(cx + s * tw2 * 0.7 - tw2 / 2),
      y: r(my - 0.4),
      w: r(tw2),
      h: r(th),
    }))
    sn.teethValues = '0 0;0 1.4;0 0;0 1.4;0 0'
    sn.sparks = [
      {
        d: zig(cx + ex2 + 1, mY + 2, ss, false),
        oValues: '0;1;0;0;1;0;0',
        oKeys: '0;0.24;0.34;0.7;0.76;0.86;1',
      },
      {
        d: zig(cx - ex2 - 1, mY + 2, ss, true),
        oValues: '0;0;1;0;0;1;0',
        oKeys: '0;0.22;0.28;0.4;0.72;0.78;1',
      },
      {
        d: zig(cx + w1 + 24, fl - 4, ss * 0.8, false),
        oValues: '0;0;0;1;0;0',
        oKeys: '0;0.5;0.72;0.78;0.88;1',
      },
    ]
    sn.flash = [{ fill: '#FFFFFF', oValues: '0;0.22;0;0;0.22;0;0', oKeys: '0;0.25;0.36;0.7;0.75;0.86;1' }]
  }
  if (snack === 'bolt') {
    sn.dur = '2.2s'
    sn.mouthStatic = mW
    sn.mouthValues = [mN, mW, mW, mC, mC, mN].join(';')
    sn.mouthKeys = '0;0.15;0.44;0.5;0.8;1'
    sn.tongueValues = '1;1;1;0;0;1'
    sn.fly = [
      {
        x: r(mx0),
        y: r(my0),
        d: boltD,
        fill: '#FFE14D',
        stroke: '#9A6A00',
        shine: 'M0 0',
        start: `${r(12 * ss)} ${r(-22 * ss)}`,
        tValues: pts2([
          [34 * ss, -70 * ss],
          [34 * ss, -70 * ss],
          [10 * ss, -16 * ss],
          [0, 0],
          [0, 0],
        ]),
        tKeys: '0;0.1;0.36;0.46;1',
        sValues: '1;1;0.3;0.3',
        sKeys: '0;0.42;0.5;1',
        oValues: '0;1;1;0;0',
        oKeys: '0;0.1;0.46;0.5;1',
      },
    ]
    sn.flash = [{ fill: '#FFF3A6', oValues: '0;0;0.6;0;0.35;0;0', oKeys: '0;0.5;0.55;0.64;0.7;0.8;1' }]
    const tb = t0
    const tm = t1
    sn.sparks = [
      {
        d: zig(cx + tb.w + 2, tb.mid, ss, false),
        oValues: '0;0;1;0;1;0;0',
        oKeys: '0;0.52;0.56;0.62;0.68;0.76;1',
      },
      {
        d: zig(cx - tb.w - 2, tb.mid + 3, ss, true),
        oValues: '0;0;1;0;1;0;0',
        oKeys: '0;0.54;0.58;0.64;0.7;0.78;1',
      },
      {
        d: zig(cx + tm.w + 2, tm.mid - 4, ss * 0.8, false),
        oValues: '0;0;0;1;0;0',
        oKeys: '0;0.56;0.6;0.64;0.72;1',
      },
      {
        d: zig(cx - tm.w - 3, tm.mid - 6, ss * 0.8, true),
        oValues: '0;0;0;1;0;0',
        oKeys: '0;0.58;0.62;0.66;0.74;1',
      },
    ]
  }
  if (snack === 'water') {
    sn.dur = '3s'
    const ax = cx + tw * 0.1
    const ay = T + tipH * 0.25
    const top0 = Math.max(-52, 4 - ay)
    sn.drops = (
      [
        [-9, 0],
        [7, 1],
        [-1, 2],
      ] as Pt[]
    ).map((dd) => {
      const dx = dd[0] * ss
      return {
        x: r(ax),
        y: r(ay),
        d: dropD,
        begin: `${-dd[1]}s`,
        start: `${r(dx)} ${r(top0 * (0.35 + 0.2 * dd[1]))}`,
        tValues: pts2([
          [dx, top0],
          [dx, top0],
          [dx * 0.25, 0],
          [dx * 0.25, 0],
        ]),
        tKeys: '0;0.05;0.4;1',
        sValues: '1;1;0.1;0.1',
        sKeys: '0;0.38;0.48;1',
        oValues: '0;1;1;0;0',
        oKeys: '0;0.08;0.4;0.48;1',
        rx: r(13 * ss),
        ry: r(4 * ss),
        rsValues: '0.15;0.15;1;1',
        rsKeys: '0;0.4;0.72;1',
        roValues: '0;0;0.8;0;0',
        roKeys: '0;0.39;0.42;0.72;1',
      }
    })
    sn.bubbles = (
      [
        [-0.45, 0, 1.6],
        [0.25, 0.8, 2.2],
        [-0.05, 1.6, 1.3],
      ] as [number, number, number][]
    ).map((b) => ({
      cx: r(cx + b[0] * t0.w),
      cy: r(t0.mid + t0.h * 0.15),
      r: r(b[2] * ss),
      begin: `${-b[1]}s`,
      tValues: `0 0;0 ${r(-t0.h * 1.25)}`,
      oValues: '0;0.85;0.85;0',
      oKeys: '0;0.2;0.75;1',
    }))
  }

  // ---- emissions (byproducts of working hard: smoke, gas, oil, steam) ----
  const cloud = (p: number): string =>
    `M${r(-p)} ${r(p * 0.35)}` +
    ` A${r(p * 0.48)} ${r(p * 0.48)} 0 0 1 ${r(-p * 0.5)} ${r(-p * 0.25)}` +
    ` A${r(p * 0.58)} ${r(p * 0.58)} 0 0 1 ${r(p * 0.38)} ${r(-p * 0.42)}` +
    ` A${r(p * 0.5)} ${r(p * 0.5)} 0 0 1 ${r(p)} ${r(p * 0.2)}` +
    ` A${r(p * 0.34)} ${r(p * 0.34)} 0 0 1 ${r(p * 0.68)} ${r(p * 0.62)}` +
    ` L${r(-p * 0.7)} ${r(p * 0.62)}` +
    ` A${r(p * 0.3)} ${r(p * 0.3)} 0 0 1 ${r(-p)} ${r(p * 0.35)} Z`
  const puffs = (
    ax: number,
    ay: number,
    dx: number,
    dy: number,
    size: number,
    fill: string,
    strokeC: string,
    dur: string,
  ): Puff[] => {
    const D = parseFloat(dur)
    return [0, 1, 2].map((k) => {
      const f = (k + 0.5) / 3
      return {
        x: r(ax),
        y: r(ay),
        d: cloud(size),
        fill,
        stroke: strokeC,
        dur,
        begin: `${r((-k * D) / 3)}s`,
        stTr: `translate(${r(dx * f)} ${r(dy * f)})`,
        stSc: `scale(${r(0.45 + f)})`,
        stOp: r(0.95 - f * 0.55),
        tValues: `0 0;${r(dx * 0.55)} ${r(dy * 0.5)};${r(dx)} ${r(dy)}`,
        sValues: '0.3;1;1.5',
        oValues: '0;0.95;0.85;0',
        oKeys: '0;0.15;0.6;1',
      }
    })
  }
  const em: Emission = {
    on: emit !== 'none',
    pipe: [],
    puddle: [],
    streak: [],
    drips: [],
    puffs: [],
    wisps: [],
    sweat: [],
  }
  const apexX = cx + tw * 0.14 + tipH * 0.12
  const apexY = T + tipH * 0.1
  if (emit === 'smoke') {
    // The smoke rises as far as the box has room above the tip and drifts sideways for the rest, so a tall Plop's
    // smoke stays inside its own box instead of spilling over its tile.
    const fullRise = 44 * ss
    const rise = Math.min(fullRise, Math.max(14, apexY - 4))
    const drift = 18 * ss + (fullRise - rise) * 0.6
    em.puffs = puffs(apexX, apexY - 4, drift, -rise, 10.5 * ss, '#B3B8C1', '#5F6672', '2.7s')
  }
  if (emit === 'gas') {
    // Translucent green gas seeping out of several points around the body.
    const vents: [number, number, number, number, number][] = [
      [cx - t0.w * 0.92, B - t0.h * 0.3, -26, -12, 0],
      [cx + t0.w * 0.94, B - t0.h * 0.42, 24, -16, 0.55],
      [cx - t1.w - 1, t1.mid + t1.h * 0.1, -20, -22, 1.1],
      [cx + t2.w + 1, t2.mid, 18, -26, 1.65],
      [cx - t2.w * 0.4, t2.top + 2, -8, -30, 0.3],
    ]
    const gD = 2.2
    vents.forEach((v, vi) => {
      for (const k of [0, 1]) {
        const f = 0.3 + 0.45 * k
        const b0 = v[4] + (k * gD) / 2
        em.puffs.push({
          x: r(v[0]),
          y: r(v[1]),
          d: cloud((vi === 4 ? 6 : 7.5) * ss),
          fill: 'rgba(128, 204, 84, 0.8)',
          stroke: '#3F7A2E',
          dur: `${gD}s`,
          begin: `${r(-b0)}s`,
          stTr: `translate(${r(v[2] * ss * f)} ${r(v[3] * ss * f)})`,
          stSc: `scale(${r(0.5 + f)})`,
          stOp: r(0.9 - f * 0.4),
          tValues: `0 0;${r(v[2] * ss * 0.45)} ${r(v[3] * ss * 0.4)};${r(v[2] * ss)} ${r(v[3] * ss)}`,
          sValues: '0.25;0.95;1.45',
          oValues: '0;0.85;0.7;0',
          oKeys: '0;0.18;0.6;1',
        })
      }
    })
  }
  if (emit === 'oil') {
    const ox = armR.x2
    const oy = armR.y2 + 4
    const pr = 13 + 14 * g
    em.puddle = [
      {
        cx: r(ox - 2),
        cy: r(B + 0.5),
        rx: r(pr),
        ry: r(3.6 + 2.6 * g),
        sheen1: `M${r(ox - pr * 0.6)} ${r(B + 0.4)} Q${r(ox - 2)} ${r(B - 1.2)} ${r(ox + pr * 0.4)} ${r(B + 0.2)}`,
        hx: r(ox - pr * 0.45),
        hy: r(B - 0.3),
        hrx: r(pr * 0.18),
        hry: r(0.9 + 0.4 * g),
        sheen2: `M${r(ox - pr * 0.35)} ${r(B + 1.6)} Q${r(ox + 2)} ${r(B + 0.6)} ${r(ox + pr * 0.6)} ${r(B + 1.4)}`,
      },
    ]
    const fall = B - oy - 1
    em.drips = [
      {
        x: r(ox),
        y: r(oy),
        d: dropD,
        sc: `scale(${r(0.55)})`,
        stTr: `translate(0 ${r(fall * 0.45)})`,
        tValues: `0 0;0 0;0 ${r(fall)};0 ${r(fall)}`,
        tKeys: '0;0.35;0.7;1',
        oValues: '0;1;1;0;0',
        oKeys: '0;0.12;0.68;0.72;1',
        rx: r(6 * ss),
        ry: r(1.8 * ss),
        ringY: r(fall + 1),
        rsValues: '0.2;0.2;1;1',
        rsKeys: '0;0.7;0.9;1',
        roValues: '0;0;0.9;0;0',
        roKeys: '0;0.69;0.72;0.92;1',
      },
    ]
  }
  if (emit === 'steam') {
    const wisp = (s: number): string =>
      `M0 0 c${r(-4 * s)} ${r(-5 * s)} ${r(4 * s)} ${r(-9 * s)} 0 ${r(-14 * s)}` +
      ` c${r(-4 * s)} ${r(-5 * s)} ${r(4 * s)} ${r(-9 * s)} 0 ${r(-14 * s)}`
    em.wisps = (
      [
        [apexX, apexY - 2, 0, 0.9],
        [cx - t2.w - 3, t2.mid, 0.7, 0.65],
        [cx + t2.w + 3, t2.mid + 2, 1.4, 0.7],
      ] as [number, number, number, number][]
    ).map((w) => ({
      x: r(w[0]),
      y: r(w[1]),
      d: wisp(ss * w[3]),
      begin: `${-w[2]}s`,
      tValues: '0 4;0 -10',
      oValues: '0;0.9;0',
      oKeys: '0;0.4;1',
    }))
    em.sweat = [
      {
        tf: `translate(${r(cx + ft.w * 0.7)} ${r(ey - ery * 0.6)}) scale(${r(0.62 * ss)})`,
        d: dropD,
        tValues: '0 0;0 0;0 5;0 5',
        tKeys: '0;0.5;0.85;1',
      },
    ]
  }

  // ---- puddle: used before, no tokens now; melted flat on the same floor (growth sets how wide it lies) ----
  const pz: Puddle[] = []
  if (mood === 'puddle') {
    const PW = 34 + 36 * g
    const PH = 15 + 9 * g
    // The melted silhouette's top edge, right to left, as [x, y] fractions of the puddle's half-width and height: a
    // low rim, the face's dome and the flopped tip leaning right.
    const prof: Pt[] = [
      [0.97, 0.16],
      [0.86, 0.33],
      [0.72, 0.42],
      [0.6, 0.34],
      [0.43, 0.5],
      [0.24, 0.86],
      [0.05, 1],
      [-0.13, 0.97],
      [-0.3, 0.76],
      [-0.45, 0.43],
      [-0.58, 0.36],
      [-0.7, 0.45],
      [-0.84, 0.3],
      [-0.96, 0.13],
    ]
    const pp: Pt[] = [
      [cx, B],
      [cx + PW * 0.55, B],
      [cx + PW, B - 0.2],
      ...prof.map((q): Pt => [cx + q[0] * PW, B - q[1] * PH]),
      [cx - PW, B - 0.2],
      [cx - PW * 0.55, B],
    ]
    const pex = 5.6 + 4.6 * g
    const perx = 3.7 + 1.6 * g
    const pery = 4.6 + 2 * g
    const pey = B - PH * 0.56
    const pmy = pey + pery * 0.75 + 1.2
    const hlx = cx - PW * 0.24
    const hly = B - PH * 0.7
    pz.push({
      body: crPath(pp),
      accent: `M${r(cx - PW * 0.78)} ${r(B - PH * 0.12)} Q${r(cx)} ${r(B - PH * 0.34)} ${r(cx + PW * 0.82)} ${r(B - PH * 0.1)}`,
      curl:
        `M${r(cx + 0.5)} ${r(B - PH * 0.98)} c${r(1.6 + g)} ${r(-3.4 - 1.6 * g)} ${r(6.4 + 2 * g)} ` +
        `${r(-3.6 - 1.6 * g)} ${r(6.6 + 2.2 * g)} ${r(-0.6)}`,
      hl: {
        cx: r(hlx),
        cy: r(hly),
        rx: r(PW * 0.13),
        ry: r(Math.max(1.3, PH * 0.09)),
        tf: `rotate(-10 ${r(hlx)} ${r(hly)})`,
      },
      hl2: { cx: r(cx - PW * 0.7), cy: r(B - PH * 0.36), rx: r(PW * 0.06), ry: r(1.1 + 0.3 * g) },
      dot: { cx: r(cx - PW * 0.08), cy: r(B - PH * 0.8), r: r(1 + 0.4 * g) },
      lids: [-1, 1].map((s) => {
        const X = cx + s * pex
        return { d: `M${r(X - perx)} ${r(pey)} Q${r(X)} ${r(pey + pery * 0.7)} ${r(X + perx)} ${r(pey)}` }
      }),
      blush: [-1, 1].map((s) => ({
        cx: r(cx + s * (pex + perx + 2.6)),
        cy: r(pey + 2.4),
        rx: r(2.8 + g),
        ry: r(1.5 + 0.4 * g),
      })),
      mouth: `M${r(cx - 3.2)} ${r(pmy)} q1.6 -1.6 3.2 0 t3.2 0`,
      ring: { x: r(cx + PW * 0.55), y: r(B - PH * 0.18), rx: r(PW * 0.22), ry: r(PH * 0.09 + 0.6) },
    })
  }

  const shadow: Ellipse =
    pz.length > 0
      ? { cx, cy: B + 1, rx: r(34 + 36 * g + 7), ry: r(3.2 + 2 * g) }
      : { cx, cy: B + 1, rx: r(w1 * 1.02 + 6), ry: r(3.6 + 3 * g) }
  return {
    pz,
    isPuddle: pz.length > 0,
    pal,
    body,
    accents,
    highlights,
    eyes,
    blush,
    mouth,
    tongue,
    armL,
    armR,
    armW: r(armW),
    armOut: r(armW + 5),
    feet,
    sparkles,
    burst,
    waveMarks,
    zzz,
    shadow,
    sleepy: mood === 'sleepy',
    g,
    sn,
    em,
  }
}

/** The body's squash-and-stretch loop for a mood (a gas leak bloats; a water snack swells). */
export function bodyAnimation(
  mood: PlopMood,
  snack: PlopSnack,
  emit: PlopEmit,
): { values: string; keys: string; dur: string } {
  let anim = { values: '1 1;1 1', keys: '0;1', dur: '1s' }
  if (mood === 'growing')
    anim = { values: '1 1;1.08 0.9;0.94 1.08;1.02 0.98;1 1', keys: '0;0.25;0.55;0.8;1', dur: '1.4s' }
  if (mood === 'sleepy') anim = { values: '1 1;1.025 0.97;1 1', keys: '0;0.5;1', dur: '3.2s' }
  if (mood === 'idle') anim = { values: '1 1;1.01 0.985;1 1', keys: '0;0.5;1', dur: '2.6s' }
  if (snack === 'water') anim = { values: '1 1;1 1;1.04 1.035;1 1', keys: '0;0.2;0.32;1', dur: '1s' }
  if (emit === 'gas') anim = { values: '1 1;1.03 0.98;0.99 1.01;1 1', keys: '0;0.35;0.7;1', dur: '1.4s' }
  return anim
}

/** How long the growing squash-and-stretch plays (once) before the Plop settles. */
export const GROWING_MS = 1400
