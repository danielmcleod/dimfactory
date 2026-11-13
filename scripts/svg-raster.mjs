// A small SVG path rasterizer for the icon generator (scripts/make-tray-icons.mjs). Pure Node, no dependencies, and
// deterministic. It reads only what build/logo.svg and build/logo-tray.svg use: a root viewBox and <path> elements
// (inside <g>, <defs> or <mask>) with fill, fill-rule, stroke, stroke-width, stroke-linejoin (round or bevel) and
// paint-order presentation attributes. Anything else it does not understand is an error, so the art cannot change
// shape without the generator noticing.
//
// Shapes become sample masks: SS x SS point samples per pixel, each inside or outside under the fill rule. A stroke
// is the union of its segments' rectangles and its joins (discs for round, triangles for bevel), filled nonzero.

/** Parse the subset of SVG the masters use. Returns the viewBox and the paths in paint order with their styles. */
export function parseSvg(text) {
  const root = /<svg\b([^>]*)>/.exec(text)
  if (root === null) throw new Error('svg-raster: no <svg> element')
  const vb = attr(root[1], 'viewBox')
  if (vb === undefined) throw new Error('svg-raster: the <svg> element needs a viewBox')
  const viewBox = vb
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n)))
    throw new Error(`svg-raster: bad viewBox ${vb}`)

  const STYLE = ['fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linejoin', 'paint-order']
  const stack = [
    {
      fill: '#000',
      'fill-rule': 'nonzero',
      stroke: 'none',
      'stroke-width': '1',
      'stroke-linejoin': 'miter',
      'paint-order': 'normal',
    },
  ]
  const paths = []
  const body = text.slice(root.index + root[0].length).replace(/<!--[\s\S]*?-->/g, '')
  for (const m of body.matchAll(/<(\/?)([a-zA-Z]+)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs, selfClosing] = m
    if (tag === 'title' || tag === 'svg') continue
    if (closing === '/') {
      if (tag === 'g' || tag === 'mask' || tag === 'defs') stack.pop()
      continue
    }
    if (/\b(style|transform|class)\s*=/.test(attrs))
      throw new Error(`svg-raster: <${tag}> uses style, class or transform`)
    const own = { ...stack.at(-1) }
    for (const k of STYLE) {
      const v = attr(attrs, k)
      if (v !== undefined) own[k] = v
    }
    if (tag === 'g' || tag === 'mask' || tag === 'defs') {
      if (tag !== 'g') own.inDefs = true
      if (selfClosing !== '/') stack.push(own)
    } else if (tag === 'path') {
      const d = attr(attrs, 'd')
      if (d === undefined) throw new Error('svg-raster: <path> without d')
      const join = own['stroke-linejoin']
      if (own.stroke !== 'none' && join !== 'round' && join !== 'bevel')
        throw new Error(`svg-raster: stroke-linejoin ${join} is not supported`)
      paths.push({
        id: attr(attrs, 'id'),
        // Inside <defs> or <mask>: geometry only, not painted by itself. A masked path's mask is not applied here.
        inDefs: own.inDefs === true,
        masked: attr(attrs, 'mask') !== undefined,
        d,
        fill: own.fill,
        fillRule: own['fill-rule'],
        stroke: own.stroke,
        strokeWidth: Number(own['stroke-width']),
        join,
        strokeFirst: own['paint-order'].trim().startsWith('stroke'),
      })
    } else if (!(tag === 'rect' && own.inDefs === true)) {
      // A <rect> is only allowed as a mask's backdrop (build/logo-tray.svg), which the generator does not need.
      throw new Error(`svg-raster: <${tag}> is not supported here`)
    }
  }
  return { viewBox, paths }
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs)
  return m === null ? undefined : m[1]
}

