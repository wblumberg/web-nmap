/*
 
   This module implements a simple global state store for the application. It is not a full-fledged state management library, but it is sufficient for our needs.
   It is based on a single global state object, and provides functions to get and set the state, as well as to subscribe to changes in the state.
 
*/

const state = {
  sources: null,  // the catalog of available data, as returned by the backend
  grouped_products: null, 
  map: null, // the MapLibre GL map with a custom style and initial view settings referenced everywhere.

  selection: {
    categoryId: null,
    sourceId: null,
    productId: null,
    cycleTime: null,
    dominantLayerId: null,
    layers: [] // list of selected layers
  },

  times: {
    available: [],
    matched: []
  },

  ui: {
    dataSelectorOpen: false,
    productGenOpen: false,
    frozenMap: false,
    loading: false,
    error: null
  }
};

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  // very simple shallow merge; you can improve later
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}