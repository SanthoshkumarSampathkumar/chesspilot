import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Chess, type Square } from 'chess.js'
import { createRecognizer, placementToFen, resolveOrientation, type BoardCorners, type Recognizer } from '@scoriiu/fenshot'
import ortWasmMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import {
  Activity, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight,
  CircleHelp, Clock3, Cpu, Crown, Expand, Eye, FileUp, Gauge, History,
  LayoutDashboard, LockKeyhole, Monitor, MoreHorizontal, Pause, Play,
  PictureInPicture2, RotateCcw, Settings2, ShieldCheck, Sparkles,
  Square as SquareIcon, Target, X,
} from 'lucide-react'
import { parseUciInfo, scoreForWhite, uciVariationToSan, type PositionAnalysis, type UciInfo } from './analysis'

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const PIECES: Record<string, string> = {
  wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙',
  bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟',
}
const files = 'abcdefgh'

type NavKey = 'workspace' | 'position' | 'history' | 'settings'
type AiProviderSettings = { endpoint: string; model: string; apiKey: string }
type DetectedPosition = { placement: string; source: 'local' | 'ai'; meanConfidence: number | null; minConfidence: number | null; reliable: boolean; plausible: boolean; corners?: BoardCorners }
type BoardColors = { light: string; dark: string }
type ProviderName = 'vision' | 'coach'

type AiMoveResult = { move: string; reason: string }

function sampleBoardColors(frame: ImageBitmap, corners: BoardCorners): BoardColors | null {
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(frame, 0, 0)
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const sums = [[0, 0, 0, 0], [0, 0, 0, 0]]
  const boardWidth = corners.x1 - corners.x0
  const boardHeight = corners.y1 - corners.y0
  if (boardWidth < 16 || boardHeight < 16) return null
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const group = (row + col) % 2
    for (const fy of [0.17, 0.83]) for (const fx of [0.17, 0.83]) {
      const x = Math.max(0, Math.min(canvas.width - 1, Math.round(corners.x0 + (col + fx) * boardWidth / 8)))
      const y = Math.max(0, Math.min(canvas.height - 1, Math.round(corners.y0 + (row + fy) * boardHeight / 8)))
      const offset = (y * canvas.width + x) * 4
      sums[group][0] += image.data[offset]
      sums[group][1] += image.data[offset + 1]
      sums[group][2] += image.data[offset + 2]
      sums[group][3]++
    }
  }
  const color = (group: number) => `rgb(${sums[group].slice(0, 3).map((value) => Math.max(0, Math.min(255, Math.round(value / sums[group][3] / 8) * 8))).join(' ')})`
  return { light: color(0), dark: color(1) }
}

async function requestChatCompletion(settings: AiProviderSettings, messages: Array<{ role: 'system' | 'user'; content: string | Array<Record<string, unknown>> }>): Promise<string> {
  const response = await fetch(settings.endpoint.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model.trim(), messages, temperature: 0.2 }),
  })
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}. Check the endpoint, model, and API key.`)
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('\n')
  throw new Error('Provider response did not contain message text.')
}

const VAULT_DB = 'chesspilot-provider-vault'
const VAULT_STORE = 'encrypted-settings'

function openProviderVault(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(VAULT_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function vaultGet<T>(db: IDBDatabase, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(VAULT_STORE, 'readonly').objectStore(VAULT_STORE).get(id)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

function vaultPut(db: IDBDatabase, id: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(VAULT_STORE, 'readwrite')
    transaction.objectStore(VAULT_STORE).put(value, id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function providerVaultKey(db: IDBDatabase, create: boolean): Promise<CryptoKey | undefined> {
  const existing = await vaultGet<CryptoKey>(db, 'encryption-key')
  if (existing || !create) return existing
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await vaultPut(db, 'encryption-key', key)
  return key
}

async function saveProviderToVault(name: ProviderName, settings: AiProviderSettings): Promise<void> {
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) throw new Error('This browser does not support encrypted local settings.')
  const db = await openProviderVault()
  try {
    const key = await providerVaultKey(db, true)
    if (!key) throw new Error('Encryption key unavailable.')
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode(JSON.stringify(settings))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
    await vaultPut(db, name, { iv, ciphertext })
  } finally { db.close() }
}

async function loadProviderFromVault(name: ProviderName): Promise<AiProviderSettings | null> {
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) return null
  const db = await openProviderVault()
  try {
    const record = await vaultGet<{ iv: Uint8Array; ciphertext: ArrayBuffer }>(db, name)
    const key = await providerVaultKey(db, false)
    if (!record || !key) return null
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.ciphertext)
    return JSON.parse(new TextDecoder().decode(plaintext)) as AiProviderSettings
  } finally { db.close() }
}

function parseVisionPlacement(text: string): string {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  let placement = ''
  try {
    const parsed = JSON.parse(cleaned) as { placement?: string; fen?: string }
    placement = parsed.placement ?? parsed.fen?.split(/\s+/)[0] ?? ''
  } catch {
    placement = cleaned.match(/[rnbqkpRNBQKP1-8]+(?:\/[rnbqkpRNBQKP1-8]+){7}/)?.[0] ?? ''
  }
  if (!placement || placement.split('/').length !== 8) throw new Error('Vision model did not return a valid 8-rank board placement.')
  const game = new Chess(`${placement} w - - 0 1`)
  const normalized = game.fen().split(' ')[0]
  const kings = [...normalized].filter((piece) => piece === 'K').length === 1 && [...normalized].filter((piece) => piece === 'k').length === 1
  if (!kings) throw new Error('Vision model result needs exactly one king of each color.')
  return normalized
}

function parseAiMove(text: string, fen: string): AiMoveResult {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  let parsed: { move?: string; bestMove?: string; reason?: string }
  try { parsed = JSON.parse(cleaned) as typeof parsed }
  catch { throw new Error('AI move provider did not return the expected JSON response.') }
  const requested = (parsed.move ?? parsed.bestMove ?? '').trim()
  if (!requested) throw new Error('AI provider did not include a move.')
  const game = new Chess(fen)
  const legal = game.moves({ verbose: true })
  const normalized = requested.replace(/[+#?!]+$/g, '').trim().toLowerCase()
  const match = legal.find((move) => {
    const uci = `${move.from}${move.to}${move.promotion ?? ''}`.toLowerCase()
    return uci === normalized || move.san.replace(/[+#?!]+$/g, '').toLowerCase() === normalized
  })
  if (!match) throw new Error(`AI suggested “${requested}”, which is not legal in this position. Try again or use Stockfish.`)
  return { move: `${match.from}${match.to}${match.promotion ?? ''}`, reason: (parsed.reason ?? '').trim() }
}

function fenForObservedPlacement(placement: string, currentFen: string, fallbackTurn: 'w' | 'b'): string {
  const current = new Chess(currentFen)
  const currentPlacement = current.fen().split(' ')[0]
  if (placement === currentPlacement) return current.fen()
  let frontier = [current]
  // Prefer applying the observed move(s) to the existing game so castling and
  // en-passant state are retained when the new image follows the current board.
  for (let depth = 1; depth <= 2; depth += 1) {
    const nextFrontier: Chess[] = []
    for (const position of frontier) {
      for (const move of position.moves({ verbose: true })) {
        const next = new Chess(position.fen())
        next.move({ from: move.from, to: move.to, promotion: move.promotion })
        if (next.fen().split(' ')[0] === placement) return next.fen()
        nextFrontier.push(next)
      }
    }
    frontier = nextFrontier
  }
  return new Chess(placementToFen(placement, fallbackTurn)).fen()
}

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>
    }
  }
}

function formatEvaluation(cp: number, mate: number | null = null): string {
  if (mate !== null) return mate > 0 ? `+M${mate}` : `−M${Math.abs(mate)}`
  const pawns = cp / 100
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`
}

