import type { BBox } from '@/server/normalize/geo'
import { bboxFromCenter, haversineMeters } from '@/server/normalize/geo'
import type { GeoCell } from './types'

/**
 * Geographic tiling (§2).
 *
 * Every place-search API caps results per query (Google Places returns at most 60
 * across three pages). Searching "dentists in London" once therefore *cannot*
 * return London's dentists. The fix is to subdivide the area into overlapping
 * circles small enough that each is unlikely to hit the cap, and search each.
 *
 * The overlap factor exists because circles packed edge-to-edge leave gaps at the
 * interstices; 0.75 spacing covers them at a modest cost in duplicate results,
 * which the resolution stage removes anyway.
 */

const OVERLAP = 0.75

export interface TilingPlan {
  cells: GeoCell[]
  /** Explains the plan to the user in the wizard — coverage must be legible. */
  summary: {
    strategy: 'single' | 'grid'
    cellRadiusMeters: number
    cellCount: number
    areaKm2: number
  }
}

export function planTiles(options: {
  centerLat: number
  centerLng: number
  radiusMeters: number
  /** Per-cell radius cap. Smaller = better coverage, more API calls. */
  maxCellRadiusMeters?: number
  /** Hard ceiling so a country-wide search cannot generate 50,000 calls. */
  maxCells?: number
}): TilingPlan {
  const {
    centerLat,
    centerLng,
    radiusMeters,
    maxCellRadiusMeters = 2000,
    maxCells = 144,
  } = options

  const areaKm2 = (Math.PI * radiusMeters ** 2) / 1_000_000

  if (radiusMeters <= maxCellRadiusMeters) {
    return {
      cells: [
        {
          index: 0,
          lat: centerLat,
          lng: centerLng,
          radiusMeters,
          bbox: bboxFromCenter(centerLat, centerLng, radiusMeters),
        },
      ],
      summary: {
        strategy: 'single',
        cellRadiusMeters: radiusMeters,
        cellCount: 1,
        areaKm2,
      },
    }
  }

  // Choose a cell radius that keeps the grid under the cell ceiling.
  let cellRadius = maxCellRadiusMeters
  let step = cellRadius * OVERLAP * 2
  let perSide = Math.ceil((radiusMeters * 2) / step)
  while (perSide * perSide > maxCells) {
    cellRadius *= 1.35
    step = cellRadius * OVERLAP * 2
    perSide = Math.ceil((radiusMeters * 2) / step)
  }

  const cells: GeoCell[] = []
  const latPerMeter = 1 / 111_320
  const lngPerMeter = 1 / (111_320 * Math.cos((centerLat * Math.PI) / 180) || 1)

  const half = (perSide - 1) / 2
  for (let row = 0; row < perSide; row++) {
    for (let col = 0; col < perSide; col++) {
      const dy = (row - half) * step
      const dx = (col - half) * step
      const lat = centerLat + dy * latPerMeter
      const lng = centerLng + dx * lngPerMeter
      // Trim the square grid back to the requested circle.
      if (haversineMeters(centerLat, centerLng, lat, lng) > radiusMeters + cellRadius) {
        continue
      }
      cells.push({
        index: cells.length,
        lat,
        lng,
        radiusMeters: Math.round(cellRadius),
        bbox: bboxFromCenter(lat, lng, cellRadius),
      })
    }
  }

  return {
    cells,
    summary: {
      strategy: 'grid',
      cellRadiusMeters: Math.round(cellRadius),
      cellCount: cells.length,
      areaKm2,
    },
  }
}

export function planTilesForBBox(
  bbox: BBox,
  maxCellRadiusMeters = 2000,
  maxCells = 144,
): TilingPlan {
  const centerLat = (bbox.minLat + bbox.maxLat) / 2
  const centerLng = (bbox.minLng + bbox.maxLng) / 2
  // Radius of the circle that circumscribes the box.
  const radius =
    haversineMeters(bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng) / 2
  const plan = planTiles({
    centerLat,
    centerLng,
    radiusMeters: radius,
    maxCellRadiusMeters,
    maxCells,
  })
  // Keep only cells whose centre is inside the requested box.
  const inside = plan.cells.filter(
    (c) =>
      c.lat >= bbox.minLat &&
      c.lat <= bbox.maxLat &&
      c.lng >= bbox.minLng &&
      c.lng <= bbox.maxLng,
  )
  const cells = (inside.length > 0 ? inside : plan.cells).map((c, i) => ({
    ...c,
    index: i,
  }))
  return { ...plan, cells, summary: { ...plan.summary, cellCount: cells.length } }
}

/**
 * Default radius when the user names a place but gives no radius. These are
 * deliberately conservative — a too-large default silently multiplies API cost.
 */
export function defaultRadiusFor(scope: 'area' | 'city' | 'region' | 'country'): number {
  switch (scope) {
    case 'area':
      return 2_000
    case 'city':
      return 12_000
    case 'region':
      return 45_000
    case 'country':
      return 150_000
  }
}
