/** Geospatial helpers: distance, geohash blocking keys, bounding boxes. */

const EARTH_RADIUS_M = 6_371_008.8

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

/**
 * Geohash used purely as a dedupe blocking key. Precision 6 ≈ 1.2 km × 0.6 km,
 * which is the right granularity: same-building duplicates always share it,
 * while distinct branches usually do not.
 */
export function geohash(lat: number, lng: number, precision = 6): string {
  let minLat = -90
  let maxLat = 90
  let minLng = -180
  let maxLng = 180
  let hash = ''
  let bits = 0
  let bit = 0
  let even = true

  while (hash.length < precision) {
    if (even) {
      const mid = (minLng + maxLng) / 2
      if (lng > mid) {
        bit = (bit << 1) + 1
        minLng = mid
      } else {
        bit <<= 1
        maxLng = mid
      }
    } else {
      const mid = (minLat + maxLat) / 2
      if (lat > mid) {
        bit = (bit << 1) + 1
        minLat = mid
      } else {
        bit <<= 1
        maxLat = mid
      }
    }
    even = !even
    if (++bits === 5) {
      hash += GEOHASH_BASE32[bit]
      bits = 0
      bit = 0
    }
  }
  return hash
}

/** The 8 neighbours + self, so blocking does not miss businesses across a cell edge. */
export function geohashNeighborhood(lat: number, lng: number, precision = 6): string[] {
  // Offsetting by roughly one cell in each direction is sufficient and far
  // simpler (and more obviously correct) than base-32 neighbour arithmetic.
  const latStep = 180 / 2 ** (Math.floor((precision * 5) / 2))
  const lngStep = 360 / 2 ** (Math.ceil((precision * 5) / 2))
  const out = new Set<string>()
  for (const dLat of [-latStep, 0, latStep]) {
    for (const dLng of [-lngStep, 0, lngStep]) {
      out.add(geohash(lat + dLat, lng + dLng, precision))
    }
  }
  return Array.from(out)
}

export interface BBox {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

export function bboxFromCenter(lat: number, lng: number, radiusM: number): BBox {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI)
  const dLng =
    (radiusM / (EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI)
  return {
    minLat: lat - dLat,
    minLng: lng - dLng,
    maxLat: lat + dLat,
    maxLng: lng + dLng,
  }
}

export function bboxCenter(b: BBox): { lat: number; lng: number } {
  return { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 }
}

export function bboxDiagonalMeters(b: BBox): number {
  return haversineMeters(b.minLat, b.minLng, b.maxLat, b.maxLng)
}