function App() {
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [offlineReady, setOfflineReady] = useState(() => typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller))
  const [fen, setFen] = useState(INITIAL_FEN)
  const [fenDraft, setFenDraft] = useState(INITIAL_FEN)
  const [fenOpen, setFenOpen] = useState(false)
  const [fenError, setFenError] = useState('')
  const [winningSide, setWinningSide] = useState<'w' | 'b'>('w')
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white')
  const [boardColors, setBoardColors] = useState<BoardColors>({ light: '#dce5e3', dark: '#64887f' })
  const [selected, setSelected] = useState<Square | null>(null)
  const [moveHistory, setMoveHistory] = useState<string[]>([])
  const [priorPositions, setPriorPositions] = useState<string[]>([])
  const [analysis, setAnalysis] = useState<PositionAnalysis | null>(null)
  const [analysisState, setAnalysisState] = useState<'idle' | 'running' | 'ready' | 'error'>('idle')
  const [analysisError, setAnalysisError] = useState('')
  const [workerReady, setWorkerReady] = useState(false)
  const [workerFailed, setWorkerFailed] = useState(false)
  const [activeNav, setActiveNav] = useState<NavKey>('workspace')
  const [showFairPlay, setShowFairPlay] = useState(false)
  const [trainingConfirmed, setTrainingConfirmed] = useState(false)
  const [captureState, setCaptureState] = useState<'off' | 'active' | 'paused' | 'error'>('off')
  const [captureError, setCaptureError] = useState('')
  const [captureStream, setCaptureStream] = useState<MediaStream | null>(null)
  const [captureMuted, setCaptureMuted] = useState(false)
  const [sessionPaused, setSessionPaused] = useState(false)
  const [recentAnalysis, setRecentAnalysis] = useState<PositionAnalysis[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [floatingWindow, setFloatingWindow] = useState<Window | null>(null)
  const [floatingError, setFloatingError] = useState('')
  const [scanState, setScanState] = useState<'idle' | 'loading' | 'scanning' | 'ai-scanning' | 'ai-ready' | 'ready' | 'unreliable' | 'not-found' | 'error'>('idle')
  const [scanError, setScanError] = useState('')
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [selectingRegion, setSelectingRegion] = useState(false)
  const [scanNonce, setScanNonce] = useState(0)
  const [detectedBoard, setDetectedBoard] = useState<DetectedPosition | null>(null)
  const [visionSettings, setVisionSettings] = useState<AiProviderSettings>({ endpoint: 'https://api.topbilling.in/v1/chat/completions', model: '', apiKey: '' })
  const [coachSettings, setCoachSettings] = useState<AiProviderSettings>({ endpoint: 'https://api.topbilling.in/v1/chat/completions', model: '', apiKey: '' })
  const [visionSaved, setVisionSaved] = useState(false)
  const [coachSaved, setCoachSaved] = useState(false)
  const [providerSettingsError, setProviderSettingsError] = useState('')
  const [coachExplanation, setCoachExplanation] = useState('')
  const visionSettingsRef = useRef(visionSettings)
  const coachSettingsRef = useRef(coachSettings)
  const coachRequestId = useRef('')
  const [detectedTurn, setDetectedTurn] = useState<'w' | 'b'>('w')
  const [lastScanAt, setLastScanAt] = useState<Date | null>(null)
  const recognizerRef = useRef<Recognizer | null>(null)
  const recognitionBusyRef = useRef(false)
  const cropRectRef = useRef(cropRect)
  const selectionAnchorRef = useRef<{ x: number; y: number } | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const currentFenRef = useRef(fen)
  const detectedTurnRef = useRef(detectedTurn)
  const workerReadyRef = useRef(workerReady)
  const workerFailedRef = useRef(workerFailed)
  const stableDetectedPlacementRef = useRef<{ placement: string; count: number } | null>(null)
  const lastAutoAnalyzedFenRef = useRef('')
  const latestAnalysisId = useRef('')
  const currentSearch = useRef<{ positionId: string; fen: string; startedAt: number; lines: Map<number, UciInfo> } | null>(null)
  const queuedSearch = useRef<{ positionId: string; fen: string; startedAt: number; lines: Map<number, UciInfo> } | null>(null)
  const analysisTimerRef = useRef<number | null>(null)
  const lastEngineLineRef = useRef('')
  const previewRef = useRef<HTMLVideoElement>(null)
  const captureStreamRef = useRef<MediaStream | null>(null)
  const captureMutedRef = useRef(false)

  useEffect(() => {
    const updateOnline = () => setIsOnline(navigator.onLine)
    const markOfflineReady = () => setOfflineReady(Boolean(navigator.serviceWorker?.controller))
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    navigator.serviceWorker?.addEventListener('controllerchange', markOfflineReady)
    markOfflineReady()
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
      navigator.serviceWorker?.removeEventListener('controllerchange', markOfflineReady)
    }
  }, [])

  currentFenRef.current = fen
  detectedTurnRef.current = detectedTurn
  workerReadyRef.current = workerReady
  workerFailedRef.current = workerFailed

  useEffect(() => { visionSettingsRef.current = visionSettings }, [visionSettings])
  useEffect(() => { coachSettingsRef.current = coachSettings }, [coachSettings])
  useEffect(() => {
    let cancelled = false
    void Promise.all([loadProviderFromVault('vision'), loadProviderFromVault('coach')]).then(([vision, coach]) => {
      if (cancelled) return
      if (vision) { setVisionSettings(vision); setVisionSaved(true) }
      if (coach) { setCoachSettings(coach); setCoachSaved(true) }
    }).catch(() => { if (!cancelled) setProviderSettingsError('Could not unlock saved provider settings in this browser profile.') })
    return () => { cancelled = true }
  }, [])

  const saveProviderSettings = async (name: ProviderName, settings: AiProviderSettings) => {
    try {
      const endpoint = new URL(settings.endpoint.trim())
      if (!['http:', 'https:'].includes(endpoint.protocol) || !settings.model.trim() || !settings.apiKey.trim()) {
        setProviderSettingsError('Enter a valid endpoint, model, and API key before saving.')
        return
      }
      await saveProviderToVault(name, settings)
      if (name === 'vision') setVisionSaved(true)
      else setCoachSaved(true)
      setProviderSettingsError('')
    } catch {
      setProviderSettingsError('Could not encrypt and save settings locally. Nothing was saved in plaintext.')
    }
  }

  const requestAiMoveFallback = async (positionFen: string, stockfishIssue: string) => {
    const provider = coachSettingsRef.current
    if (!provider.endpoint.trim() || !provider.model.trim() || !provider.apiKey.trim()) {
      setAnalysis(null)
      setAnalysisError(`${stockfishIssue} To use AI move fallback, configure the AI coach endpoint, model, and API key in Privacy & settings.`)
      setAnalysisState('error')
      return
    }
    const requestId = crypto.randomUUID()
    latestAnalysisId.current = requestId
    currentSearch.current = null
    queuedSearch.current = null
    if (analysisTimerRef.current !== null) window.clearTimeout(analysisTimerRef.current)
    analysisTimerRef.current = null
    setAnalysis(null)
    setAnalysisError('')
    setCoachExplanation('')
    setAnalysisState('running')
    try {
      const game = new Chess(positionFen)
      const legalMoves = game.moves({ verbose: true }).map((move) => ({ san: move.san, uci: `${move.from}${move.to}${move.promotion ?? ''}` }))
      if (!legalMoves.length) throw new Error('This position has no legal moves to recommend.')
      const answer = await requestChatCompletion(provider, [
        { role: 'system', content: 'You are an educational chess move recommender for a permitted training position. Select the strongest practical move from the supplied legal moves only. Return only JSON: {"move":"SAN or UCI exactly as listed","reason":"brief explanation"}. Never invent a move.' },
        { role: 'user', content: `Stockfish failed (${stockfishIssue}). Position FEN: ${positionFen}\nSide to move: ${game.turn() === 'w' ? 'White' : 'Black'}\nLegal moves: ${JSON.stringify(legalMoves)}\nChoose the best move for the side to move.` },
      ])
      if (latestAnalysisId.current !== requestId) return
      const choice = parseAiMove(answer, positionFen)
      const move = game.move({ from: choice.move.slice(0, 2) as Square, to: choice.move.slice(2, 4) as Square, promotion: choice.move[4]?.toLowerCase() })
      const result: PositionAnalysis = {
        fen: positionFen,
        bestMove: choice.move,
        bestMoveSan: move.san,
        principalVariation: [move.san],
        alternatives: [],
        evaluationCp: 0,
        evaluationMate: null,
        perspective: 'white',
        depth: 0,
        nodes: 0,
        elapsedMs: 0,
        positionStatus: 'AI fallback · verify this candidate',
      }
      setAnalysis(result)
      setCoachExplanation(choice.reason || 'AI selected this legal candidate after Stockfish failed. Review the move and position before using it.')
      setAnalysisState('ready')
    } catch (error) {
      if (latestAnalysisId.current !== requestId) return
      setAnalysisError(`Stockfish failed and AI move fallback could not complete: ${error instanceof Error ? error.message : String(error)}`)
      setAnalysisState('error')
    }
  }

  const chess = useMemo(() => {
    try { return new Chess(fen) } catch { return new Chess(INITIAL_FEN) }
  }, [fen])
  const board = chess.board()
  const displayIndices = boardOrientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]
  const boardColorStyle = { '--white-square': boardColors.light, '--black-square': boardColors.dark } as CSSProperties
  const targetCandidates = analysis?.candidates ?? []
  const recommendation = targetCandidates.reduce<(typeof targetCandidates)[number] | null>((best, candidate) => {
    const candidateScore = candidate.evaluationMate === null ? candidate.evaluationCp : Math.sign(candidate.evaluationMate) * 100000
    if (!best) return candidate
    const bestScore = best.evaluationMate === null ? best.evaluationCp : Math.sign(best.evaluationMate) * 100000
    return winningSide === 'w' ? candidateScore > bestScore ? candidate : best : candidateScore < bestScore ? candidate : best
  }, null)
  const suggestedMove = recommendation ?? (analysis?.bestMove && analysis.bestMoveSan ? { move: analysis.bestMove, san: analysis.bestMoveSan, evaluationCp: analysis.evaluationCp, evaluationMate: analysis.evaluationMate } : null)
  const isBlunderCandidate = Boolean(recommendation && analysis?.bestMove && recommendation.move !== analysis.bestMove && chess.turn() !== winningSide)
  const legalTargets = useMemo(() => {
    if (!selected) return new Set<string>()
    return new Set(chess.moves({ square: selected, verbose: true }).map((move) => move.to))
  }, [fen, selected])
  const isWhiteToMove = chess.turn() === 'w'
  const isGameOver = chess.isGameOver()
  const engineScorePawns = analysis ? analysis.evaluationCp / 100 : 0
  const edgeSide: 'white' | 'black' | 'even' | 'ai' | 'pending' = analysis?.depth
    ? analysis.evaluationMate !== null ? analysis.evaluationMate > 0 ? 'white' : 'black' : engineScorePawns > 0.25 ? 'white' : engineScorePawns < -0.25 ? 'black' : 'even'
    : analysis?.bestMove ? 'ai' : 'pending'
  const edgeTitle = edgeSide === 'white' ? 'White is ahead' : edgeSide === 'black' ? 'Black is ahead' : edgeSide === 'even' ? 'Position is even' : edgeSide === 'ai' ? 'AI move suggested' : analysisState === 'running' ? 'Analyzing position' : 'No evaluation yet'
  const edgeValue = analysis?.depth ? formatEvaluation(analysis.evaluationCp, analysis.evaluationMate) : edgeSide === 'ai' ? 'AI' : '—'
  const edgeMarker = analysis?.depth ? `${Math.max(7, Math.min(93, 50 - Math.max(-3, Math.min(3, analysis.evaluationMate ? Math.sign(analysis.evaluationMate) * 3 : engineScorePawns) * 14)))}%` : '50%'

  useEffect(() => {
    const engineUrl = new URL(`${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`, window.location.origin)
    const wasmUrl = new URL(`${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.wasm`, window.location.origin)
    // Bypass a stale or partial cached engine/WASM pair after app updates.
    engineUrl.searchParams.set('v', '19-lite-single-v2')
    wasmUrl.searchParams.set('v', '19-lite-single-v2')
    engineUrl.hash = encodeURIComponent(wasmUrl.href)
    const worker = new Worker(engineUrl, { type: 'classic', name: 'chesspilot-stockfish' })
    workerRef.current = worker
    let startupTimer: number | null = null
    const clearAnalysisTimer = () => {
      if (analysisTimerRef.current !== null) window.clearTimeout(analysisTimerRef.current)
      analysisTimerRef.current = null
    }
    const startQueuedSearch = () => {
      const job = queuedSearch.current
      if (!job) return
      queuedSearch.current = null
      currentSearch.current = job
      job.lines.clear()
      worker.postMessage(`position fen ${job.fen}`)
      worker.postMessage('go movetime 900')
      clearAnalysisTimer()
      analysisTimerRef.current = window.setTimeout(() => {
        if (currentSearch.current?.positionId !== job.positionId) return
        currentSearch.current = null
        queuedSearch.current = null
        worker.postMessage('stop')
        void requestAiMoveFallback(job.fen, `Stockfish timed out. Last engine response: ${lastEngineLineRef.current || 'none'}.`)
      }, 15000)
    }
    worker.onmessage = (event: MessageEvent<string>) => {
      const uciLine = typeof event.data === 'string' ? event.data : String(event.data)
      lastEngineLineRef.current = uciLine.slice(0, 180)
      if (uciLine === 'uciok') {
        worker.postMessage('setoption name MultiPV value 5')
        worker.postMessage('isready')
        return
      }
      if (uciLine === 'readyok') {
        if (startupTimer !== null) window.clearTimeout(startupTimer)
        workerReadyRef.current = true
        workerFailedRef.current = false
        setWorkerReady(true)
        setWorkerFailed(false)
        return
      }
      const activeJob = currentSearch.current
      if (!activeJob) return
      const info = parseUciInfo(uciLine)
      if (info) {
        const previous = activeJob.lines.get(info.multipv)
        if (!previous || info.depth >= previous.depth) activeJob.lines.set(info.multipv, info)
        if (info.multipv === 1 && info.pv.length && activeJob.positionId === latestAnalysisId.current) {
          const root = new Chess(activeJob.fen)
          const rootTurn = root.turn()
          const variation = uciVariationToSan(activeJob.fen, info.pv)
          let bestMoveSan: string | null = null
          try {
            const move = root.move({ from: info.pv[0].slice(0, 2) as Square, to: info.pv[0].slice(2, 4) as Square, promotion: info.pv[0][4]?.toLowerCase() })
            bestMoveSan = move.san
          } catch { /* Ignore partial or illegal principal variations. */ }
          if (bestMoveSan) {
            const candidates = [...activeJob.lines.entries()].sort(([a], [b]) => a - b).flatMap(([, line]) => {
              const san = uciVariationToSan(activeJob.fen, line.pv)[0]
              return san && line.pv[0] ? [{ move: line.pv[0], san, evaluationCp: line.scoreType === 'cp' ? scoreForWhite(line.score, rootTurn) : 0, evaluationMate: line.scoreType === 'mate' ? scoreForWhite(line.score, rootTurn) : null }] : []
            })
            const alternatives = [2, 3, 4, 5].flatMap((index) => {
              const line = activeJob.lines.get(index)
              const moves = line ? uciVariationToSan(activeJob.fen, line.pv) : []
              return moves.length ? [moves[0]] : []
            })
            setAnalysis({
              fen: activeJob.fen,
              bestMove: info.pv[0],
              bestMoveSan,
              principalVariation: variation,
              alternatives,
              candidates,
              evaluationCp: info.scoreType === 'cp' ? scoreForWhite(info.score, rootTurn) : 0,
              evaluationMate: info.scoreType === 'mate' ? scoreForWhite(info.score, rootTurn) : null,
              perspective: 'white',
              depth: info.depth,
              nodes: info.nodes,
              elapsedMs: Math.round(performance.now() - activeJob.startedAt),
              positionStatus: `Search in progress · depth ${info.depth}`,
            })
          }
        }
        return
      }
      if (!uciLine.startsWith('bestmove ')) return

      clearAnalysisTimer()
      currentSearch.current = null
      if (activeJob.positionId === latestAnalysisId.current) {
        const uci = uciLine.match(/^bestmove\s+(\S+)/)?.[1] ?? ''
        const root = new Chess(activeJob.fen)
        const rootTurn = root.turn()
        let bestMoveSan: string | null = null
        let bestMove: string | null = null
        if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(uci)) {
          try {
            const move = root.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4]?.toLowerCase() })
            bestMove = uci
            bestMoveSan = move.san
          } catch { /* Reject an illegal or malformed engine move. */ }
        }
        const primary = activeJob.lines.get(1)
        const evaluationCp = primary?.scoreType === 'cp' ? scoreForWhite(primary.score, rootTurn) : 0
        const evaluationMate = primary?.scoreType === 'mate' ? scoreForWhite(primary.score, rootTurn) : null
        let pvSan = primary ? uciVariationToSan(activeJob.fen, primary.pv) : []
        if (bestMoveSan && pvSan[0] !== bestMoveSan) pvSan = []
        const candidates = [...activeJob.lines.entries()].sort(([a], [b]) => a - b).flatMap(([, line]) => {
          const san = uciVariationToSan(activeJob.fen, line.pv)[0]
          return san && line.pv[0] ? [{ move: line.pv[0], san, evaluationCp: line.scoreType === 'cp' ? scoreForWhite(line.score, rootTurn) : 0, evaluationMate: line.scoreType === 'mate' ? scoreForWhite(line.score, rootTurn) : null }] : []
        })
        const alternatives = [2, 3, 4, 5].flatMap((index) => {
          const variation = activeJob.lines.get(index)
          const moves = variation ? uciVariationToSan(activeJob.fen, variation.pv) : []
          return moves.length ? [moves[0]] : []
        })
        const analysis: PositionAnalysis = {
          fen: activeJob.fen,
          bestMove,
          bestMoveSan,
          principalVariation: pvSan,
          alternatives,
          candidates,
          evaluationCp,
          evaluationMate,
          perspective: 'white',
          depth: primary?.depth ?? 0,
          nodes: primary?.nodes ?? 0,
          elapsedMs: Math.round(performance.now() - activeJob.startedAt),
          positionStatus: root.isCheckmate() ? 'Checkmate' : root.isCheck() ? 'Check — position verified' : 'Position verified',
        }
        setAnalysis(analysis)
        setAnalysisState('ready')
        if (analysis.bestMove) void requestCoachExplanation(analysis)
        else if (!root.isGameOver()) void requestAiMoveFallback(activeJob.fen, 'Stockfish returned no legal move.')
        if (analysis.bestMove) setRecentAnalysis((items) => [analysis, ...items.filter((item) => item.fen !== analysis.fen)].slice(0, 8))
      }
      startQueuedSearch()
    }
    worker.onerror = (event) => {
      clearAnalysisTimer()
      if (startupTimer !== null) window.clearTimeout(startupTimer)
      setWorkerReady(false)
      setWorkerFailed(true)
      workerReadyRef.current = false
      workerFailedRef.current = true
      const detail = event.message || (event.error instanceof Error ? event.error.message : '')
      const location = event.filename ? ` (${event.filename}${event.lineno ? `:${event.lineno}` : ''})` : ''
      console.error('Stockfish worker failed to start or run.', { message: detail || 'Browser did not provide an error message.', filename: event.filename, line: event.lineno, worker: engineUrl.href, wasm: wasmUrl.href })
      const issue = `Stockfish worker failed${detail ? `: ${detail}` : '. The browser could not start the engine.'}${location}`
      if (currentSearch.current) void requestAiMoveFallback(currentSearch.current.fen, issue)
      else {
        setAnalysisError(issue)
        setAnalysisState('error')
      }
    }
    worker.onmessageerror = () => {
      clearAnalysisTimer()
      setWorkerFailed(true)
      const issue = 'Stockfish sent a response the browser could not read.'
      if (currentSearch.current) void requestAiMoveFallback(currentSearch.current.fen, issue)
      else { setAnalysisError(issue); setAnalysisState('error'); setWorkerFailed(true) }
    }
    worker.postMessage('uci')
    startupTimer = window.setTimeout(() => {
      if (workerReady) return
      setWorkerFailed(true)
      setAnalysisError('Stockfish did not finish loading. Configure the AI coach provider in Settings to use fallback recommendations.')
      setAnalysisState('error')
    }, 12000)
    return () => {
      clearAnalysisTimer()
      if (startupTimer !== null) window.clearTimeout(startupTimer)
      worker.postMessage('stop')
      worker.postMessage('quit')
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = captureStream
  }, [captureStream])

  useEffect(() => { cropRectRef.current = cropRect }, [cropRect])

  useEffect(() => {
    if (!captureStream || captureState !== 'active') {
      setScanState('idle')
      return
    }
    let cancelled = false
    let timer: number | undefined
    const recognizer = recognizerRef.current ?? createRecognizer({
      modelUrl: `${import.meta.env.BASE_URL}models/chess-tiles-v2.onnx`,
      wasmPaths: { mjs: ortWasmMjsUrl, wasm: ortWasmUrl },
    })
    recognizerRef.current = recognizer
    setScanState('loading')
    recognizer.warmUp()

    const scanFrame = async () => {
      const video = previewRef.current
      if (cancelled || captureMutedRef.current || recognitionBusyRef.current || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
      recognitionBusyRef.current = true
      setScanState('scanning')
      try {
        const crop = cropRectRef.current
        const sx = crop ? Math.max(0, Math.floor(crop.x * video.videoWidth)) : 0
        const sy = crop ? Math.max(0, Math.floor(crop.y * video.videoHeight)) : 0
        const sw = crop ? Math.max(1, Math.min(video.videoWidth - sx, Math.floor(crop.w * video.videoWidth))) : video.videoWidth
        const sh = crop ? Math.max(1, Math.min(video.videoHeight - sy, Math.floor(crop.h * video.videoHeight))) : video.videoHeight
        const scale = Math.min(1, 1600 / Math.max(sw, sh))
        const frame = await createImageBitmap(video, sx, sy, sw, sh, {
          resizeWidth: Math.max(1, Math.round(sw * scale)),
          resizeHeight: Math.max(1, Math.round(sh * scale)),
          resizeQuality: 'high',
        })
        try {
          let result: DetectedPosition | null = null
          let localError: unknown = null
          try {
            const local = await recognizer.recognize(frame)
            if (local) {
              result = { placement: local.placement, source: 'local', meanConfidence: local.meanConfidence, minConfidence: local.minConfidence, reliable: local.reliable, plausible: local.plausible, corners: local.corners }
              const colors = sampleBoardColors(frame, local.corners)
              if (colors) setBoardColors(colors)
              setBoardOrientation(resolveOrientation(local.placement).orientation)
            }
          } catch (error) { localError = error }
          if (cancelled) return
          setLastScanAt(new Date())
          if (result?.reliable && result.plausible) {
            setDetectedBoard(result)
            setScanState('ready')
            synchronizeDetectedPosition(result)
          } else {
            const provider = visionSettingsRef.current
            if (provider.endpoint.trim() && provider.model.trim() && provider.apiKey.trim()) {
              setScanState('ai-scanning')
              const canvas = document.createElement('canvas')
              canvas.width = frame.width
              canvas.height = frame.height
              const context = canvas.getContext('2d')
              if (!context) throw new Error('Could not prepare the shared frame for vision analysis.')
              context.drawImage(frame, 0, 0)
              const image = canvas.toDataURL('image/jpeg', 0.82)
              const answer = await requestChatCompletion(provider, [
                { role: 'system', content: 'You read chessboard screenshots. Return only JSON: {"placement":"FEN piece placement"} or {"placement":"NO_BOARD"}. Read all 64 squares carefully. FEN placement has exactly 8 ranks, uppercase pieces are White, lowercase pieces are Black. Do not infer hidden pieces. If no clear chessboard is visible, return NO_BOARD.' },
                { role: 'user', content: [{ type: 'text', text: 'Read the visible chessboard position from this image. Return the board placement only as JSON.' }, { type: 'image_url', image_url: { url: image } }] },
              ])
              if (cancelled) return
              if (/NO_BOARD/i.test(answer)) {
                setDetectedBoard(null)
                stableDetectedPlacementRef.current = null
                setScanState('not-found')
              } else {
                const placement = parseVisionPlacement(answer)
                const visionPosition = { placement, source: 'ai' as const, meanConfidence: null, minConfidence: null, reliable: true, plausible: true }
                setDetectedBoard(visionPosition)
                setScanState('ai-ready')
                synchronizeDetectedPosition(visionPosition)
              }
            } else if (result) {
              setDetectedBoard(result)
              stableDetectedPlacementRef.current = null
              setScanState('unreliable')
            } else {
              setDetectedBoard(null)
              stableDetectedPlacementRef.current = null
              setScanState(localError ? 'error' : 'not-found')
              if (localError) setScanError(`${localError instanceof Error ? localError.message : String(localError)} Configure a vision provider in Settings to enable AI fallback.`)
            }
          }
        } finally {
          frame.close()
        }
      } catch (error) {
        if (!cancelled) {
          setScanError(error instanceof Error ? error.message : String(error))
          setScanState('error')
        }
      } finally {
        recognitionBusyRef.current = false
      }
    }
    timer = window.setInterval(() => void scanFrame(), 3000)
    const warmupTimer = window.setTimeout(() => void scanFrame(), 800)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(warmupTimer)
    }
  }, [captureStream, captureState, scanNonce])

  useEffect(() => {
    if (!floatingWindow) return
    floatingWindow.addEventListener('pagehide', () => setFloatingWindow(null), { once: true })
  }, [floatingWindow])

  useEffect(() => () => {
    const activeStream = captureStreamRef.current
    captureStreamRef.current = null
    activeStream?.getTracks().forEach((track) => track.stop())
  }, [])

  const invalidateAnalysis = () => {
    latestAnalysisId.current = ''
    queuedSearch.current = null
    if (analysisTimerRef.current !== null) window.clearTimeout(analysisTimerRef.current)
    analysisTimerRef.current = null
    if (currentSearch.current) workerRef.current?.postMessage('stop')
  }

  const updatePosition = (nextFen: string, san?: string) => {
    invalidateAnalysis()
    setPriorPositions((positions) => [...positions, fen])
    setFen(nextFen)
    setFenDraft(nextFen)
    setSelected(null)
    setAnalysis(null)
    setAnalysisState('idle')
    setCoachExplanation('')
    if (san) setMoveHistory((moves) => [...moves, san])
  }

  const handleSquareClick = (square: Square) => {
    const game = new Chess(fen)
    if (selected && legalTargets.has(square)) {
      try {
        const move = game.move({ from: selected, to: square, promotion: 'q' })
        updatePosition(game.fen(), move.san)
        return
      } catch { /* A promotion choice or stale selection can safely fall through. */ }
    }
    const piece = game.get(square)
    if (piece && piece.color === game.turn()) setSelected(square)
    else setSelected(null)
  }

  const loadFen = () => {
    try {
      const game = new Chess(fenDraft.trim())
      invalidateAnalysis()
      setPriorPositions([])
      setMoveHistory([])
      setFen(game.fen())
      setFenDraft(game.fen())
      setSelected(null)
      setAnalysis(null)
      setAnalysisState('idle')
      setCoachExplanation('')
      setFenError('')
      setFenOpen(false)
    } catch {
      setFenError('That FEN could not be validated. Check the board, turn, castling, en passant, and move counters.')
    }
  }

  const undoMove = () => {
    const previous = priorPositions.at(-1)
    if (!previous) return
    invalidateAnalysis()
    setFen(previous)
    setFenDraft(previous)
    setPriorPositions((positions) => positions.slice(0, -1))
    setMoveHistory((moves) => moves.slice(0, -1))
    setSelected(null)
    setAnalysis(null)
    setAnalysisState('idle')
    setCoachExplanation('')
  }

  const runAnalysisForFen = (targetFen: string) => {
    try {
      const validated = new Chess(targetFen)
      if (!workerRef.current || workerFailedRef.current || !workerReadyRef.current) {
        void requestAiMoveFallback(validated.fen(), 'The Stockfish worker is not ready.')
        return
      }
      const positionId = crypto.randomUUID()
      latestAnalysisId.current = positionId
      setAnalysis(null)
      setAnalysisError('')
      setCoachExplanation('')
      setAnalysisState('running')
      const job = { positionId, fen: validated.fen(), startedAt: performance.now(), lines: new Map<number, UciInfo>() }
      queuedSearch.current = job
      if (currentSearch.current) workerRef.current.postMessage('stop')
      else {
        const next = queuedSearch.current
        if (next) {
          queuedSearch.current = null
          currentSearch.current = next
          workerRef.current.postMessage(`position fen ${next.fen}`)
          workerRef.current.postMessage('go movetime 900')
          if (analysisTimerRef.current !== null) window.clearTimeout(analysisTimerRef.current)
          analysisTimerRef.current = window.setTimeout(() => {
            if (currentSearch.current?.positionId !== next.positionId) return
            currentSearch.current = null
            queuedSearch.current = null
            workerRef.current?.postMessage('stop')
            void requestAiMoveFallback(next.fen, `Stockfish timed out. Last engine response: ${lastEngineLineRef.current || 'none'}.`)
          }, 15000)
        }
      }
    } catch {
      setAnalysisError('This position is not valid. Load a valid FEN before analyzing.')
      setAnalysisState('error')
    }
  }

  const analyze = () => runAnalysisForFen(fen)

  const requestCoachExplanation = async (positionAnalysis: PositionAnalysis) => {
    const provider = coachSettingsRef.current
    if (!provider.endpoint.trim() || !provider.model.trim() || !provider.apiKey.trim()) return
    const requestId = crypto.randomUUID()
    coachRequestId.current = requestId
    setCoachExplanation('')
    try {
      const explanation = await requestChatCompletion(provider, [
        { role: 'system', content: 'You are a concise chess coach for permitted training positions. Explain the tactical or positional reason behind the engine move in 2-4 sentences. Be accurate, pedagogical, and avoid claiming certainty beyond the supplied line.' },
        { role: 'user', content: `Position FEN: ${positionAnalysis.fen}\nStockfish candidate: ${positionAnalysis.bestMoveSan ?? positionAnalysis.bestMove}\nPrincipal variation: ${positionAnalysis.principalVariation.join(' ')}\nEvaluation: ${formatEvaluation(positionAnalysis.evaluationCp, positionAnalysis.evaluationMate)} from White's perspective. Explain the move.` },
      ])
      if (coachRequestId.current === requestId) setCoachExplanation(explanation.trim())
    } catch (error) {
      if (coachRequestId.current === requestId) setCoachExplanation(`Coach provider error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const synchronizeDetectedPosition = (detected: DetectedPosition) => {
    if (!detected.reliable || !detected.plausible) return
    const orientation = resolveOrientation(detected.placement)
    const placement = orientation.placement
    setBoardOrientation(orientation.orientation)
    const previous = stableDetectedPlacementRef.current
    const stable = previous?.placement === placement ? { placement, count: previous.count + 1 } : { placement, count: 1 }
    stableDetectedPlacementRef.current = stable
    if (stable.count < 2) return

    try {
      const currentFen = currentFenRef.current
      const observedFen = fenForObservedPlacement(placement, currentFen, detectedTurnRef.current)
      const sameBoard = new Chess(currentFen).fen().split(' ')[0] === placement
      const targetFen = sameBoard ? currentFen : observedFen
      setDetectedTurn(new Chess(targetFen).turn())
      if (sameBoard && lastAutoAnalyzedFenRef.current === targetFen) return

      lastAutoAnalyzedFenRef.current = targetFen
      currentFenRef.current = targetFen
      setFen(targetFen)
      setFenDraft(targetFen)
      setPriorPositions([])
      setMoveHistory([])
      setSelected(null)
      setAnalysis(null)
      setCoachExplanation('')
      setAnalysisState('idle')
      runAnalysisForFen(targetFen)
    } catch {
      // Ignore a transient or structurally invalid recognition result; the next frame can recover.
    }
  }

  const handleCaptureEnded = (stream: MediaStream, reason: string) => {
    if (captureStreamRef.current !== stream) return
    captureStreamRef.current = null
    captureMutedRef.current = false
    setCaptureMuted(false)
    setCaptureStream(null)
    setCaptureState('error')
    setSessionPaused(false)
    setDetectedBoard(null)
    setCaptureError(`Screen sharing ended: ${reason}. Start sharing again to reconnect.`)
  }

  const startCapture = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setCaptureState('error')
      setCaptureError('Screen sharing is not supported in this browser. You can still analyze a FEN position.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const videoTrack = stream.getVideoTracks()[0]
      captureStreamRef.current = stream
      captureMutedRef.current = false
      setCaptureMuted(false)
      setDetectedBoard(null)
      setDetectedTurn('w')
      setLastScanAt(null)
      videoTrack?.addEventListener('ended', () => handleCaptureEnded(stream, 'the browser or selected screen stopped the capture'))
      videoTrack?.addEventListener('mute', () => {
        if (captureStreamRef.current !== stream) return
        captureMutedRef.current = true
        setCaptureMuted(true)
      })
      videoTrack?.addEventListener('unmute', () => {
        if (captureStreamRef.current !== stream) return
        captureMutedRef.current = false
        setCaptureMuted(false)
      })
      stream.addEventListener('inactive', () => handleCaptureEnded(stream, 'all capture tracks became inactive'))
      setCaptureStream(stream)
      setCaptureState('active')
      setCaptureError('')
      setSessionPaused(false)
    } catch (error) {
      setCaptureState('error')
      setCaptureError(error instanceof Error && error.name === 'NotAllowedError'
        ? 'Screen sharing was cancelled. Your screen was not captured.'
        : 'Could not start screen sharing. Check browser permissions and try again.')
    }
  }

  const requestCapture = async () => {
    if (!trainingConfirmed) {
      setShowFairPlay(true)
      return
    }
    await startCapture()
  }

  const stopCapture = () => {
    const activeStream = captureStreamRef.current
    captureStreamRef.current = null
    captureMutedRef.current = false
    activeStream?.getTracks().forEach((track) => track.stop())
    setCaptureMuted(false)
    setCaptureStream(null)
    setCaptureState('off')
    setCaptureError('')
    setSessionPaused(false)
    setDetectedBoard(null)
  }

  const beginSession = async () => {
    setTrainingConfirmed(true)
    setShowFairPlay(false)
    await startCapture()
  }

  const applyDetectedPosition = () => {
    if (!detectedBoard?.reliable || !detectedBoard.plausible) return
    const { placement } = resolveOrientation(detectedBoard.placement)
    const detectedFen = placementToFen(placement, detectedTurn)
    try {
      const game = new Chess(detectedFen)
      invalidateAnalysis()
      setPriorPositions([])
      setMoveHistory([])
      setFen(game.fen())
      setFenDraft(game.fen())
      setSelected(null)
      setAnalysis(null)
      setAnalysisState('idle')
      setScanState('idle')
    } catch {
      setScanState('unreliable')
    }
  }

  const normalizedPointerPosition = (event: React.PointerEvent<HTMLDivElement>) => {
    const video = previewRef.current
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!video?.videoWidth || !video.videoHeight) return { x: 0, y: 0 }
    const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight)
    const shownWidth = video.videoWidth * scale
    const shownHeight = video.videoHeight * scale
    const left = bounds.left + (bounds.width - shownWidth) / 2
    const top = bounds.top + (bounds.height - shownHeight) / 2
    return {
      x: Math.max(0, Math.min(1, (event.clientX - left) / shownWidth)),
      y: Math.max(0, Math.min(1, (event.clientY - top) / shownHeight)),
    }
  }

  const startRegionSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!selectingRegion) return
    const point = normalizedPointerPosition(event)
    selectionAnchorRef.current = point
    setCropRect({ x: point.x, y: point.y, w: 0, h: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveRegionSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    const anchor = selectionAnchorRef.current
    if (!anchor) return
    const point = normalizedPointerPosition(event)
    setCropRect({ x: Math.min(anchor.x, point.x), y: Math.min(anchor.y, point.y), w: Math.abs(point.x - anchor.x), h: Math.abs(point.y - anchor.y) })
  }

  const finishRegionSelection = () => {
    if (!selectionAnchorRef.current) return
    selectionAnchorRef.current = null
    setSelectingRegion(false)
    setScanNonce((nonce) => nonce + 1)
  }

  const cropOverlayStyle = () => {
    const video = previewRef.current
    const frame = video?.getBoundingClientRect()
    const crop = cropRect
    if (!video?.videoWidth || !video.videoHeight || !frame || !crop) return undefined
    const scale = Math.min(frame.width / video.videoWidth, frame.height / video.videoHeight)
    const left = (frame.width - video.videoWidth * scale) / 2
    const top = (frame.height - video.videoHeight * scale) / 2
    return {
      left: `${((left + crop.x * video.videoWidth * scale) / frame.width) * 100}%`,
      top: `${((top + crop.y * video.videoHeight * scale) / frame.height) * 100}%`,
      width: `${(crop.w * video.videoWidth * scale / frame.width) * 100}%`,
      height: `${(crop.h * video.videoHeight * scale / frame.height) * 100}%`,
    }
  }

  const openFloatingCoach = async () => {
    if (!window.documentPictureInPicture) {
      setFloatingError('Floating coach requires a browser with Document Picture-in-Picture support, such as current Chrome or Edge.')
      return
    }
    try {
      const popup = await window.documentPictureInPicture.requestWindow({ width: 390, height: 820 })
      document.querySelectorAll('style, link[rel="stylesheet"]').forEach((sheet) => {
        popup.document.head.appendChild(sheet.cloneNode(true))
      })
      popup.document.body.className = 'pip-document-body'
      setFloatingError('')
      setFloatingWindow(popup)
    } catch {
      setFloatingError('The floating window could not open. Check browser support and popup settings.')
    }
  }

  const turnText = isWhiteToMove ? 'White to move' : 'Black to move'
  const moveSquares = recommendation?.move ? [recommendation.move.slice(0, 2), recommendation.move.slice(2, 4)] : analysis?.bestMove ? [analysis.bestMove.slice(0, 2), analysis.bestMove.slice(2, 4)] : []

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Crown size={20} strokeWidth={2.2} /></div>
          <div><div className="brand-name">ChessPilot</div><div className="brand-subtitle">TRAINING STUDIO</div></div>
        </div>

        <div className="workspace-switcher">
          <div className="workspace-avatar">S</div>
          <div className="workspace-copy"><b>My workspace</b><span>Personal</span></div>
          <ChevronDown size={15} />
        </div>

        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <button className={activeNav === 'workspace' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveNav('workspace')}><LayoutDashboard size={17} /> <span>Overview</span></button>
          <button className={activeNav === 'position' ? 'nav-item active' : 'nav-item'} onClick={() => { setActiveNav('position'); document.getElementById('position-lab')?.scrollIntoView({ behavior: 'smooth' }) }}><Target size={17} /> <span>Position lab</span></button>
          <button className={activeNav === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => { setActiveNav('history'); setShowHistory(true) }}><History size={17} /> <span>Analysis history</span><span className="nav-count">{recentAnalysis.length}</span></button>
        </nav>

        <div className="nav-label nav-label-spaced">PREFERENCES</div>
        <nav className="side-nav" aria-label="Preferences">
          <button className={activeNav === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveNav('settings')}><Settings2 size={17} /> <span>Privacy & settings</span></button>
          <button className="nav-item" onClick={() => setShowFairPlay(true)}><CircleHelp size={17} /> <span>Training guidelines</span></button>
        </nav>

        <div className="sidebar-spacer" />
        <div className="privacy-card"><div className="privacy-icon"><LockKeyhole size={15} /></div><div><b>Private by design</b><p>Positions stay on this device. Screen sharing is optional.</p></div></div>
        <button className="profile-row" onClick={() => setActiveNav('settings')}>
          <div className="profile-avatar">S</div><div className="profile-copy"><b>Santhosh</b><span>Free plan</span></div><MoreHorizontal size={18} />
        </button>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><b>{activeNav === 'settings' ? 'Privacy & settings' : activeNav === 'history' ? 'Analysis history' : 'Overview'}</b></div>
          <div className="topbar-right">
            <span className={`offline-pill ${isOnline ? offlineReady ? '' : 'preparing' : 'offline'}`} title={isOnline ? offlineReady ? 'The app shell, engine, board model, and files you have opened are cached for offline use.' : 'Offline support is being prepared. Visit once while online to cache the app.' : 'You are offline. AI provider requests require an internet connection.'}><span className="status-dot" />{isOnline ? offlineReady ? 'OFFLINE READY' : 'PREPARING OFFLINE' : 'OFFLINE MODE'}</span>
            <span className="engine-pill"><span className={workerReady ? 'status-dot' : 'status-dot warming'} /> {workerReady ? 'Stockfish ready' : 'Stockfish loading'}</span>
            <button className="icon-button" aria-label="Settings" title="Settings" onClick={() => setActiveNav('settings')}><Settings2 size={17} /></button>
            <div className="top-avatar">S</div>
          </div>
        </header>

        {activeNav === 'settings' ? (
          <section className="settings-page content-wrap">
            <div className="page-heading"><div><div className="eyebrow">YOUR CONTROLS</div><h1>Privacy & settings</h1><p>Choose what ChessPilot can access and how your analysis works.</p></div><ShieldCheck size={28} className="heading-icon" /></div>
    <div className="settings-grid">
              <div className="settings-card"><div className="settings-card-head"><Activity size={18} /><h2>Offline workspace</h2></div><p>Install ChessPilot from your browser’s app menu. Open once while online so the engine, recognition model, and app assets are cached. AI provider requests still need a connection.</p><div className="settings-row"><span>Connection</span><span className="setting-value">{isOnline ? 'Online' : 'Offline'}</span></div><div className="settings-row"><span>Offline app shell</span><span className="setting-value">{offlineReady ? 'Ready' : 'Preparing'}</span></div></div>
              <div className="settings-card"><div className="settings-card-head"><Monitor size={18} /><h2>Screen sharing</h2></div><p>Screen frames and board recognition run in this browser. ChessPilot does not upload them.</p><div className="settings-row"><span>Capture status</span><span className="setting-value">{captureState === 'active' ? (captureMuted ? 'Source paused' : 'Sharing') : captureState === 'error' ? 'Stopped by source' : 'Stopped'}</span></div><div className="settings-row"><span>Board recognition</span><span className="setting-value">Local CNN model</span></div></div>
              <div className="settings-card"><div className="settings-card-head"><Cpu size={18} /><h2>Local analysis</h2></div><p>Stockfish Lite runs in a single-threaded WebAssembly worker. Positions and engine results stay in this browser session.</p><div className="settings-row"><span>Search budget</span><span className="setting-value">900 ms per position</span></div><div className="settings-row"><span>Engine status</span><span className="setting-value">{workerReady ? 'Ready' : 'Loading'}</span></div></div>
              <div className="settings-card provider-card"><div className="settings-card-head"><Eye size={18} /><h2>Vision model fallback</h2></div><p>Used only when local board recognition misses or returns an uncertain position. A shared frame is sent to this provider when fallback runs. Enter a Top Billing API key and image-capable model ID. <a href="https://topbilling.in/models" target="_blank" rel="noreferrer">Browse models</a> · <a href="https://topbilling.in/docs" target="_blank" rel="noreferrer">API docs</a>.</p><label>OpenAI-compatible endpoint<input value={visionSettings.endpoint} onChange={(event) => { setVisionSettings({ ...visionSettings, endpoint: event.target.value }); setVisionSaved(false) }} placeholder="https://api.topbilling.in/v1/chat/completions" /></label><label>Vision model<input value={visionSettings.model} onChange={(event) => { setVisionSettings({ ...visionSettings, model: event.target.value }); setVisionSaved(false) }} placeholder="Top Billing model ID" /></label><label>API key<input type="password" autoComplete="new-password" value={visionSettings.apiKey} onChange={(event) => { setVisionSettings({ ...visionSettings, apiKey: event.target.value }); setVisionSaved(false) }} placeholder="Top Billing API key" /></label><div className="provider-save-row"><button className="secondary-button" onClick={() => void saveProviderSettings('vision', visionSettings)}>Save vision settings</button><span>{visionSaved ? 'Encrypted and saved' : 'Unsaved changes'}</span></div></div>
              <div className="settings-card provider-card"><div className="settings-card-head"><Sparkles size={18} /><h2>AI coach provider</h2></div><p>Explains Stockfish recommendations and suggests a legal candidate if Stockfish fails. Enter a Top Billing API key and model ID. FEN, legal moves, and engine lines are sent when needed. <a href="https://topbilling.in/models" target="_blank" rel="noreferrer">Browse models</a> · <a href="https://topbilling.in/docs" target="_blank" rel="noreferrer">API docs</a>.</p><label>OpenAI-compatible endpoint<input value={coachSettings.endpoint} onChange={(event) => { setCoachSettings({ ...coachSettings, endpoint: event.target.value }); setCoachSaved(false) }} placeholder="https://api.topbilling.in/v1/chat/completions" /></label><label>Coach model<input value={coachSettings.model} onChange={(event) => { setCoachSettings({ ...coachSettings, model: event.target.value }); setCoachSaved(false) }} placeholder="Top Billing model ID" /></label><label>API key<input type="password" autoComplete="new-password" value={coachSettings.apiKey} onChange={(event) => { setCoachSettings({ ...coachSettings, apiKey: event.target.value }); setCoachSaved(false) }} placeholder="Top Billing API key" /></label><div className="provider-save-row"><button className="secondary-button" onClick={() => void saveProviderSettings('coach', coachSettings)}>Save coach settings</button><span>{coachSaved ? 'Encrypted and saved' : 'Unsaved changes'}</span></div></div>
              <div className="settings-card"><div className="settings-card-head"><ShieldCheck size={18} /><h2>Fair play</h2></div><p>Use live screen sharing only for puzzles, bots, and analysis environments that explicitly permit assistance. Never use it in prohibited games against people.</p><button className="secondary-button" onClick={() => setShowFairPlay(true)}>Review training notice <ArrowRight size={15} /></button></div>
            </div>
            {providerSettingsError && <p className="provider-settings-error" role="alert">{providerSettingsError}</p>}
            <p className="vault-note"><LockKeyhole size={13} /> Keys are AES-GCM encrypted in this browser profile and sent from your browser to the endpoint you configure when a provider runs. Same-origin app code can access the active key; do not use a production key on a shared or untrusted device. A public multi-user deployment should use a server-side proxy.</p>
          </section>
        ) : (
          <div className="content-wrap">
            <section className="welcome-row">
              <div>
                <div className="eyebrow welcome-eyebrow"><span className="eyebrow-line" /> YOUR PERSONAL CHESS COACH</div>
                <h1>See the move.<br /><span>Understand the idea.</span></h1>
                <p>Explore positions with a local chess search and learn what to look for next.</p>
              </div>
              <div className="welcome-actions">
                {captureState === 'active' ? <button className="share-button sharing" onClick={stopCapture}><SquareIcon size={16} fill="currentColor" /> Stop sharing</button> : <button className="share-button" onClick={() => void requestCapture()}><Monitor size={17} /> Share training board <ArrowUpRight size={15} /></button>}
                <button className="text-action" onClick={() => { setFenOpen((open) => !open); setActiveNav('position'); document.getElementById('position-lab')?.scrollIntoView({ behavior: 'smooth' }) }}><FileUp size={16} /> Enter a FEN</button>
              </div>
            </section>

            <section className={`position-edge-card edge-${edgeSide}`} aria-live="polite" aria-label={`Position evaluation: ${edgeTitle}`}>
              <div className="edge-icon"><Gauge size={17} /></div>
              <div className="edge-copy"><div className="section-kicker">WHO’S AHEAD?</div><strong>{edgeTitle}</strong><span>{analysis?.depth ? analysis.evaluationMate !== null ? `Forced mate indication · ${analysis.positionStatus}` : 'Stockfish evaluation from White’s perspective' : edgeSide === 'ai' ? 'AI fallback provides a legal candidate, but no engine score.' : analysisState === 'running' ? 'Waiting for Stockfish to evaluate the position.' : 'Analyze a position to see whether White or Black has the advantage.'}</span></div>
              <div className="edge-meter-wrap"><div className="edge-meter-labels"><span>White</span><span>Black</span></div><div className="edge-meter" aria-hidden="true"><span style={{ left: edgeMarker }} /></div></div>
              <div className="edge-value">{edgeValue}</div>
            </section>

            <div className="fairplay-strip"><ShieldCheck size={16} /><span>Training mode only</span><span className="strip-divider" /><span>Confirm the environment permits assistance before sharing your screen.</span><button onClick={() => setShowFairPlay(true)}>Learn more <ArrowRight size={13} /></button></div>

            {(captureError || floatingError) && <div className="error-banner" role="alert"><CircleHelp size={16} /><span>{captureError || floatingError}</span><button aria-label="Dismiss" onClick={() => { setCaptureError(''); setFloatingError('') }}><X size={16} /></button></div>}

            {captureState === 'active' && <section className="capture-preview-card"><div className="capture-preview-head"><div className="capture-preview-title"><span className="live-dot" /> {captureMuted ? 'Screen source temporarily paused' : 'Screen sharing active'}</div><div className="preview-controls"><label className="playing-as-control">Who should win?<select aria-label="Choose which side the move suggestions should favor" value={winningSide} onChange={(event) => setWinningSide(event.target.value as 'w' | 'b')}><option value="w">White</option><option value="b">Black</option></select></label><span>Frames stay local unless AI vision fallback is configured</span><button className="scan-region-button" onClick={() => { setCropRect(null); setSelectingRegion(true) }}>{selectingRegion ? 'Drag to mark board' : 'Select board region'}</button>{cropRect && <button className="scan-region-button" onClick={() => { setCropRect(null); setScanNonce((nonce) => nonce + 1) }}>Scan full screen</button>}<button className="icon-button small" aria-label={sessionPaused ? 'Resume preview' : 'Pause preview'} onClick={() => setSessionPaused((paused) => !paused)}>{sessionPaused ? <Play size={14} /> : <Pause size={14} />}</button><button className="icon-button small" aria-label="Stop sharing" onClick={stopCapture}><SquareIcon size={13} /></button></div></div><div className={`video-frame ${selectingRegion ? 'selecting-region' : ''}`} onPointerDown={startRegionSelection} onPointerMove={moveRegionSelection} onPointerUp={finishRegionSelection} onPointerCancel={finishRegionSelection}><video ref={previewRef} autoPlay muted playsInline />{(sessionPaused || captureMuted) && <div className="paused-overlay"><Pause size={18} /> {sessionPaused ? 'Preview paused (sharing continues)' : 'Shared source temporarily paused'}</div>}{cropRect && <div className="board-crop-outline" style={cropOverlayStyle()} />}{selectingRegion && <div className="scan-region-prompt">Drag around the chessboard</div>}</div><div className={`recognition-notice ${scanState === 'error' ? 'recognition-error' : ''}`}><Eye size={14} /><span>{scanState === 'loading' ? 'Loading the local piece recognition model…' : scanState === 'scanning' ? 'Scanning the shared screen for a chessboard…' : scanState === 'ai-scanning' ? 'Local scan missed; asking the configured vision model…' : scanState === 'ai-ready' ? 'AI vision read the board · syncing and analyzing automatically. Review the position.' : scanState === 'ready' ? `Chessboard detected · colors and orientation matched · position syncs automatically${lastScanAt ? ` · scanned ${lastScanAt.toLocaleTimeString()}` : ''}` : scanState === 'unreliable' ? 'A board-like region was found, but the piece read is uncertain. Adjust the shared view so the full 2D board is visible.' : scanState === 'not-found' ? 'No chessboard found in this frame. Select the board region to scan a tighter crop.' : scanState === 'error' ? `Recognition failed: ${scanError || 'unknown runtime error'}. Reload the app and try again.` : 'Waiting for the first screen scan…'}</span></div>{detectedBoard && <div className="detected-position-panel"><div><b>{detectedBoard.reliable && detectedBoard.plausible ? 'Position detected · syncing automatically' : 'Position needs a clearer scan'}</b><span>{detectedBoard.source === 'ai' ? 'AI vision result · review the board carefully' : `Board confidence ${Math.round((detectedBoard.meanConfidence ?? 0) * 100)}% · lowest square ${Math.round((detectedBoard.minConfidence ?? 0) * 100)}%`}</span></div><label>Side to move<select value={detectedTurn} onChange={(event) => setDetectedTurn(event.target.value as 'w' | 'b')}><option value="w">White</option><option value="b">Black</option></select></label><button className="small-primary" disabled={!detectedBoard.reliable || !detectedBoard.plausible} onClick={applyDetectedPosition}>Load now (optional)</button></div>}</section>}

            <section className="workspace-grid" id="position-lab">
              <div className="board-card panel-card">
                <div className="panel-heading">
                  <div><div className="section-kicker">POSITION LAB</div><h2>Current position</h2></div>
                  <button className="icon-button" aria-label="Position options" title="Position options" onClick={() => setFenOpen((open) => !open)}><MoreHorizontal size={19} /></button>
                </div>
                <div className="board-toolbar"><div className="turn-indicator"><span className={isWhiteToMove ? 'turn-piece white-piece' : 'turn-piece black-piece'}>{isWhiteToMove ? '♙' : '♟'}</span><span>{isGameOver ? 'Game over' : turnText}</span></div>{captureState !== 'active' && <label className="playing-as-control">Who should win?<select aria-label="Choose which side the move suggestions should favor" value={winningSide} onChange={(event) => setWinningSide(event.target.value as 'w' | 'b')}><option value="w">White</option><option value="b">Black</option></select></label>}<span className="verified-label"><Check size={13} /> Legal position</span></div>
                <div className="board-wrap">
                  <div className="board-ranks" aria-hidden="true">{displayIndices.map((rowIndex) => <span key={rowIndex}>{8 - rowIndex}</span>)}</div>
                  <div className="chessboard" style={boardColorStyle} role="grid" aria-label="Interactive chessboard">
                    {displayIndices.flatMap((rowIndex) => displayIndices.map((colIndex) => {
                      const piece = board[rowIndex][colIndex]
                      const square = `${files[colIndex]}${8 - rowIndex}` as Square
                      const isLight = (rowIndex + colIndex) % 2 === 0
                      const isSelected = selected === square
                      const isLastMove = analysis?.bestMove ? moveSquares.includes(square) : false
                      const isLegalTarget = legalTargets.has(square)
                      return <button key={square} role="gridcell" aria-label={`${square}${piece ? ` ${piece.color === 'w' ? 'white' : 'black'} ${piece.type}` : ''}${isLegalTarget ? ', legal target' : ''}`} className={`board-square ${isLight ? 'light-square' : 'dark-square'}${isSelected ? ' selected-square' : ''}${isLastMove ? ' engine-square' : ''}`} onClick={() => handleSquareClick(square)}>
                        {piece && <span className={`piece ${piece.color === 'w' ? 'piece-white' : 'piece-black'}`}>{PIECES[`${piece.color}${piece.type}`]}</span>}
                        {isLegalTarget && <span className={piece ? 'legal-capture' : 'legal-dot'} />}
                        {colIndex === displayIndices[0] && <span className={`coordinate rank-coordinate ${isLight ? 'coord-light' : 'coord-dark'}`}>{8 - rowIndex}</span>}
                        {rowIndex === displayIndices[7] && <span className={`coordinate file-coordinate ${isLight ? 'coord-light' : 'coord-dark'}`}>{files[colIndex]}</span>}
                      </button>
                    }))}
                  </div>
                </div>
                <div className="board-footer"><span>Tap a piece, then its destination square</span><div className="board-controls"><button className="tool-button" title="Undo last move" aria-label="Undo last move" disabled={!priorPositions.length} onClick={undoMove}><RotateCcw size={15} /></button><button className="tool-button" title="Load starting position" aria-label="Load starting position" onClick={() => { invalidateAnalysis(); setPriorPositions([]); setMoveHistory([]); setFen(INITIAL_FEN); setFenDraft(INITIAL_FEN); setAnalysis(null); setAnalysisState('idle'); setSelected(null) }}><Expand size={15} /></button><button className="tool-button" title="Show move history" aria-label="Show move history" onClick={() => setShowHistory((show) => !show)}><BookOpen size={15} /></button></div></div>

                {fenOpen && <div className="fen-editor"><div className="fen-editor-head"><div><b>Load a position</b><span>Paste a complete FEN string</span></div><button className="icon-button small" aria-label="Close FEN editor" onClick={() => setFenOpen(false)}><X size={15} /></button></div><textarea aria-label="FEN position" value={fenDraft} onChange={(event) => { setFenDraft(event.target.value); setFenError('') }} rows={2} spellCheck={false} /><div className="fen-editor-footer">FEN is validated locally before it is loaded.<button className="small-primary" onClick={loadFen}>Load position</button></div>{fenError && <p className="inline-error">{fenError}</p>}</div>}
                {showHistory && <div className="move-history"><div className="history-head"><b>Move history</b><button className="icon-button small" aria-label="Close move history" onClick={() => setShowHistory(false)}><X size={14} /></button></div>{moveHistory.length ? <div className="move-list">{moveHistory.map((move, index) => <span key={`${index}-${move}`}><i>{Math.floor(index / 2) + 1}{index % 2 ? '…' : '.'}</i>{move}</span>)}</div> : <p>No moves in this position yet. Make a move on the board to start a line.</p>}</div>}
              </div>

              <aside className="coach-column">
                <div className="coach-card panel-card">
                  <div className="coach-heading"><div className="coach-icon"><Sparkles size={17} /></div><div><div className="section-kicker">CHESSPILOT COACH</div><h2>What’s the idea?</h2></div><button className="icon-button float-button" aria-label="Open floating coach" title="Open always-on-top coach" onClick={() => void openFloatingCoach()}><PictureInPicture2 size={16} /></button><span className="local-badge"><span className="status-dot" />LOCAL</span></div>

                  {(analysisState === 'ready' || analysisState === 'running' || analysisState === 'error') && analysis ? (
                    <>
                    <div className="analysis-result" aria-live="polite">
                      <div className="result-eyebrow"><Check size={13} /> {analysis.positionStatus}</div>
                      {suggestedMove ? <><div className="recommended-move"><div><span>{isBlunderCandidate ? `Blunder candidate · favors ${winningSide === 'w' ? 'White' : 'Black'}` : `Best move to favor ${winningSide === 'w' ? 'White' : 'Black'}`}</span><strong>{suggestedMove.san}</strong></div><div className="move-arrow">{suggestedMove.move.slice(0, 2)} <ArrowRight size={15} /> {suggestedMove.move.slice(2, 4)}</div></div><div className="result-explanation"><div className="explanation-mark"><Sparkles size={14} /></div><p>{isBlunderCandidate ? `This is the weakest move among the engine lines shown, selected to help ${winningSide === 'w' ? 'White' : 'Black'} gain an advantage. It may not be a forced blunder; review the evaluation after the move.` : recommendation ? localExplanation(analysis) : coachExplanation || localExplanation(analysis)}</p></div><div className="pv-row"><span>{recommendation && isBlunderCandidate ? 'Selected move' : 'Line searched'}</span><b>{recommendation && isBlunderCandidate ? suggestedMove.san : analysis?.principalVariation.join('  ') || '—'}</b></div></> : <div className="terminal-position"><Crown size={19} /><b>{analysis?.positionStatus ?? 'Waiting for analysis'}</b><span>No legal move is available.</span></div>}
                      {analysis.alternatives.length > 0 && <div className="alternatives-row"><span>Other candidates</span><b>{analysis.alternatives.join('  ·  ')}</b></div>}
                      {analysis.depth > 0 ? <div className="analysis-meta"><span><Gauge size={13} /> {formatEvaluation(analysis.evaluationCp, analysis.evaluationMate)} <small>White</small></span><span><Activity size={13} /> Depth {analysis.depth}</span><span><Clock3 size={13} /> {analysis.elapsedMs} ms</span></div> : <div className="analysis-meta"><span><Sparkles size={13} /> AI candidate · legal move checked</span></div>}
                    </div>
                    {analysisState === 'error' && <p className="inline-error">{analysisError}</p>}
                    </>
                  ) : analysisState === 'running' ? (
                    <div className="analysis-loading"><div className="loader-orbit"><div /></div><b>Looking for candidate moves</b><span>Searching this position locally…</span></div>
                  ) : analysisState === 'error' ? (
                    <div className="coach-empty error-coach"><div className="empty-icon"><CircleHelp size={18} /></div><b>Analysis needs attention</b><p>{analysisError}</p><button className="text-action compact" onClick={analyze}>Try again <ArrowRight size={14} /></button></div>
                  ) : (
                    <div className="coach-empty"><div className="empty-icon"><Target size={18} /></div><b>Ready when you are</b><p>Analyze this legal position to find a candidate move and explore the line.</p><div className="hint-line"><span className="hint-dot" /> Your position is checked with chess rules first.</div></div>
                  )}

                  <button className="analyze-button" disabled={analysisState === 'running' || (!workerReady && !workerFailed)} onClick={analyze}>{analysisState === 'running' ? <><span className="button-spinner" /> Analyzing position</> : <><Sparkles size={16} /> {analysisState === 'ready' ? 'Analyze again' : workerReady ? 'Analyze position' : workerFailed ? 'Use AI fallback' : 'Loading Stockfish'} <ArrowRight size={15} /></>}</button>
                  <div className="coach-disclosure"><LockKeyhole size={12} /> Analysis runs locally in your browser</div>
                </div>

                <div className="pipeline-card panel-card"><div className="pipeline-head"><div><div className="section-kicker">ANALYSIS PIPELINE</div><h3>Position to insight</h3></div><button className="icon-button small" title="About this pipeline" aria-label="About this pipeline" onClick={() => setActiveNav('settings')}><CircleHelp size={15} /></button></div><div className="pipeline-flow"><div className="pipeline-step complete"><span className="pipeline-glyph"><Check size={13} /></span><div><b>Board position</b><small>Local move validation</small></div><span className="pipeline-state">READY</span></div><div className="pipeline-connector" /><div className={analysisState === 'ready' ? 'pipeline-step complete' : analysisState === 'running' ? 'pipeline-step processing' : 'pipeline-step'}><span className="pipeline-glyph"><Cpu size={13} /></span><div><b>Stockfish search</b><small>Local WASM engine · 900 ms</small></div><span className="pipeline-state">{analysisState === 'ready' ? 'DONE' : analysisState === 'running' ? 'RUNNING' : 'LOCAL'}</span></div><div className="pipeline-connector" /><div className={coachSettings.model && coachSettings.apiKey ? 'pipeline-step complete' : 'pipeline-step unavailable'}><span className="pipeline-glyph"><Sparkles size={13} /></span><div><b>Coach explanation</b><small>{coachSettings.model && coachSettings.apiKey ? 'Configured AI provider' : 'Provider not configured'}</small></div><span className="pipeline-state">{coachSettings.model && coachSettings.apiKey ? 'AI' : 'OPTIONAL'}</span></div></div></div>
              </aside>
            </section>

            <section className="bottom-grid">
              <div className="info-card"><div className="info-icon turquoise"><Monitor size={16} /></div><div><b>{captureState === 'active' ? 'Screen is being shared' : 'Bring in a training board'}</b><p>{captureState === 'active' ? 'The preview is live; stable board changes automatically update the position and start analysis.' : 'Share a permitted puzzle or analysis board. Capture begins only when you choose a source.'}</p></div><ChevronRight size={16} className="info-arrow" /></div>
              <div className="info-card"><div className="info-icon violet"><Cpu size={16} /></div><div><b>Stockfish runs locally</b><p>Engine search stays in this browser. Vision and coach providers can be configured separately in Settings.</p></div><ChevronRight size={16} className="info-arrow" /></div>
              <div className="info-card"><div className="info-icon amber"><ShieldCheck size={16} /></div><div><b>Play fair, keep learning</b><p>Live assistance is for explicitly permitted training environments only.</p></div><ChevronRight size={16} className="info-arrow" /></div>
            </section>
            <footer className="page-footer"><span>ChessPilot web · Early access</span><span><span className="footer-status" /> Your session is local</span><button onClick={() => setShowFairPlay(true)}>Fair-play policy</button></footer>
          </div>
        )}
      </main>

      {showFairPlay && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowFairPlay(false) }}><section className="fairplay-modal" role="dialog" aria-modal="true" aria-labelledby="fairplay-title"><button className="modal-close icon-button" aria-label="Close" onClick={() => setShowFairPlay(false)}><X size={18} /></button><div className="modal-shield"><ShieldCheck size={24} /></div><div className="eyebrow">BE A GOOD SPORT</div><h2 id="fairplay-title">Training mode, with fair play.</h2><p>ChessPilot is for puzzles, bots, and analysis boards where assistance is allowed. It must not be used to gain an advantage in competitive games against people when the platform prohibits outside help.</p><div className="fairplay-points"><div><Check size={14} /> No moves are played automatically.</div><div><Check size={14} /> Screen sharing starts only after you choose a source.</div><div><Check size={14} /> Screen frames stay in this browser tab.</div><div><Check size={14} /> Detected positions are reviewed before loading.</div></div><label className="confirmation-check"><input type="checkbox" checked={trainingConfirmed} onChange={(event) => setTrainingConfirmed(event.target.checked)} /><span>I confirm this is a permitted training, puzzle, or analysis environment.</span></label><div className="modal-actions"><button className="text-action" onClick={() => setShowFairPlay(false)}>Cancel</button><button className="share-button" disabled={!trainingConfirmed} onClick={() => void beginSession()}><Monitor size={16} /> Continue to screen selection <ArrowRight size={15} /></button></div></section></div>}

      {floatingWindow && createPortal(<div className="pip-coach"><div className="pip-header"><div className="pip-brand"><span className="pip-brand-icon"><Crown size={16} /></span><div><b>ChessPilot</b><small><span className="status-dot" /> {captureState === 'active' ? 'Tracking shared board · auto-updates' : analysis ? 'Position analyzed' : 'Ready for analysis'}</small></div></div><button className="icon-button small" title="Close floating coach" aria-label="Close floating coach" onClick={() => floatingWindow.close()}><X size={15} /></button></div><div className="pip-board-area"><div className="pip-board-label"><span>LIVE POSITION · VIEW FROM {boardOrientation === 'white' ? 'WHITE' : 'BLACK'}</span><span>{turnText}</span></div><div className="pip-chessboard" style={boardColorStyle} role="grid" aria-label="Floating interactive chessboard">{displayIndices.flatMap((rowIndex) => displayIndices.map((colIndex) => {
        const piece = board[rowIndex][colIndex]
        const square = `${files[colIndex]}${8 - rowIndex}` as Square
        const isLight = (rowIndex + colIndex) % 2 === 0
        const isSelected = selected === square
        const isLegalTarget = legalTargets.has(square)
        const isLastMove = analysis?.bestMove ? moveSquares.includes(square) : false
        return <button key={square} role="gridcell" aria-label={`${square}${piece ? ` ${piece.color === 'w' ? 'white' : 'black'} ${piece.type}` : ''}`} className={`board-square ${isLight ? 'light-square' : 'dark-square'}${isSelected ? ' selected-square' : ''}${isLastMove ? ' engine-square' : ''}`} onClick={() => handleSquareClick(square)}>{piece && <span className={`piece ${piece.color === 'w' ? 'piece-white' : 'piece-black'}`}>{PIECES[`${piece.color}${piece.type}`]}</span>}{isLegalTarget && <span className={piece ? 'legal-capture' : 'legal-dot'} />}{colIndex === displayIndices[0] && <span className={`coordinate rank-coordinate ${isLight ? 'coord-light' : 'coord-dark'}`}>{8 - rowIndex}</span>}{rowIndex === displayIndices[7] && <span className={`coordinate file-coordinate ${isLight ? 'coord-light' : 'coord-dark'}`}>{files[colIndex]}</span>}</button>
      }))}</div><div className="pip-board-hint">Tap a piece, then its destination to update the position.</div><div className="pip-position-tools"><label htmlFor="pip-fen">Load a position (FEN)</label><textarea id="pip-fen" aria-label="Floating position FEN" value={fenDraft} onChange={(event) => { setFenDraft(event.target.value); setFenError('') }} rows={2} spellCheck={false} /><div className="pip-action-row"><button className="pip-load-button" onClick={loadFen}>Load position</button><button className="pip-analyze-button" onClick={analyze} disabled={analysisState === 'running' || (!workerReady && !workerFailed)}><Sparkles size={13} />{analysisState === 'running' ? 'Analyzing…' : 'Analyze position'}</button></div>{fenError && <div className="pip-fen-error" role="alert">{fenError}</div>}</div></div><div className="pip-body">{analysis?.bestMoveSan ? <><div className="pip-kicker">{isBlunderCandidate ? 'BLUNDER CANDIDATE' : analysis.depth > 0 ? 'BEST MOVE FOR TARGET' : 'AI SUGGESTION'}</div><div className="pip-move">{suggestedMove?.san ?? analysis.bestMoveSan}<span>{analysis.depth > 0 ? formatEvaluation(suggestedMove?.evaluationCp ?? analysis.evaluationCp, suggestedMove?.evaluationMate ?? analysis.evaluationMate) : 'Fallback'}</span></div><p>{isBlunderCandidate ? `Weakest engine candidate shown, selected to favor ${winningSide === 'w' ? 'White' : 'Black'}.` : coachExplanation || localExplanation(analysis)}</p><div className="pip-line"><small>{isBlunderCandidate ? 'SELECTED MOVE' : 'PRINCIPAL VARIATION'}</small><b>{isBlunderCandidate ? suggestedMove?.san : analysis.principalVariation.join('  ')}</b></div><div className="pip-line pip-alts"><small>ALTERNATIVES</small><b>{analysis.alternatives.join('  ·  ') || '—'}</b></div></> : <div className="pip-wait"><Target size={21} /><b>No current recommendation</b><span>Load a position or move pieces above, then analyze here.</span></div>}</div><div className="pip-footer"><span><LockKeyhole size={12} /> Local analysis</span><button onClick={() => { if (captureState === 'active') setSessionPaused((paused) => !paused) }} disabled={captureState !== 'active'}>{sessionPaused ? <Play size={13} /> : <Pause size={13} />}{sessionPaused ? 'Resume preview' : 'Pause preview'}</button></div></div>, floatingWindow.document.body)}

      {showHistory && activeNav === 'history' && <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShowHistory(false); setActiveNav('workspace') } }}><section className="history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-title"><div className="drawer-head"><div><div className="eyebrow">YOUR WORKSPACE</div><h2 id="history-title">Analysis history</h2></div><button className="icon-button" aria-label="Close history" onClick={() => { setShowHistory(false); setActiveNav('workspace') }}><X size={18} /></button></div>{recentAnalysis.length ? recentAnalysis.map((item) => <button className="history-item" key={item.fen} onClick={() => { invalidateAnalysis(); setFen(item.fen); setFenDraft(item.fen); setAnalysis(item); setAnalysisState('ready'); setActiveNav('workspace'); setShowHistory(false) }}><div><span className="history-move">{item.bestMoveSan ?? 'Game over'}</span><small>{new Chess(item.fen).turn() === 'w' ? 'White to move' : 'Black to move'} · {item.depth} ply search</small></div><span className="history-eval">{formatEvaluation(item.evaluationCp, item.evaluationMate)}</span></button>) : <div className="history-empty"><History size={22} /><b>No analysis yet</b><p>When you analyze a position, it will appear here for this session.</p></div>}<div className="drawer-note"><LockKeyhole size={13} /> History is temporary and stored only in this tab.</div></section></div>}
    </div>
  )
}

function localExplanation(analysis: PositionAnalysis): string {
  if (!analysis.bestMoveSan) return 'This position has no legal moves. Review the FEN or start a new line.'
  const score = analysis.evaluationMate !== null ? `mate evaluation ${formatEvaluation(analysis.evaluationCp, analysis.evaluationMate)}` : `evaluation ${formatEvaluation(analysis.evaluationCp)} from White’s perspective`
  return `Stockfish ranks ${analysis.bestMoveSan} first in the displayed line (${score}). Treat it as a candidate to study and inspect the principal variation.`
}

export default App
