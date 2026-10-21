import { Chess, type Square } from 'chess.js'

export interface UciInfo {
  depth: number
  multipv: number
  scoreType: 'cp' | 'mate'
  score: number
  nodes: number
  pv: string[]
}

export interface PositionAnalysis {
  fen: string
  bestMove: string | null
  bestMoveSan: string | null
  principalVariation: string[]
  alternatives: string[]
  candidates?: { move: string; san: string; evaluationCp: number; evaluationMate: number | null }[]
  evaluationCp: number
  evaluationMate: number | null
  perspective: 'white'
  depth: number
  nodes: number
  elapsedMs: number
  positionStatus: string
}

export function scoreForWhite(score: number, sideToMove: 'w' | 'b'): number {
  return sideToMove === 'w' ? score : -score
}

export function parseUciInfo(line: string): UciInfo | null {
  const depth = line.match(/\bdepth\s+(\d+)/)
  const score = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/)
  if (!depth || !score) return null
  const pvStart = line.indexOf(' pv ')
  const pv = pvStart === -1 ? [] : line.slice(pvStart + 4).trim().split(/\s+/).filter(Boolean)
  return {
    depth: Number(depth[1]),
    multipv: Number(line.match(/\bmultipv\s+(\d+)/)?.[1] ?? 1),
    scoreType: score[1] as 'cp' | 'mate',
    score: Number(score[2]),
    nodes: Number(line.match(/\bnodes\s+(\d+)/)?.[1] ?? 0),
    pv,
  }
}

export function uciVariationToSan(fen: string, uciMoves: string[]): string[] {
  const chess = new Chess(fen)
  const san: string[] = []
  for (const uci of uciMoves) {
    const match = uci.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i)
    if (!match) break
    try {
      san.push(chess.move({ from: match[1].toLowerCase() as Square, to: match[2].toLowerCase() as Square, promotion: match[3]?.toLowerCase() }).san)
    } catch {
      break
    }
  }
  return san
}