/** '#rrggbb' to [r, g, b]. */
export function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (m === null) throw new Error(`svg-raster: colour ${hex} is not #rrggbb`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

// ---- path data to polylines ---------------------------------------------------------------------------------

/** Flatten SVG path data into subpaths: arrays of [x, y] points (user units) and whether each one was closed. */
export function flattenPath(d) {
  const tokens = d.match(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []
  let i = 0
  const num = () => {
    const t = tokens[i++]
    if (t === undefined || /^[a-zA-Z]$/.test(t)) throw new Error(`svg-raster: path data ends early: ${d}`)
    return Number(t)
  }
  const flag = () => {
    // Arc flags may be written without separators ("0 01.5"); the tokenizer splits "01.5" as one number.
    const t = tokens[i]
    if (t === '0' || t === '1') {
      i++
      return Number(t)
    }
    if (t !== undefined && /^[01]\d/.test(t)) {
      tokens[i] = t.slice(1)
      return Number(t[0])
    }
    throw new Error(`svg-raster: bad arc flag ${t}`)
  }
  const subpaths = []
  let cur = null
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let lastCtrl = null // [x, y] of the previous cubic's second control point, for S
  let lastQuad = null
  let cmd = ''
  const moveTo = (nx, ny) => {
    cur = { points: [[nx, ny]], closed: false }
    subpaths.push(cur)
    x = sx = nx
    y = sy = ny
  }
  const lineTo = (nx, ny) => {
    if (cur === null) moveTo(x, y)
    cur.points.push([nx, ny])
    x = nx
    y = ny
  }
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
    const n = Math.min(128, Math.max(4, Math.ceil(len / 0.01)))
    const x0 = x
    const y0 = y
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const u = 1 - t
      lineTo(
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      )
    }
  }
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++]
    else if (cmd === '') throw new Error(`svg-raster: path data must start with a command: ${d}`)
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    const c = cmd.toUpperCase()
    let ctrl = null
    let quad = null
    switch (c) {
      case 'M':
        moveTo(ox + num(), oy + num())
        cmd = rel ? 'l' : 'L' // later pairs are implicit line-tos
        break
      case 'L':
        lineTo(ox + num(), oy + num())
        break
      case 'H':
        lineTo(ox + num(), y)
        break
      case 'V':
        lineTo(x, oy + num())
        break
      case 'C': {
        const p = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()]
        cubic(...p)
        ctrl = [p[2], p[3]]
        break
      }
      case 'S': {
        const r = lastCtrl ?? [x, y]
        const x1 = 2 * x - r[0]
        const y1 = 2 * y - r[1]
        const p = [ox + num(), oy + num(), ox + num(), oy + num()]
        cubic(x1, y1, ...p)
        ctrl = [p[0], p[1]]
        break
      }
      case 'Q':
      case 'T': {
        let qx
        let qy
        if (c === 'Q') {
          qx = ox + num()
          qy = oy + num()
        } else {
          const r = lastQuad ?? [x, y]
          qx = 2 * x - r[0]
          qy = 2 * y - r[1]
        }
        const ex = ox + num()
        const ey = oy + num()
        cubic(
          x + (2 / 3) * (qx - x),
          y + (2 / 3) * (qy - y),
          ex + (2 / 3) * (qx - ex),
          ey + (2 / 3) * (qy - ey),
          ex,
          ey,
        )
        quad = [qx, qy]
        break
      }
      case 'A': {
        const rx = num()
        const ry = num()
        const rot = num()
        const large = flag()
        const sweep = flag()
        arc(x, y, rx, ry, rot, large, sweep, ox + num(), oy + num(), lineTo)
        break
      }
      case 'Z':
        if (cur !== null) {
          cur.closed = true
          x = sx
          y = sy
          cur = null
        }
        break
      default:
        throw new Error(`svg-raster: path command ${cmd} is not supported`)
    }
    lastCtrl = ctrl
    lastQuad = quad
  }
  return subpaths.filter((s) => s.points.length > 1)
}

/** SVG elliptical arc (endpoint parameterization, SVG 1.1 F.6.5) as line segments ending at (x2, y2). */
function arc(x1, y1, rx, ry, rotDeg, large, sweep, x2, y2, lineTo) {
  if (x1 === x2 && y1 === y2) return
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (rx === 0 || ry === 0) return lineTo(x2, y2)
  const phi = (rotDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let coef = Math.sqrt(Math.max(0, num / den))
  if (large === sweep) coef = -coef
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (sweep === 0 && dt > 0) dt -= 2 * Math.PI
  if (sweep === 1 && dt < 0) dt += 2 * Math.PI
  const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 32)))
  for (let k = 1; k <= n; k++) {
    if (k === n) return lineTo(x2, y2)
    const t = t1 + (dt * k) / n
    const ex = rx * Math.cos(t)
    const ey = ry * Math.sin(t)
    lineTo(cos * ex - sin * ey + cx, sin * ex + cos * ey + cy)
  }
}

// ---- strokes as polygons ------------------------------------------------------------------------------------

const ccw = (poly) => {
  let a = 0
  for (let k = 0; k < poly.length; k++) {
    const [x0, y0] = poly[k]
    const [x1, y1] = poly[(k + 1) % poly.length]
    a += x0 * y1 - x1 * y0
  }
  return a < 0 ? poly.reverse() : poly
}

const disc = (cx, cy, r) =>
  Array.from({ length: 48 }, (_, k) => [
    cx + r * Math.cos((k * Math.PI) / 24),
    cy + r * Math.sin((k * Math.PI) / 24),
  ])

