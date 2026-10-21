# Contributing

Thanks for helping improve ChessPilot.

## Development setup

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Run `npm run dev` and open the URL printed by Vite.

Before opening a pull request, run `npm test` and `npm run build`. Describe behavior changes and include browser details for screen capture or recognition issues. Do not include API keys, private screenshots, or personal game data in issues or pull requests.

## Changes involving bundled assets

Keep the Stockfish JavaScript and WebAssembly files matched. Preserve the notices in `public/engine/` and `public/models/`, and update `THIRD-PARTY-NOTICES.md` if a bundled third-party asset changes.
