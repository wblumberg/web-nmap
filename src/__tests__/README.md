# web-nmap Unit Tests

## Running the tests

```bash
# Run all tests once (good for CI / before committing)
npm test

# Run tests in watch mode — reruns automatically when you save a file
npm run test:watch

# Run tests with a coverage report (shows which lines are tested)
npm run test:coverage
```

## Test structure

```
src/__tests__/
├── README.md                      ← this file
├── TimeMatchingEngine.test.js     ← tests for time matching logic
├── LayerBuilder.test.js           ← tests for layer construction + namespacing
├── point.formatters.test.js       ← tests for station plot formatter functions
└── PanelManager.test.js           ← tests for multi-slot panel management
```

## What each file tests

| File | Module tested | Uses mocks? | Why |
|---|---|---|---|
| `TimeMatchingEngine.test.js` | `src/TimeMatchingEngine.js` | No | Pure functions, no dependencies |
| `LayerBuilder.test.js` | `src/LayerBuilder.js` | Yes — autumnplot-gl | No WebGL in Node.js |
| `point.formatters.test.js` | `src/products/point.js` | No | Pure formatter functions |
| `PanelManager.test.js` | `src/PanelManager.js` | Yes — everything | No WebGL, no network, no map |

## How mocking works

When a module imports `autumnplot-gl` or `maplibre-gl`, those libraries
need a real GPU and browser. In tests we substitute **mock objects** —
plain JavaScript that behaves the same way but doesn't need hardware.

`vi.mock('module-name', factory)` intercepts the `import` statement and
returns the factory's result instead of the real module.

## Adding new tests

1. Create a new file `src/__tests__/MyModule.test.js`
2. Import `describe`, `it`, `expect` from `vitest`
3. Write tests using the ARRANGE / ACT / ASSERT pattern
4. Run `npm run test:watch` to see results immediately