/** The outline of a stroke as same-orientation polygons; filled nonzero, they give the stroke's union. */
export function strokePolygons(subpaths, width, join) {
  const h = width / 2
  const out = []
  for (const { points, closed } of subpaths) {
    const pts = points.filter((p, k) => k === 0 || p[0] !== points[k - 1][0] || p[1] !== points[k - 1][1])
    if (closed && pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop()
    const segs = []
    const count = closed ? pts.length : pts.length - 1
    for (let k = 0; k < count; k++) segs.push([pts[k], pts[(k + 1) % pts.length]])
    const normal = ([a, b]) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      return [(-(b[1] - a[1]) / len) * h, ((b[0] - a[0]) / len) * h]
    }
    for (const s of segs) {
      const [nx, ny] = normal(s)
      const [a, b] = s
      out.push(
        ccw([
          [a[0] + nx, a[1] + ny],
          [b[0] + nx, b[1] + ny],
          [b[0] - nx, b[1] - ny],
          [a[0] - nx, a[1] - ny],
        ]),
      )
    }
    // Joins between consecutive segments (and caps at the ends of an open path, drawn round).
    for (let k = 0; k < segs.length; k++) {
      if (!closed && k === segs.length - 1) break
      const s0 = segs[k]
      const s1 = segs[(k + 1) % segs.length]
      const v = s0[1]
      if (join === 'round') out.push(ccw(disc(v[0], v[1], h)))
      else {
        const [ax, ay] = normal(s0)
        const [bx, by] = normal(s1)
        for (const sign of [1, -1]) {
          const tri = [v, [v[0] + sign * ax, v[1] + sign * ay], [v[0] + sign * bx, v[1] + sign * by]]
          if (
            Math.abs((tri[1][0] - v[0]) * (tri[2][1] - v[1]) - (tri[1][1] - v[1]) * (tri[2][0] - v[0])) >
            1e-12
          )
            out.push(ccw(tri))
        }
      }
    }
    if (!closed) for (const p of [pts[0], pts.at(-1)]) out.push(ccw(disc(p[0], p[1], h)))
  }
  return out
}

// ---- sample masks -------------------------------------------------------------------------------------------

/**
 * The samples of a `size` x `size` image (SS x SS per pixel) inside `polygons` (arrays of [x, y] in user units),
 * mapped by `view` ({ scale, dx, dy }: pixel = user * scale + d). Returns a Uint8Array of (size*ss)^2, 1 = inside.
 */
export function maskOf(polygons, rule, size, ss, view) {
  const n = size * ss
  const mask = new Uint8Array(n * n)
  const edges = []
  let top = Infinity
  let bottom = -Infinity
  for (const poly of polygons) {
    for (let j = 0; j < poly.length; j++) {
      const a = poly[j]
      const b = poly[(j + 1) % poly.length]
      const x0 = (a[0] * view.scale + view.dx) * ss
      const y0 = (a[1] * view.scale + view.dy) * ss
      const x1 = (b[0] * view.scale + view.dx) * ss
      const y1 = (b[1] * view.scale + view.dy) * ss
      if (y0 === y1) continue
      edges.push(y0 < y1 ? [x0, y0, x1, y1, 1] : [x1, y1, x0, y0, -1])
      top = Math.min(top, y0, y1)
      bottom = Math.max(bottom, y0, y1)
    }
  }
  const rowFrom = Math.max(0, Math.floor(top - 0.5))
  const rowTo = Math.min(n - 1, Math.ceil(bottom))
  const hits = []
  for (let row = rowFrom; row <= rowTo; row++) {
    const yc = row + 0.5
    hits.length = 0
    for (const [x0, y0, x1, y1, dir] of edges) {
      if (yc < y0 || yc >= y1) continue
      hits.push([x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0), dir])
    }
    if (hits.length === 0) continue
    hits.sort((p, q) => p[0] - q[0])
    let w = 0
    for (let h = 0; h < hits.length - 1; h++) {
      w += hits[h][1]
      const inside = rule === 'evenodd' ? (h + 1) % 2 === 1 : w !== 0
      if (!inside) continue
      // Samples whose centre (col + 0.5) lies in [xa, xb).
      const from = Math.max(0, Math.ceil(hits[h][0] - 0.5))
      const to = Math.min(n, Math.ceil(hits[h + 1][0] - 0.5))
      mask.fill(1, row * n + from, row * n + to)
    }
  }
  return mask
}

/** Masks of one parsed path: its fill (null without one) and its stroke (null without one). */
export function pathMasks(path, size, ss, view) {
  const subpaths = flattenPath(path.d)
  const fill =
    path.fill === 'none'
      ? null
      : maskOf(
          subpaths.map((s) => s.points),
          path.fillRule,
          size,
          ss,
          view,
        )
  const stroke =
    path.stroke === 'none'
      ? null
      : maskOf(strokePolygons(subpaths, path.strokeWidth, path.join), 'nonzero', size, ss, view)
  return { fill, stroke }
}

/** The view that fits the viewBox `[x, y, w, h]` (square) into `size` pixels with `pad` pixels on each side. */
export function fitView(viewBox, size, pad = 0) {
  const scale = (size - 2 * pad) / Math.max(viewBox[2], viewBox[3])
  return { scale, dx: pad - viewBox[0] * scale, dy: pad - viewBox[1] * scale }
}
