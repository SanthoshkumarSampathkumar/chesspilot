import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { parseUciInfo, scoreForWhite, uciVariationToSan } from './analysis'

describe('Stockfish UCI analysis helpers', () => {
  it('parses evaluation, depth, multi-PV index, nodes, and principal variation', () => {
    expect(parseUciInfo('info depth 12 seldepth 18 multipv 2 score cp -34 nodes 4812 pv e7e5 g1f3 b8c6')).toEqual({
      depth: 12,
      multipv: 2,
      scoreType: 'cp',
      score: -34,
      nodes: 4812,
      pv: ['e7e5', 'g1f3', 'b8c6'],
    })
  })

  it('recognizes mate scores and tolerates non-analysis protocol output', () => {
    expect(parseUciInfo('info depth 8 multipv 1 score mate -3 nodes 70 pv f7g7')).toMatchObject({ scoreType: 'mate', score: -3, depth: 8 })
    expect(parseUciInfo('uciok')).toBeNull()
  })

  it('normalizes engine scores to White’s perspective', () => {
    expect(scoreForWhite(42, 'w')).toBe(42)
    expect(scoreForWhite(42, 'b')).toBe(-42)
  })

  it('converts only a legal principal variation into SAN', () => {
    const start = new Chess().fen()
    expect(uciVariationToSan(start, ['e2e4', 'e7e5', 'g1f3'])).toEqual(['e4', 'e5', 'Nf3'])
    expect(uciVariationToSan(start, ['e2e5', 'e7e6'])).toEqual([])
  })
})
