# ChessPilot Web

ChessPilot is a browser based chess analysis and training workspace. It combines a legal interactive board, local Stockfish analysis, and optional screen based position recognition in one dashboard.

## Features

- Analyze positions locally with the bundled Stockfish 19 Lite single threaded WebAssembly engine.
- Edit positions on the board, load FEN, undo moves, review the move list, and inspect engine lines.
- Share a permitted training or analysis screen. The local `fenshot` model looks for the board, reads its pieces, estimates its orientation, and syncs stable positions to the dashboard.
- Match the dashboard board colors to the detected board. Recognition and color sampling run in the browser.
- Choose whether move recommendations should favor White or Black. A move for the side to move is selected from the engine lines; when the other side is chosen, the weakest candidate shown is offered as a blunder candidate. It may not be a forced blunder.
- Configure optional OpenAI compatible vision and coaching providers in Settings. Vision fallback can send a shared frame to the selected provider; coaching can send a FEN and engine lines. Provider calls are off unless configured.
- Open a floating coach board in browsers that support Document Picture-in-Picture.

ChessPilot is intended for puzzles, bots, and analysis positions where assistance is allowed. Do not use it to gain an unfair advantage in a competitive game.

## Requirements

- Node.js 20 or newer and npm.
- A modern browser. Screen capture and Document Picture-in-Picture support vary by browser and operating system.

## Run locally

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. Screen capture works on `localhost` and on secure HTTPS origins. To build and preview a production bundle:

```sh
npm run build
npm run preview
```

The app serves the recognition model from `/models/` and the matching Stockfish JavaScript and WebAssembly files from `/engine/`. Keep each engine file pair together when deploying.

## Privacy

- Screen frames and local board recognition stay in the browser by default.
- If a vision provider is configured, frames can be sent to that endpoint when local recognition misses or is uncertain.
- If a coach provider is configured, position FENs and analysis lines can be sent to that endpoint for explanations or move fallback.
- Provider settings are encrypted with Web Crypto and stored in this browser profile's IndexedDB. This is local browser storage, not a server-side secrets vault; scripts running on the same origin can access the app's settings while the page is open.
- Screen sharing starts only after the user selects a source. Stop sharing ends the capture.

## Project structure

- `src/App.tsx` — dashboard, screen capture, recognition synchronization, settings, and floating coach.
- `src/analysis.ts` — UCI parsing, score perspective, and legal principal variation conversion.
- `public/models/` — browser chess piece recognition model.
- `public/engine/` — Stockfish worker, matching WASM binary, and its license.
- `.github/workflows/` — continuous integration and GitHub Pages deployment.

## Checks

```sh
npm test
npm run build
```

The tests cover UCI parsing, White perspective score conversion, and legal principal variation conversion. Browser screen capture, engine startup, and recognition quality depend on the deployment browser and the shared board image.

## Deployment

The `Deploy to GitHub Pages` workflow publishes the site from the `main` branch. It uses `npm run build:pages` to set the project site path. For another static host, run `npm run build` and serve `dist/` over HTTPS; the default build uses the root path.

See [LICENSE](./LICENSE) and [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) for license details.
