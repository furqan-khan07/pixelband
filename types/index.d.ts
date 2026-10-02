// The reactive state pixelband keeps: `frame` counts animation frames in apps without `$.ui.blit`
// (the desktop app). The band reads it while drawing, so bumping it redraws the band alone, not the
// menu: a menu rebuilt on every frame can't be clicked.
declare module 'claude-code' {
  interface PluginState {
    pixelband: {
      frame: number
    }
  }
}
