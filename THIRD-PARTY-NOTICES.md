# Third-party notices

ChessPilot includes or redistributes the following third-party software and assets. Their licenses remain applicable to those components.

## Stockfish.js 19.0.1

The browser engine in `public/engine/` is the Lite, single-threaded WebAssembly build from [`stockfish` on npm](https://www.npmjs.com/package/stockfish), version 19.0.1. Stockfish.js is distributed under GPL-3.0. Its full license is included at [`public/engine/COPYING.stockfish.txt`](./public/engine/COPYING.stockfish.txt).

Corresponding source and build scripts are available from the [Stockfish.js source repository](https://github.com/nmrugg/stockfish.js), which contains the C++ engine source, Emscripten glue, and build tooling. The Stockfish 19 upstream source is identified by the Stockfish.js release notes as [`official-stockfish/Stockfish` commit `edb0d9d`](https://github.com/official-stockfish/Stockfish/tree/edb0d9d).

## Fenshot 0.1.5 and chess tile model

The local board recognizer and `public/models/chess-tiles-v2.onnx` model are from [`@scoriiu/fenshot`](https://github.com/scoriiu/fenshot), version 0.1.5, distributed under MIT. The MIT license text is included at [`public/models/LICENSE.fenshot.txt`](./public/models/LICENSE.fenshot.txt).

## Other packages

JavaScript dependencies are installed from the versions recorded in `package-lock.json`. Their individual license information is provided by their package metadata and is not replaced by ChessPilot's license.
